import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildSmokePlan,
  runPackedCliSmoke,
  validateDoctorReport,
  validateHelpOutput,
} from "./smoke-packed-cli";
import type {
  CommandInvocation,
  CommandResult,
  PackAndVerifyOptions,
  VerifiedPackage,
} from "./verify-package";

const doctorReport = {
  checks: [
    {
      capability: "transcript",
      id: "bun",
      message: "Bun runtime is available (1.3.14)",
      remediation: null,
      status: "pass",
    },
    {
      capability: "transcript",
      id: "uv",
      message: "uv is not available",
      remediation: "Install uv.",
      status: "fail",
    },
    {
      capability: "transcript",
      id: "python-sidecar",
      message: "Python transcript sidecar exists",
      remediation: null,
      status: "pass",
    },
    {
      capability: "transcript",
      id: "python-runtime",
      message: "Managed Python runtime is missing",
      remediation: "Run setup.",
      status: "fail",
    },
    {
      capability: "digest",
      id: "opencode-api-key",
      message: "OPENCODE_API_KEY is missing",
      remediation: "Set OPENCODE_API_KEY.",
      status: "warn",
    },
    {
      capability: "transcript",
      id: "output-dir",
      message: "Output directory is writable or can be created",
      remediation: null,
      status: "pass",
    },
  ],
  ok: false,
  schemaVersion: "doctor-report.v0",
} as const;

const expectedHelp = [
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

function successfulOutput(invocation: CommandInvocation): CommandResult {
  if (invocation.args.includes("--version")) {
    return { exitCode: 0, stderr: "", stdout: "video-digest 0.1.0\n" };
  }
  if (invocation.args.includes("--help")) {
    return { exitCode: 0, stderr: "", stdout: expectedHelp };
  }
  if (invocation.args.includes("doctor")) {
    return { exitCode: 1, stderr: "", stdout: `${JSON.stringify(doctorReport)}\n` };
  }
  return { exitCode: 0, stderr: "", stdout: "installed\n" };
}

async function materializeFakeInstall(invocation: CommandInvocation): Promise<void> {
  const prefixIndex = invocation.args.indexOf("--prefix");
  const prefix = invocation.args[prefixIndex + 1]!;
  const packageRoot = join(prefix, "lib", "node_modules", "video-digest");
  const executable = join(packageRoot, "bin", "video-digest");
  const dependencyRoot = join(packageRoot, "node_modules", "@opentui", "core");
  await mkdir(dirname(executable), { recursive: true });
  await mkdir(dependencyRoot, { recursive: true });
  await mkdir(join(prefix, "bin"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      dependencies: { "@opentui/core": "0.4.1" },
      name: "video-digest",
      version: "0.1.0",
    }),
  );
  await writeFile(join(dependencyRoot, "package.json"), JSON.stringify({ name: "@opentui/core" }));
  await writeFile(executable, "#!/usr/bin/env bun\n");
  await chmod(executable, 0o755);
  await symlink("../lib/node_modules/video-digest/bin/video-digest", join(prefix, "bin", "video-digest"));
}

describe("packed CLI smoke plan", () => {
  test("executes the exact install and public probes from a separate work directory", () => {
    const plan = buildSmokePlan(
      "/tmp/video-digest.tgz",
      "/tmp/video-digest-prefix",
      "/tmp/video-digest-work",
    );

    expect(plan).toEqual({
      commands: [
        [
          "npm",
          "install",
          "--global",
          "--prefix",
          "/tmp/video-digest-prefix",
          "/tmp/video-digest.tgz",
        ],
        ["/tmp/video-digest-prefix/bin/video-digest", "--version"],
        ["/tmp/video-digest-prefix/bin/video-digest", "--help"],
        ["/tmp/video-digest-prefix/bin/video-digest", "doctor", "--json"],
      ],
      cwd: "/tmp/video-digest-work",
      executable: "/tmp/video-digest-prefix/bin/video-digest",
    });
  });

  test("rejects relative, overlapping, and repository-contained smoke locations", () => {
    expect(() => buildSmokePlan("relative.tgz", "/tmp/prefix", "/tmp/work")).toThrow(
      "Smoke paths must be absolute",
    );
    expect(() => buildSmokePlan("/tmp/archive.tgz", "/tmp/same", "/tmp/same")).toThrow(
      "Smoke prefix and work directory must be separate",
    );
  });
});

describe("doctor smoke contract", () => {
  test("accepts only the exact public doctor schema and complete check set", () => {
    expect(validateDoctorReport(doctorReport)).toEqual(doctorReport);
    expect(() => validateDoctorReport({ ...doctorReport, extra: true })).toThrow(
      "doctor returned an invalid JSON contract",
    );
    expect(() => validateDoctorReport({ ...doctorReport, schemaVersion: "doctor-report.v1" })).toThrow(
      "doctor returned an invalid JSON contract",
    );
    expect(() => validateDoctorReport({ ...doctorReport, checks: doctorReport.checks.slice(1) })).toThrow(
      "doctor returned an invalid JSON contract",
    );
  });
});

