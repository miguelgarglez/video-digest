import { constants, readFileSync, type Stats } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_DOCTOR_CHECK_CAPABILITY,
  PUBLIC_DOCTOR_CHECK_IDS,
  PUBLIC_CLI_SCHEMA,
} from "../src/cli/public-contract";
import {
  createOwnedDirectoryCleanup,
  packAndVerifyPackage,
  runBoundedProcess,
  type CommandInvocation,
  type CommandResult,
  type CommandRunner,
  type PackAndVerifyOptions,
  type VerifiedPackage,
} from "./verify-package";

const PACKAGE_NAME = "video-digest";
const packageJsonPath = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  name?: string;
  version?: string;
};
const PACKAGE_VERSION =
  packageJson.name === PACKAGE_NAME && typeof packageJson.version === "string"
    ? packageJson.version
    : (() => {
        throw new Error("package.json does not declare the video-digest package version");
      })();
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;
const DOCTOR_TIMEOUT_MS = 30_000;

const EXPECTED_HELP = [
  "Video Digest",
  "",
  "Usage:",
  "  video-digest ingest <youtube-url> [--email-preview] [--json] [--output-dir <path>]",
  "  video-digest transcript <youtube-url> [--json] [--output-dir <path>]",
  "  video-digest config <get|set|unset> [opencode-api-key] [--json]",
  "  video-digest config set output-dir <path> [--json]",
  "  video-digest doctor [--json]",
  "  video-digest setup [--yes] [--json]",
  "  video-digest list [--json] [--output-dir <path>]",
  "  video-digest open <latest|video-id> [--json] [--output-dir <path>]",
  "",
  "Compatibility:",
  "  bun run video-digest <youtube-url> [--email-preview]",
  "  bun run video-digest",
  "  bun run video-digest --help",
  "",
  "Options:",
  "  --email-preview  Also write a Markdown email preview under <Artifact Library>/emails/.",
  "  --copy           Copy clean transcript text after writing artifacts.",
  "  --open           Open the transcript Markdown after writing artifacts.",
  "  --stdout         Emit only clean transcript text to stdout.",
  "  --json           Write one machine-readable JSON object.",
  "  --yes            Confirm setup without an interactive prompt.",
  "  --output-dir     Override the Artifact Library for this command.",
  "  --help, -h       Show this help message.",
  "",
  "Interactive mode:",
  "  Run without arguments in a terminal to open the guided interface.",
  "",
  "Environment:",
  "  OPENCODE_API_KEY      Required for digest generation with ingest.",
  "  OPENCODE_MODEL        Defaults to gpt-5.4-nano via .env.example.",
  "  VIDEO_DIGEST_OUTPUT_DIR  Overrides the configured Artifact Library.",
  "",
  "Transcript mode:",
  "  video-digest transcript <youtube-url> does not require OPENCODE_API_KEY.",
  "",
  "Configuration:",
  "  video-digest config set opencode-api-key stores the key in macOS Keychain.",
  "",
].join("\n");

export interface SmokePlan {
  commands: string[][];
  cwd: string;
  executable: string;
}

export interface PackedCliSmokeOptions {
  repositoryRoot?: string;
  tempRoot?: string;
  packPackage?: (options: PackAndVerifyOptions) => Promise<VerifiedPackage>;
  runCommand?: CommandRunner;
  removeDirectory?: (path: string) => Promise<void>;
  createTemporaryDirectory?: (prefix: string) => Promise<string>;
}

export interface PackedCliSmokeResult {
  packageName: typeof PACKAGE_NAME;
  version: typeof PACKAGE_VERSION;
}

