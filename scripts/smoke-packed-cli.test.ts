import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildSmokePlan,
  createNoExternalAccessShims,
  runPackedCliSmoke,
  validateDoctorReport,
  validateHelpOutput,
  validateIsolatedDoctorReport,
} from "./smoke-packed-cli";
import { runBoundedProcess } from "./verify-package";
import type {
  CommandInvocation,
  CommandResult,
  PackAndVerifyOptions,
  VerifiedPackage,
} from "./verify-package";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const PACKAGE_NAME = "video-digest";
const PACKAGE_VERSION = packageJson.version;
const TARBALL_FILENAME = `${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`;

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
      remediation: "Install uv, source $HOME/.local/bin/env, or set UV_BIN.",
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
      remediation: "Run video-digest setup.",
      status: "fail",
    },
    {
      capability: "digest",
      id: "opencode-api-key",
      message: "OPENCODE_API_KEY is missing; digest generation is unavailable",
      remediation: "Set OPENCODE_API_KEY to enable video-digest ingest. Transcript mode works without it.",
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
    return { exitCode: 0, stderr: "", stdout: `${PACKAGE_NAME} ${PACKAGE_VERSION}\n` };
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
      version: PACKAGE_VERSION,
    }),
  );
  await writeFile(join(dependencyRoot, "package.json"), JSON.stringify({ name: "@opentui/core" }));
  await writeFile(executable, "#!/usr/bin/env bun\n");
  await chmod(executable, 0o755);
  await symlink("../lib/node_modules/video-digest/bin/video-digest", join(prefix, "bin", "video-digest"));
}