describe("help smoke contract", () => {
  test("requires the complete public help text and its final newline", () => {
    expect(() => validateHelpOutput(expectedHelp, "")).not.toThrow();
    expect(() => validateHelpOutput("Video Digest\n", "")).toThrow(
      "help probe returned unexpected output",
    );
    expect(() => validateHelpOutput(expectedHelp.slice(0, -1), "")).toThrow(
      "help probe returned unexpected output",
    );
    expect(() => validateHelpOutput(expectedHelp, "warning")).toThrow(
      "help probe returned unexpected output",
    );
  });
});

describe("isolated packed CLI smoke", () => {
  test("uses canonical paths when rejecting a smoke workspace inside the repository", async () => {
    const parent = await mkdtemp(join(tmpdir(), "video-digest-canonical-boundary-tests-"));
    const repositoryRoot = join(parent, "repository");
    const alias = join(parent, "repository-alias");
    await mkdir(repositoryRoot);
    await symlink(repositoryRoot, alias);
    let packCalled = false;
    try {
      await expect(
        runPackedCliSmoke({
          packPackage: async () => {
            packCalled = true;
            throw new Error("pack must not run");
          },
          repositoryRoot: alias,
          tempRoot: repositoryRoot,
        }),
      ).rejects.toThrow("Smoke workspace must be outside the repository");
      expect(packCalled).toBe(false);
      expect(await readdir(repositoryRoot)).toEqual([]);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("rejects a verified tarball that escapes its owned pack directory before install", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "video-digest-tarball-boundary-tests-"));
    const packRoot = await mkdtemp(join(tempRoot, "pack-"));
    const externalTarball = join(tempRoot, "outside.tgz");
    await writeFile(externalTarball, "fixture");
    let installCalled = false;
    let packCleaned = false;
    try {
      await expect(
        runPackedCliSmoke({
          packPackage: async () => ({
            cleanup: async () => {
              packCleaned = true;
              await rm(packRoot, { force: true, recursive: true });
            },
            tarballPath: externalTarball,
            temporaryDirectory: packRoot,
          }),
          runCommand: async () => {
            installCalled = true;
            return { exitCode: 0, stderr: "", stdout: "" };
          },
          tempRoot,
        }),
      ).rejects.toThrow("Verified tarball escaped its owned package directory");
      expect(installCalled).toBe(false);
      expect(packCleaned).toBe(true);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  test("rejects an installed package root that resolves outside the isolated prefix", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "video-digest-install-boundary-tests-"));
    const packRoot = await mkdtemp(join(tempRoot, "pack-"));
    const tarballPath = join(packRoot, "video-digest-0.1.0.tgz");
    const externalPackageRoot = join(tempRoot, "escaped-package");
    await writeFile(tarballPath, "fixture");
    let probes = 0;
    try {
      await expect(
        runPackedCliSmoke({
          packPackage: async () => ({
            cleanup: async () => rm(packRoot, { force: true, recursive: true }),
            tarballPath,
            temporaryDirectory: packRoot,
          }),
          runCommand: async (invocation) => {
            if (invocation.executable !== "npm") {
              probes += 1;
              return successfulOutput(invocation);
            }
            const prefix = invocation.args[invocation.args.indexOf("--prefix") + 1]!;
            const externalExecutable = join(externalPackageRoot, "bin", "video-digest");
            await mkdir(dirname(externalExecutable), { recursive: true });
            await mkdir(join(prefix, "lib", "node_modules"), { recursive: true });
            await mkdir(join(prefix, "bin"), { recursive: true });
            await writeFile(
              join(externalPackageRoot, "package.json"),
              JSON.stringify({
                dependencies: { "@opentui/core": "0.4.1" },
                name: "video-digest",
                version: "0.1.0",
              }),
            );
            await writeFile(externalExecutable, "#!/usr/bin/env bun\n", { mode: 0o755 });
            await chmod(externalExecutable, 0o755);
            await symlink(externalPackageRoot, join(prefix, "lib", "node_modules", "video-digest"));
            await symlink(
              "../lib/node_modules/video-digest/bin/video-digest",
              join(prefix, "bin", "video-digest"),
            );
            return { exitCode: 0, stderr: "", stdout: "installed\n" };
          },
          tempRoot,
        }),
      ).rejects.toThrow("Installed package escaped the isolated package prefix");
      expect(probes).toBe(0);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  test("packs, installs, and probes entirely outside the repository with a controlled environment", async () => {
    const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const tempRoot = await mkdtemp(join(tmpdir(), "video-digest-smoke-tests-"));
    const packRoot = await mkdtemp(join(tmpdir(), "video-digest-pack-fixture-"));
    const tarballPath = join(packRoot, "video-digest-0.1.0.tgz");
    const invocations: CommandInvocation[] = [];
    let packCleanupCount = 0;
    await writeFile(tarballPath, "fixture");
    await writeFile(join(tempRoot, "sentinel"), "keep");
    const packPackage = async (_options: PackAndVerifyOptions): Promise<VerifiedPackage> => ({
      cleanup: async () => {
        packCleanupCount += 1;
        await rm(packRoot, { force: true, recursive: true });
      },
      tarballPath,
      temporaryDirectory: packRoot,
    });
    const runCommand = async (invocation: CommandInvocation) => {
      invocations.push(invocation);
      if (invocation.executable === "npm") await materializeFakeInstall(invocation);
      return successfulOutput(invocation);
    };

    try {
      const result = await runPackedCliSmoke({
        packPackage,
        repositoryRoot,
        runCommand,
        tempRoot,
      });

      expect(result).toEqual({ packageName: "video-digest", version: "0.1.0" });
      expect(packCleanupCount).toBe(1);
      expect(invocations.map(({ executable, args }) => [executable, ...args])).toEqual([
        [
          "npm",
          "install",
          "--global",
          "--prefix",
          expect.stringContaining("/prefix"),
          tarballPath,
        ],
        [expect.stringContaining("/prefix/bin/video-digest"), "--version"],
        [expect.stringContaining("/prefix/bin/video-digest"), "--help"],
        [expect.stringContaining("/prefix/bin/video-digest"), "doctor", "--json"],
      ]);
      expect(invocations.every(({ cwd }) => !cwd.startsWith(repositoryRoot))).toBe(true);
      expect(invocations.every(({ env }) => env?.HOME?.startsWith(tempRoot))).toBe(true);
      expect(invocations.every(({ env }) => env?.XDG_CONFIG_HOME?.startsWith(tempRoot))).toBe(true);
      expect(invocations.every(({ env }) => env?.TMPDIR?.startsWith(tempRoot))).toBe(true);
      expect(invocations.every(({ env }) => !("OPENCODE_API_KEY" in (env ?? {})))).toBe(true);
      expect(invocations[0]!.env?.npm_config_ignore_scripts).toBe("true");
      expect(invocations[0]!.env?.npm_config_audit).toBe("false");
      expect(invocations[1]!.env?.npm_config_ignore_scripts).toBeUndefined();
      expect(invocations.map(({ timeoutMs }) => timeoutMs)).toEqual([120_000, 15_000, 15_000, 30_000]);
      expect(invocations.every(({ maxOutputBytes }) => maxOutputBytes === 2 * 1024 * 1024)).toBe(true);
      expect(await readFile(join(tempRoot, "sentinel"), "utf8")).toBe("keep");
      expect(await Bun.file(dirname(invocations[0]!.cwd)).exists()).toBe(false);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
      await rm(packRoot, { force: true, recursive: true });
    }
  });

  test("sanitizes command failures and cleans both owned temporary trees", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "video-digest-smoke-failure-tests-"));
    await writeFile(join(tempRoot, "sentinel"), "keep");
    const packRoot = await mkdtemp(join(tmpdir(), "video-digest-pack-failure-fixture-"));
    const tarballPath = join(packRoot, "video-digest-0.1.0.tgz");
    await writeFile(tarballPath, "fixture");
    let packCleaned = false;
    let smokeRoot = "";
    const packPackage = async (): Promise<VerifiedPackage> => ({
      cleanup: async () => {
        packCleaned = true;
        await rm(packRoot, { force: true, recursive: true });
      },
      tarballPath,
      temporaryDirectory: packRoot,
    });
    const secret = "npm_token=must-not-leak";
    const runCommand = async (invocation: CommandInvocation): Promise<CommandResult> => {
      smokeRoot = dirname(invocation.cwd);
      return { exitCode: 17, stderr: secret, stdout: secret };
    };

    try {
      await expect(
        runPackedCliSmoke({ packPackage, runCommand, tempRoot }),
      ).rejects.toThrow("npm install failed with exit code 17");
      try {
        await runPackedCliSmoke({ packPackage, runCommand, tempRoot });
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
      expect(packCleaned).toBe(true);
      expect(await Bun.file(smokeRoot).exists()).toBe(false);
      expect(await readFile(join(tempRoot, "sentinel"), "utf8")).toBe("keep");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
      await rm(packRoot, { force: true, recursive: true });
    }
  });
});

function fileURLToPath(url: URL): string {
  return Bun.fileURLToPath(url);
}