function isWithin(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function requireSeparatePaths(prefix: string, cwd: string): void {
  if (isWithin(prefix, cwd) || isWithin(cwd, prefix)) {
    throw new Error("Smoke prefix and work directory must be separate");
  }
}

export function buildSmokePlan(tarball: string, prefix: string, cwd: string): SmokePlan {
  if (![tarball, prefix, cwd].every(isAbsolute)) {
    throw new Error("Smoke paths must be absolute");
  }
  requireSeparatePaths(prefix, cwd);
  const executable = join(prefix, "bin", PACKAGE_NAME);
  return {
    commands: [
      ["npm", "install", "--global", "--prefix", prefix, tarball],
      [executable, "--version"],
      [executable, "--help"],
      [executable, "doctor", "--json"],
    ],
    cwd,
    executable,
  };
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}

function invalidDoctorContract(): never {
  throw new Error("doctor returned an invalid JSON contract");
}

export function validateDoctorReport(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, ["checks", "ok", "schemaVersion"])
  ) {
    return invalidDoctorContract();
  }
  const report = value as Record<string, unknown>;
  if (
    report.schemaVersion !== PUBLIC_CLI_SCHEMA.doctorReport ||
    typeof report.ok !== "boolean" ||
    !Array.isArray(report.checks) ||
    report.checks.length !== PUBLIC_DOCTOR_CHECK_IDS.length
  ) {
    return invalidDoctorContract();
  }

  let containsFailure = false;
  for (const [index, expectedId] of PUBLIC_DOCTOR_CHECK_IDS.entries()) {
    const check = report.checks[index];
    if (
      typeof check !== "object" ||
      check === null ||
      Array.isArray(check) ||
      !hasExactKeys(check as Record<string, unknown>, [
        "capability",
        "id",
        "message",
        "remediation",
        "status",
      ])
    ) {
      return invalidDoctorContract();
    }
    const record = check as Record<string, unknown>;
    if (
      record.id !== expectedId ||
      record.capability !== PUBLIC_DOCTOR_CHECK_CAPABILITY[expectedId] ||
      typeof record.message !== "string" ||
      record.message.length === 0 ||
      (record.remediation !== null &&
        (typeof record.remediation !== "string" || record.remediation.length === 0)) ||
      !["pass", "warn", "fail"].includes(record.status as string)
    ) {
      return invalidDoctorContract();
    }
    if (record.status === "fail") containsFailure = true;
  }
  if (report.ok !== !containsFailure) return invalidDoctorContract();
  return report;
}

const EXPECTED_ISOLATED_DOCTOR_CHECKS = [
  {
    capability: "transcript",
    id: "bun",
    message: /^Bun runtime is available \(.+\)$/,
    remediation: null,
    status: "pass",
  },
  {
    capability: "transcript",
    id: "uv",
    message: /^uv is not available$/,
    remediation: "Install uv, source $HOME/.local/bin/env, or set UV_BIN.",
    status: "fail",
  },
  {
    capability: "transcript",
    id: "python-sidecar",
    message: /^Python transcript sidecar exists$/,
    remediation: null,
    status: "pass",
  },
  {
    capability: "transcript",
    id: "python-runtime",
    message: /^Managed Python runtime is missing$/,
    remediation: "Run video-digest setup.",
    status: "fail",
  },
  {
    capability: "digest",
    id: "opencode-api-key",
    message: /^OPENCODE_API_KEY is missing; digest generation is unavailable$/,
    remediation:
      "Set OPENCODE_API_KEY to enable video-digest ingest. Transcript mode works without it.",
    status: "warn",
  },
  {
    capability: "transcript",
    id: "output-dir",
    message: /^Output directory is writable or can be created$/,
    remediation: null,
    status: "pass",
  },
] as const;

export function validateIsolatedDoctorReport(value: unknown): Record<string, unknown> {
  const report = validateDoctorReport(value);
  if (report.ok !== false || !Array.isArray(report.checks)) {
    throw new Error("doctor did not prove an isolated environment");
  }
  for (const [index, expected] of EXPECTED_ISOLATED_DOCTOR_CHECKS.entries()) {
    const check = report.checks[index] as Record<string, unknown>;
    if (
      check.id !== expected.id ||
      check.capability !== expected.capability ||
      check.status !== expected.status ||
      check.remediation !== expected.remediation ||
      typeof check.message !== "string" ||
      !expected.message.test(check.message)
    ) {
      throw new Error("doctor did not prove an isolated environment");
    }
  }
  return report;
}

export function validateHelpOutput(stdout: string, stderr: string): void {
  if (stdout !== EXPECTED_HELP || stderr !== "") {
    throw new Error("help probe returned unexpected output");
  }
}