async function materializeFakeDoctorShimMarkers(invocation: CommandInvocation): Promise<void> {
  const root = dirname(invocation.cwd);
  await writeFile(
    join(root, "security-invocations.jsonl"),
    `${JSON.stringify({
      argv: [
        "find-generic-password",
        "-a",
        "opencode-api-key",
        "-s",
        "video-digest",
        "-w",
      ],
      command: "security",
    })}\n`,
  );
  await writeFile(
    join(root, "uv-invocations.jsonl"),
    `${JSON.stringify({ argv: ["--version"], command: "uv" })}\n`,
  );
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

  test("requires the exact isolated missing-runtime and missing-credential outcome", () => {
    expect(() => validateIsolatedDoctorReport(doctorReport)).not.toThrow();
    const configured = structuredClone(doctorReport) as unknown as {
      checks: Array<Record<string, unknown>>;
      ok: boolean;
      schemaVersion: string;
    };
    configured.checks[4] = {
      ...configured.checks[4],
      message: "OPENCODE_API_KEY is configured via Keychain; digest generation is available",
      remediation: null,
      status: "pass",
    };
    expect(() => validateIsolatedDoctorReport(configured)).toThrow(
      "doctor did not prove an isolated environment",
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
  test("rejects a canonical temp parent inside the repository before any mutation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "video-digest-canonical-boundary-tests-"));
    const repositoryRoot = join(parent, "repository");
    const alias = join(parent, "repository-alias");
    await mkdir(repositoryRoot);
    await symlink(repositoryRoot, alias);
    let packCalled = false;
    let temporaryDirectoryCalled = false;
    let removeCalled = false;
    try {
      await expect(
        runPackedCliSmoke({
          packPackage: async () => {
            packCalled = true;
            throw new Error("pack must not run");
          },
          createTemporaryDirectory: async () => {
            temporaryDirectoryCalled = true;
            throw new Error("temporary directory must not be created");
          },
          removeDirectory: async () => {
            removeCalled = true;
          },
          repositoryRoot,
          tempRoot: alias,
        }),
      ).rejects.toThrow("Smoke temporary parent must be outside the repository");
      expect(packCalled).toBe(false);
      expect(temporaryDirectoryCalled).toBe(false);
      expect(removeCalled).toBe(false);
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

  test("cleans a rejected post-allocation symlink without touching its target", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "video-digest-post-allocation-tests-"));
    const victim = await mkdtemp(join(tmpdir(), "video-digest-post-allocation-victim-"));
    const sentinel = join(victim, "sentinel");
    let allocatedPath = "";
    let packCalled = false;
    await writeFile(sentinel, "keep");
    try {
      await expect(
        runPackedCliSmoke({
          createTemporaryDirectory: async (prefix) => {
            allocatedPath = `${prefix}injected`;
            await symlink(victim, allocatedPath);
            return allocatedPath;
          },
          packPackage: async () => {
            packCalled = true;
            throw new Error("pack must not run");
          },
          tempRoot,
        }),
      ).rejects.toThrow("Smoke workspace boundary changed during allocation");
      expect(packCalled).toBe(false);
      expect(await Bun.file(allocatedPath).exists()).toBe(false);
      expect(await readFile(sentinel, "utf8")).toBe("keep");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
      await rm(victim, { force: true, recursive: true });
    }
  });

  test("never cleans a path outside the allocation prefix returned by an invalid allocator", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "video-digest-invalid-allocator-tests-"));
    const victim = await mkdtemp(join(tmpdir(), "video-digest-invalid-allocator-victim-"));
    const sentinel = join(victim, "sentinel");
    let removeCalled = false;
    await writeFile(sentinel, "keep");
    try {
      await expect(
        runPackedCliSmoke({
          createTemporaryDirectory: async () => victim,
          removeDirectory: async () => {
            removeCalled = true;
          },
          tempRoot,
        }),
      ).rejects.toThrow("Smoke allocator returned an unsafe path");
      expect(removeCalled).toBe(false);
      expect(await readFile(sentinel, "utf8")).toBe("keep");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
      await rm(victim, { force: true, recursive: true });
    }
  });

  test("rejects an installed package root that resolves outside the isolated prefix", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "video-digest-install-boundary-tests-"));
    const packRoot = await mkdtemp(join(tempRoot, "pack-"));
    const tarballPath = join(packRoot, TARBALL_FILENAME);
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
                version: PACKAGE_VERSION,
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
    const tarballPath = join(packRoot, TARBALL_FILENAME);
    const invocations: CommandInvocation[] = [];
    let packCleanupCount = 0;
    let observedPackOptions: PackAndVerifyOptions | undefined;
    await writeFile(tarballPath, "fixture");
    await writeFile(join(tempRoot, "sentinel"), "keep");
    const packPackage = async (options: PackAndVerifyOptions): Promise<VerifiedPackage> => {
      observedPackOptions = options;
      return {
        cleanup: async () => {
          packCleanupCount += 1;
          await rm(packRoot, { force: true, recursive: true });
        },
        tarballPath,
        temporaryDirectory: packRoot,
      };
    };
    const runCommand = async (invocation: CommandInvocation) => {
      invocations.push(invocation);
      if (invocation.executable === "npm") await materializeFakeInstall(invocation);
      if (invocation.args.includes("doctor")) await materializeFakeDoctorShimMarkers(invocation);
      return successfulOutput(invocation);
    };

    try {
      const result = await runPackedCliSmoke({
        packPackage,
        repositoryRoot,
        runCommand,
        tempRoot,
      });
      const canonicalTempRoot = await realpath(tempRoot);
      const canonicalRepositoryRoot = await realpath(repositoryRoot);

      expect(result).toEqual({ packageName: PACKAGE_NAME, version: PACKAGE_VERSION });
      expect(observedPackOptions).toMatchObject({
        repositoryRoot: canonicalRepositoryRoot,
        tempRoot: canonicalTempRoot,
      });
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
      expect(invocations.every(({ env }) => env?.HOME?.startsWith(canonicalTempRoot))).toBe(true);
      expect(invocations.every(({ env }) => env?.XDG_CONFIG_HOME?.startsWith(canonicalTempRoot))).toBe(true);
      expect(invocations.every(({ env }) => env?.TMPDIR?.startsWith(canonicalTempRoot))).toBe(true);
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

  test("fails when doctor bypasses the owned security and uv shims", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "video-digest-missing-shim-marker-tests-"));
    const packRoot = await mkdtemp(join(tmpdir(), "video-digest-missing-shim-pack-"));
    const tarballPath = join(packRoot, TARBALL_FILENAME);
    await writeFile(tarballPath, "fixture");
    try {
      await expect(
        runPackedCliSmoke({
          packPackage: async () => ({
            cleanup: async () => rm(packRoot, { force: true, recursive: true }),
            tarballPath,
            temporaryDirectory: packRoot,
          }),
          runCommand: async (invocation) => {
            if (invocation.executable === "npm") await materializeFakeInstall(invocation);
            return successfulOutput(invocation);
          },
          tempRoot,
        }),
      ).rejects.toThrow("doctor did not invoke the isolated security shim");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
      await rm(packRoot, { force: true, recursive: true });
    }
  });

  test("sanitizes command failures and cleans both owned temporary trees", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "video-digest-smoke-failure-tests-"));
    await writeFile(join(tempRoot, "sentinel"), "keep");
    const packRoot = await mkdtemp(join(tmpdir(), "video-digest-pack-failure-fixture-"));
    const tarballPath = join(packRoot, TARBALL_FILENAME);
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

describe("owned command shims", () => {
  test("record exact argv safely under hostile path and argument spelling", async () => {
    const parent = await mkdtemp(join(tmpdir(), "video digest 'shim tests' "));
    const shims = join(parent, "shims with spaces");
    try {
      const markers = await createNoExternalAccessShims(shims, parent);
      const baseInvocation = {
        cwd: parent,
        env: { PATH: `${shims}:${dirname(process.execPath)}:/usr/bin:/bin` },
        maxOutputBytes: 1024,
        timeoutMs: 2_000,
      };
      const security = await runBoundedProcess({
        ...baseInvocation,
        args: ["value with spaces", "'quoted'", 'double"quoted'],
        executable: join(shims, "security"),
      });
      const uv = await runBoundedProcess({
        ...baseInvocation,
        args: ["--version"],
        executable: join(shims, "uv"),
      });
      expect([security.exitCode, uv.exitCode]).toEqual([44, 44]);
      expect(JSON.parse((await readFile(markers.security, "utf8")).trim())).toEqual({
        argv: ["value with spaces", "'quoted'", 'double"quoted'],
        command: "security",
      });
      expect(JSON.parse((await readFile(markers.uv, "utf8")).trim())).toEqual({
        argv: ["--version"],
        command: "uv",
      });
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });
});

function fileURLToPath(url: URL): string {
  return Bun.fileURLToPath(url);
}