function controlledPath(shimDirectory: string): string {
  const directories = [
    shimDirectory,
    dirname(process.execPath),
    dirname(Bun.which("npm") ?? "/usr/bin/npm"),
    "/usr/bin",
    "/bin",
  ];
  return [...new Set(directories)].join(":");
}

export interface ShimInvocationMarkers {
  security: string;
  uv: string;
}

export async function createNoExternalAccessShims(
  directory: string,
  markerDirectory: string,
): Promise<ShimInvocationMarkers> {
  await mkdir(directory, { recursive: true });
  for (const command of ["security", "uv"]) {
    const path = join(directory, command);
    const marker = join(markerDirectory, `${command}-invocations.jsonl`);
    const source = [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: Bun.argv.slice(2), command: ${JSON.stringify(command)} }) + "\\n", { encoding: "utf8", mode: 0o600 });`,
      "process.exit(44);",
      "",
    ].join("\n");
    await writeFile(path, source, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  return {
    security: join(markerDirectory, "security-invocations.jsonl"),
    uv: join(markerDirectory, "uv-invocations.jsonl"),
  };
}

async function readExactShimInvocation(
  marker: string,
  expected: { argv: string[]; command: string },
): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(marker, "utf8");
  } catch {
    throw new Error(`doctor did not invoke the isolated ${expected.command} shim`);
  }
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1) {
    throw new Error(`doctor invoked the isolated ${expected.command} shim unexpectedly`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]!);
  } catch {
    throw new Error(`doctor wrote an invalid ${expected.command} shim invocation`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !hasExactKeys(parsed as Record<string, unknown>, ["argv", "command"]) ||
    (parsed as Record<string, unknown>).command !== expected.command ||
    JSON.stringify((parsed as Record<string, unknown>).argv) !== JSON.stringify(expected.argv)
  ) {
    throw new Error(`doctor invoked the isolated ${expected.command} shim unexpectedly`);
  }
}

async function validateDoctorShimInvocations(markers: ShimInvocationMarkers): Promise<void> {
  await readExactShimInvocation(markers.security, {
    argv: [
      "find-generic-password",
      "-a",
      "opencode-api-key",
      "-s",
      "video-digest",
      "-w",
    ],
    command: "security",
  });
  await readExactShimInvocation(markers.uv, { argv: ["--version"], command: "uv" });
}

function createSmokeEnvironment(root: string, shimDirectory: string): Record<string, string> {
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  return {
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    PATH: controlledPath(shimDirectory),
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    VIDEO_DIGEST_OUTPUT_DIR: join(root, "artifacts"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
  };
}

function installEnvironment(base: Record<string, string>, root: string): Record<string, string> {
  return {
    ...base,
    npm_config_audit: "false",
    npm_config_cache: join(root, "npm-cache"),
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
  };
}

async function invoke(
  label: string,
  runner: CommandRunner,
  invocation: CommandInvocation,
  allowedExitCodes: readonly number[] = [0],
): Promise<CommandResult> {
  let result: CommandResult;
  try {
    result = await runner(invocation);
  } catch (error) {
    if (error instanceof Error && error.message === "Command timed out") {
      throw new Error(`${label} timed out`);
    }
    if (error instanceof Error && error.message === "Command output exceeded limit") {
      throw new Error(`${label} output exceeded limit`);
    }
    throw new Error(`${label} could not be executed`);
  }
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > invocation.maxOutputBytes) {
    throw new Error(`${label} output exceeded limit`);
  }
  if (!allowedExitCodes.includes(result.exitCode)) {
    throw new Error(`${label} failed with exit code ${result.exitCode}`);
  }
  return result;
}

async function assertInstalledClosure(
  executable: string,
  prefix: string,
  repositoryRoot: string,
): Promise<void> {
  await access(executable, constants.X_OK);
  const packageRoot = join(prefix, "lib", "node_modules", PACKAGE_NAME);
  const [resolvedExecutable, resolvedPackageRoot, resolvedRepositoryRoot, resolvedPrefix] =
    await Promise.all([
      realpath(executable),
      realpath(packageRoot),
      realpath(repositoryRoot),
      realpath(prefix),
    ]);
  if (
    !isWithin(resolvedPrefix, resolvedPackageRoot) ||
    isWithin(resolvedRepositoryRoot, resolvedPackageRoot) ||
    !isWithin(resolvedPrefix, resolvedExecutable) ||
    !isWithin(resolvedPackageRoot, resolvedExecutable) ||
    isWithin(resolvedRepositoryRoot, resolvedExecutable)
  ) {
    throw new Error("Installed package escaped the isolated package prefix");
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  } catch {
    throw new Error("Installed package metadata is unavailable");
  }
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("Installed package metadata is invalid");
  }
  const pkg = metadata as Record<string, unknown>;
  if (pkg.name !== PACKAGE_NAME || pkg.version !== PACKAGE_VERSION) {
    throw new Error("Installed package identity is invalid");
  }
  if (typeof pkg.dependencies !== "object" || pkg.dependencies === null || Array.isArray(pkg.dependencies)) {
    throw new Error("Installed package dependency contract is invalid");
  }
  const dependencyNames = Object.keys(pkg.dependencies as Record<string, unknown>);
  if (dependencyNames.length === 0) {
    throw new Error("Installed package dependency closure is empty");
  }
  for (const dependency of dependencyNames) {
    const manifest = join(packageRoot, "node_modules", dependency, "package.json");
    let dependencyRoot: string;
    let dependencyMetadata: unknown;
    try {
      dependencyRoot = await realpath(dirname(manifest));
      dependencyMetadata = JSON.parse(await readFile(manifest, "utf8"));
    } catch {
      throw new Error(`Installed dependency is unavailable: ${dependency}`);
    }
    if (
      !isWithin(resolvedPrefix, dependencyRoot) ||
      isWithin(resolvedRepositoryRoot, dependencyRoot)
    ) {
      throw new Error(`Installed dependency escaped the isolated package prefix: ${dependency}`);
    }
    if (
      typeof dependencyMetadata !== "object" ||
      dependencyMetadata === null ||
      Array.isArray(dependencyMetadata) ||
      (dependencyMetadata as Record<string, unknown>).name !== dependency
    ) {
      throw new Error(`Installed dependency identity is invalid: ${dependency}`);
    }
  }
}

async function assertVerifiedPackageBoundary(
  verifiedPackage: VerifiedPackage,
  repositoryRoot: string,
): Promise<void> {
  let packageDirectoryMetadata: Awaited<ReturnType<typeof lstat>>;
  let tarballMetadata: Awaited<ReturnType<typeof lstat>>;
  let canonicalPackageDirectory: string;
  let canonicalTarball: string;
  let canonicalRepositoryRoot: string;
  try {
    [
      packageDirectoryMetadata,
      tarballMetadata,
      canonicalPackageDirectory,
      canonicalTarball,
      canonicalRepositoryRoot,
    ] = await Promise.all([
      lstat(verifiedPackage.temporaryDirectory),
      lstat(verifiedPackage.tarballPath),
      realpath(verifiedPackage.temporaryDirectory),
      realpath(verifiedPackage.tarballPath),
      realpath(repositoryRoot),
    ]);
  } catch {
    throw new Error("Verified package boundary is unavailable");
  }
  if (!packageDirectoryMetadata.isDirectory() || packageDirectoryMetadata.isSymbolicLink()) {
    throw new Error("Verified package directory is invalid");
  }
  if (!tarballMetadata.isFile() || tarballMetadata.isSymbolicLink()) {
    throw new Error("Verified tarball is not a regular file");
  }
  if (
    !isWithin(canonicalPackageDirectory, canonicalTarball) ||
    isWithin(canonicalRepositoryRoot, canonicalPackageDirectory) ||
    isWithin(canonicalRepositoryRoot, canonicalTarball)
  ) {
    throw new Error("Verified tarball escaped its owned package directory");
  }
}

interface SmokeBoundary {
  canonicalRepositoryRoot: string;
  canonicalTemporaryParent: string;
  repositoryIdentity: { dev: number; ino: number };
  temporaryParentIdentity: { dev: number; ino: number };
}

function filesystemIdentity(metadata: Stats): { dev: number; ino: number } {
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function preflightSmokeBoundary(
  repositoryRoot: string,
  temporaryParent: string,
): Promise<SmokeBoundary> {
  let canonicalRepositoryRoot: string;
  let canonicalTemporaryParent: string;
  let repositoryMetadata: Stats;
  let temporaryParentMetadata: Stats;
  try {
    [canonicalRepositoryRoot, canonicalTemporaryParent] = await Promise.all([
      realpath(repositoryRoot),
      realpath(temporaryParent),
    ]);
    [repositoryMetadata, temporaryParentMetadata] = await Promise.all([
      stat(canonicalRepositoryRoot),
      stat(canonicalTemporaryParent),
    ]);
  } catch {
    throw new Error("Smoke boundary is unavailable");
  }
  if (!repositoryMetadata.isDirectory() || !temporaryParentMetadata.isDirectory()) {
    throw new Error("Smoke boundary must use existing directories");
  }
  if (isWithin(canonicalRepositoryRoot, canonicalTemporaryParent)) {
    throw new Error("Smoke temporary parent must be outside the repository");
  }
  return {
    canonicalRepositoryRoot,
    canonicalTemporaryParent,
    repositoryIdentity: filesystemIdentity(repositoryMetadata),
    temporaryParentIdentity: filesystemIdentity(temporaryParentMetadata),
  };
}

async function revalidateSmokeRoot(smokeRoot: string, boundary: SmokeBoundary): Promise<void> {
  let smokeMetadata: Awaited<ReturnType<typeof lstat>>;
  let canonicalSmokeRoot: string;
  let canonicalRepositoryRoot: string;
  let canonicalTemporaryParent: string;
  let repositoryMetadata: Stats;
  let temporaryParentMetadata: Stats;
  try {
    [smokeMetadata, canonicalSmokeRoot, canonicalRepositoryRoot, canonicalTemporaryParent] =
      await Promise.all([
        lstat(smokeRoot),
        realpath(smokeRoot),
        realpath(boundary.canonicalRepositoryRoot),
        realpath(boundary.canonicalTemporaryParent),
      ]);
    [repositoryMetadata, temporaryParentMetadata] = await Promise.all([
      stat(canonicalRepositoryRoot),
      stat(canonicalTemporaryParent),
    ]);
  } catch {
    throw new Error("Smoke workspace boundary changed during allocation");
  }
  if (
    !smokeMetadata.isDirectory() ||
    smokeMetadata.isSymbolicLink() ||
    canonicalRepositoryRoot !== boundary.canonicalRepositoryRoot ||
    canonicalTemporaryParent !== boundary.canonicalTemporaryParent ||
    !sameIdentity(filesystemIdentity(repositoryMetadata), boundary.repositoryIdentity) ||
    !sameIdentity(filesystemIdentity(temporaryParentMetadata), boundary.temporaryParentIdentity) ||
    !isWithin(canonicalTemporaryParent, canonicalSmokeRoot) ||
    isWithin(canonicalRepositoryRoot, canonicalSmokeRoot)
  ) {
    throw new Error("Smoke workspace boundary changed during allocation");
  }
}

export async function runPackedCliSmoke(
  options: PackedCliSmokeOptions = {},
): Promise<PackedCliSmokeResult> {
  const repositoryRoot = resolve(
    options.repositoryRoot ?? fileURLToPath(new URL("..", import.meta.url)),
  );
  const temporaryParent = resolve(options.tempRoot ?? tmpdir());
  const boundary = await preflightSmokeBoundary(repositoryRoot, temporaryParent);
  const createTemporaryDirectory = options.createTemporaryDirectory ?? mkdtemp;
  const allocationPrefix = join(boundary.canonicalTemporaryParent, "video-digest-smoke-");
  const smokeRoot = await createTemporaryDirectory(allocationPrefix);
  if (
    !isAbsolute(smokeRoot) ||
    dirname(smokeRoot) !== boundary.canonicalTemporaryParent ||
    !basename(smokeRoot).startsWith(basename(allocationPrefix)) ||
    smokeRoot.length <= allocationPrefix.length
  ) {
    throw new Error("Smoke allocator returned an unsafe path");
  }
  const cleanupSmoke = createOwnedDirectoryCleanup(
    smokeRoot,
    options.removeDirectory ?? ((path) => rm(path, { force: true, recursive: true })),
  );
  let verifiedPackage: VerifiedPackage | undefined;
  let failure: unknown;
  let completed: PackedCliSmokeResult | undefined;

  try {
    await revalidateSmokeRoot(smokeRoot, boundary);
    const prefix = join(smokeRoot, "prefix");
    const cwd = join(smokeRoot, "work");
    const home = join(smokeRoot, "home");
    const temporary = join(smokeRoot, "tmp");
    const shims = join(smokeRoot, "shims");
    await Promise.all([
      mkdir(prefix, { recursive: true }),
      mkdir(cwd, { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(temporary, { recursive: true }),
    ]);
    const shimMarkers = await createNoExternalAccessShims(shims, smokeRoot);

    const packPackage = options.packPackage ?? packAndVerifyPackage;
    verifiedPackage = await packPackage({
      repositoryRoot: boundary.canonicalRepositoryRoot,
      tempRoot: boundary.canonicalTemporaryParent,
    });
    await assertVerifiedPackageBoundary(verifiedPackage, boundary.canonicalRepositoryRoot);
    const plan = buildSmokePlan(verifiedPackage.tarballPath, prefix, cwd);
    const runner = options.runCommand ?? runBoundedProcess;
    const environment = createSmokeEnvironment(smokeRoot, shims);
    const commands = plan.commands;
    const install = commands[0]!;
    const version = commands[1]!;
    const help = commands[2]!;
    const doctor = commands[3]!;

    await invoke("npm install", runner, {
      args: install.slice(1),
      cwd: plan.cwd,
      env: installEnvironment(environment, smokeRoot),
      executable: install[0]!,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    await assertInstalledClosure(plan.executable, prefix, boundary.canonicalRepositoryRoot);

    const versionResult = await invoke("version probe", runner, {
      args: version.slice(1),
      cwd: plan.cwd,
      env: environment,
      executable: version[0]!,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (versionResult.stdout !== `${PACKAGE_NAME} ${PACKAGE_VERSION}\n` || versionResult.stderr !== "") {
      throw new Error("version probe returned unexpected output");
    }

    const helpResult = await invoke("help probe", runner, {
      args: help.slice(1),
      cwd: plan.cwd,
      env: environment,
      executable: help[0]!,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    validateHelpOutput(helpResult.stdout, helpResult.stderr);

    const doctorResult = await invoke(
      "doctor probe",
      runner,
      {
        args: doctor.slice(1),
        cwd: plan.cwd,
        env: environment,
        executable: doctor[0]!,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        timeoutMs: DOCTOR_TIMEOUT_MS,
      },
      [0, 1],
    );
    if (doctorResult.stderr !== "") throw new Error("doctor probe returned unexpected output");
    let parsedDoctor: unknown;
    try {
      parsedDoctor = JSON.parse(doctorResult.stdout);
    } catch {
      throw new Error("doctor returned invalid JSON");
    }
    const validatedDoctor = validateIsolatedDoctorReport(parsedDoctor);
    if ((doctorResult.exitCode === 0) !== (validatedDoctor.ok === true)) {
      throw new Error("doctor exit code contradicted its JSON report");
    }
    await validateDoctorShimInvocations(shimMarkers);
    completed = { packageName: PACKAGE_NAME, version: PACKAGE_VERSION };
  } catch (error) {
    failure = error;
  }

  let cleanupFailed = false;
  try {
    await cleanupSmoke();
  } catch {
    cleanupFailed = true;
  }
  if (verifiedPackage) {
    try {
      await verifiedPackage.cleanup();
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    throw new Error(
      failure
        ? "Packed CLI smoke failed and temporary cleanup failed"
        : "Packed CLI temporary cleanup failed",
    );
  }
  if (failure) throw failure;
  if (!completed) throw new Error("Packed CLI smoke did not complete");
  return completed;
}

if (import.meta.main) {
  try {
    const result = await runPackedCliSmoke();
    console.log(`${result.packageName} ${result.version} packed CLI smoke passed`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Packed CLI smoke failed");
    process.exitCode = 1;
  }
}
