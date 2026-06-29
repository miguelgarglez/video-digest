import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  createProcessGroupSupervisor,
  packAndVerifyPackage,
  parseNpmPackOutput,
  runBoundedProcess,
  validatePackedFiles,
  validateTarMetadata,
  verifyPackedFileListsAgree,
  type CommandInvocation,
  type ProcessLifecycleEvent,
  type ProcessLifecycleHost,
} from "./verify-package";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const PACKAGE_NAME = "video-digest";
const PACKAGE_VERSION = packageJson.version;
const TARBALL_FILENAME = `${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`;

class FakeProcessLifecycleHost implements ProcessLifecycleHost {
  readonly preservedSignals: NodeJS.Signals[] = [];
  private readonly listeners = new Map<ProcessLifecycleEvent, Set<() => void>>();

  listenerCount(event: ProcessLifecycleEvent): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  off(event: ProcessLifecycleEvent, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  on(event: ProcessLifecycleEvent, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  preserveSignal(signal: NodeJS.Signals): void {
    this.preservedSignals.push(signal);
  }

  emit(event: ProcessLifecycleEvent): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error("condition did not become ready");
    await Bun.sleep(5);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const validPackedFiles = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/bin/video-digest",
  "package/python/fetch_transcript.py",
  "package/python/pyproject.toml",
  "package/python/uv.lock",
  "package/docs/cli/compatibility.md",
  "package/docs/cli/exit-codes.md",
  "package/docs/cli/json-contracts.md",
  "package/.agents/skills/video-digest/SKILL.md",
  "package/.agents/skills/video-digest/agents/openai.yaml",
  "package/.agents/skills/video-digest/references/contracts.md",
  "package/src/cli/app-paths.ts",
  "package/src/cli/artifact-library.ts",
  "package/src/cli/artifacts.ts",
  "package/src/cli/config-store.ts",
  "package/src/cli/credentials.ts",
  "package/src/cli/digest-config.ts",
  "package/src/cli/doctor.ts",
  "package/src/cli/main.ts",
  "package/src/cli/package-resources.ts",
  "package/src/cli/parse-args.ts",
  "package/src/cli/progress-renderer.ts",
  "package/src/cli/public-contract.ts",
  "package/src/cli/runtime-manager.ts",
  "package/src/cli/system-actions.ts",
  "package/src/digest/digest.ts",
  "package/src/ingestion/ingest-video.ts",
  "package/src/ingestion/ingestion-service.ts",
  "package/src/ingestion/transcript-only.ts",
  "package/src/output/output-writer.ts",
  "package/src/output/transcript-renderer.ts",
  "package/src/storage/ingestion-record.ts",
  "package/src/storage/ingestion-repository.ts",
  "package/src/storage/process-lock.ts",
  "package/src/summarizer/digest-request.ts",
  "package/src/summarizer/chat-completions-summarizer.ts",
  "package/src/summarizer/anthropic-messages-summarizer.ts",
  "package/src/summarizer/http.ts",
  "package/src/summarizer/providers.ts",
  "package/src/summarizer/responses-summarizer.ts",
  "package/src/summarizer/provider-summarizer.ts",
  "package/src/summarizer/summarizer.ts",
  "package/src/transcript/python-youtube-transcript-source.ts",
  "package/src/transcript/transcript-quality.ts",
  "package/src/transcript/transcript-source.ts",
  "package/src/tui/controller.ts",
  "package/src/tui/default-ports.ts",
  "package/src/tui/model.ts",
  "package/src/tui/ports.ts",
  "package/src/tui/renderer.ts",
  "package/src/tui/screens.ts",
  "package/src/tui/secret-editor.ts",
  "package/src/tui/start.ts",
  "package/src/tui/theme.ts",
  "package/src/tui/update.ts",
  "package/src/video/video-metadata-source.ts",
  "package/src/video/youtube-oembed-metadata-source.ts",
  "package/src/video/youtube-url.ts",
  "package/src/web/handler.ts",
  "package/src/web/html.ts",
  "package/src/web/ingestion-presenter.ts",
  "package/src/web/server.ts",
  "package/src/web/startup.ts",
] as const;

function expectedMode(path: string): number {
  return path === "package/bin/video-digest" ? 0o755 : 0o644;
}

function npmPackJson(paths: readonly string[] = validPackedFiles): string {
  return JSON.stringify([
    {
      id: `${PACKAGE_NAME}@${PACKAGE_VERSION}`,
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      filename: TARBALL_FILENAME,
      files: paths.map((path) => ({
        path: path.slice("package/".length),
        mode: expectedMode(path),
      })),
    },
  ]);
}

function tarVerboseListing(paths: readonly string[] = validPackedFiles): string {
  return (
    paths
      .map((path) => {
        const mode = path === "package/bin/video-digest" ? "-rwxr-xr-x" : "-rw-r--r--";
        return `${mode}  0 0  0  1 Oct 26 1985 ${path}`;
      })
      .join("\n") + "\n"
  );
}

describe("packed-file validation", () => {
  test("accepts exactly the public package contract", () => {
    expect(validatePackedFiles([...validPackedFiles])).toEqual([...validPackedFiles].sort());
  });

  test("requires every runtime resource", () => {
    expect(() => validatePackedFiles(["package/package.json"])).toThrow(
      "Missing packed file: package/bin/video-digest",
    );
  });

  test("rejects tests and fixtures before applying source allow rules", () => {
    for (const path of [
      "package/src/cli/main.test.ts",
      "package/src/a.spec.ts",
      "package/src/__snapshots__/main.snap",
      "package/src/deep/fixtures/request.json",
    ]) {
      expect(() => validatePackedFiles([...validPackedFiles, path])).toThrow(
        `Unexpected packed file: ${path}`,
      );
    }
  });

  test("rejects unexpected, hidden, mapped, and non-runtime source files", () => {
    for (const path of [
      "package/.env",
      "package/src/.secret.ts",
      "package/src/cli/main.ts.map",
      "package/src/cli/extra.ts",
      "package/docs/cli/extra.md",
    ]) {
      expect(() => validatePackedFiles([...validPackedFiles, path])).toThrow(
        `Unexpected packed file: ${path}`,
      );
    }
  });

  test("normalizes benign archive spelling before validation", () => {
    const spelled = validPackedFiles.map((path, index) =>
      index === 0 ? `./${path}` : path.replace("package/", "package//"),
    );
    expect(validatePackedFiles(spelled)).toEqual([...validPackedFiles].sort());
  });

  test("rejects absolute, traversal, control-character, and duplicate names", () => {
    for (const path of [
      "/package/package.json",
      "package/src/../package.json",
      "package/src/evil\nname.ts",
      "C:/package/package.json",
      "\\\\server\\package\\package.json",
    ]) {
      expect(() => validatePackedFiles([...validPackedFiles, path])).toThrow();
    }
    expect(() => validatePackedFiles([...validPackedFiles, "./package/package.json"])).toThrow(
      "Duplicate packed file: package/package.json",
    );
  });

  test("requires npm and tar manifests to describe the same files", () => {
    expect(() =>
      verifyPackedFileListsAgree(validPackedFiles, validPackedFiles.slice(1)),
    ).toThrow("Packed manifests disagree");
  });

  test("accepts BSD and GNU verbose tar formats with exact regular-file modes", () => {
    expect(validateTarMetadata(tarVerboseListing())).toEqual([...validPackedFiles].sort());
    const gnuListing = validPackedFiles
      .map((path) => {
        const mode = path === "package/bin/video-digest" ? "-rwxr-xr-x" : "-rw-r--r--";
        return `${mode} root/root 1 2026-06-22 12:00 ${path}`;
      })
      .join("\n");
    expect(validateTarMetadata(gnuListing)).toEqual([...validPackedFiles].sort());
  });

  test("rejects archive links, special entries, and incorrect executable modes", () => {
    for (const replacement of [
      "lrwxrwxrwx  0 0  0  1 Oct 26 1985 package/bin/video-digest -> /tmp/evil",
      "hrw-r--r--  0 0  0  1 Oct 26 1985 package/LICENSE link to package/README.md",
      "drwxr-xr-x  0 0  0  0 Oct 26 1985 package/docs/cli",
      "-rw-r--r--  0 0  0  1 Oct 26 1985 package/bin/video-digest",
      "-rwxr-xr-x  0 0  0  1 Oct 26 1985 package/README.md",
      "-rw-r--r--@ 0 0  0  1 Oct 26 1985 package/README.md",
    ]) {
      const path = replacement.split(/\s+/).find((part) => part.startsWith("package/"))!;
      const original = tarVerboseListing()
        .split("\n")
        .find((line) => line.endsWith(path));
      const listing = original
        ? tarVerboseListing().replace(original, replacement)
        : tarVerboseListing() + replacement + "\n";
      expect(() => validateTarMetadata(listing)).toThrow();
    }
  });

  test("validates raw npm paths before adding the archive prefix", () => {
    for (const path of [
      "/package.json",
      "../package.json",
      "a//b",
      ".",
      "a/./b",
      "C:/package.json",
      "\\\\server\\package.json",
      "bad\nname",
    ]) {
      expect(() => parseNpmPackOutput(npmPackJson([`package/${path}`]))).toThrow(
        "Unsafe npm pack file path",
      );
    }
    const duplicate = JSON.parse(npmPackJson()) as Array<{ files: unknown[] }>;
    duplicate[0]!.files.push(duplicate[0]!.files[0]);
    expect(() => parseNpmPackOutput(JSON.stringify(duplicate))).toThrow(
      "Duplicate npm pack file path",
    );
  });

  test("rejects npm modes and types that contradict the package contract", () => {
    const badMode = JSON.parse(npmPackJson()) as Array<{ files: Array<Record<string, unknown>> }>;
    badMode[0]!.files.find((entry) => entry.path === "bin/video-digest")!.mode = 0o644;
    expect(() => parseNpmPackOutput(JSON.stringify(badMode))).toThrow(
      "Unexpected npm pack file mode",
    );

    const badType = JSON.parse(npmPackJson()) as Array<{ files: Array<Record<string, unknown>> }>;
    badType[0]!.files[0]!.type = "symlink";
    expect(() => parseNpmPackOutput(JSON.stringify(badType))).toThrow(
      "Unexpected npm pack file type",
    );
  });
});

describe("package creation", () => {
  test("uses shell-free commands, a fresh destination, and returns cleanup ownership", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const tempRoot = await mkdtemp(join(tmpdir(), "video digest verifier tests "));
    const invocations: CommandInvocation[] = [];
    try {
      const runCommand = async (invocation: CommandInvocation) => {
        invocations.push(invocation);
        if (invocation.executable === "npm") {
          const destination = invocation.args.at(-1)!;
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, TARBALL_FILENAME), "fixture");
          return {
            exitCode: 0,
            stdout: npmPackJson(),
            stderr: "",
          };
        }
        if (invocation.args[0] === "-tvzf") {
          return { exitCode: 0, stdout: tarVerboseListing(), stderr: "" };
        }
        return { exitCode: 0, stdout: validPackedFiles.join("\n") + "\n", stderr: "" };
      };

      const result = await packAndVerifyPackage({ repositoryRoot: root, tempRoot, runCommand });

      expect(invocations.map(({ executable, args }) => [executable, ...args])).toEqual([
        [
          "npm",
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          result.temporaryDirectory,
        ],
        ["tar", "-tzf", result.tarballPath],
        ["tar", "-tvzf", result.tarballPath],
      ]);
      expect(
        invocations.map(({ timeoutMs, maxOutputBytes }) => ({ timeoutMs, maxOutputBytes })),
      ).toEqual([
        { timeoutMs: 60_000, maxOutputBytes: 2 * 1024 * 1024 },
        { timeoutMs: 15_000, maxOutputBytes: 2 * 1024 * 1024 },
        { timeoutMs: 15_000, maxOutputBytes: 2 * 1024 * 1024 },
      ]);
      expect(result.tarballPath).toBe(
        join(result.temporaryDirectory, TARBALL_FILENAME),
      );
      expect(result.temporaryDirectory.startsWith(tempRoot)).toBe(true);
      await result.cleanup();
      expect(await Bun.file(result.tarballPath).exists()).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("reports failed pack commands without echoing their output", async () => {
    const secret = "npm_token=do-not-leak";
    const runCommand = async () => ({ exitCode: 1, stdout: secret, stderr: secret });
    await expect(
      packAndVerifyPackage({ repositoryRoot: process.cwd(), runCommand }),
    ).rejects.toThrow("npm pack failed with exit code 1");
    try {
      await packAndVerifyPackage({ repositoryRoot: process.cwd(), runCommand });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }

    const throwingRunner = async (): Promise<never> => {
      throw new Error(secret);
    };
    await expect(
      packAndVerifyPackage({ repositoryRoot: process.cwd(), runCommand: throwingRunner }),
    ).rejects.toThrow("npm pack could not be executed");
    try {
      await packAndVerifyPackage({ repositoryRoot: process.cwd(), runCommand: throwingRunner });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  test("enforces the output cap on an injected command runner", async () => {
    const runCommand = async () => ({
      exitCode: 0,
      stdout: "secret".repeat(100),
      stderr: "",
    });
    await expect(
      packAndVerifyPackage({ repositoryRoot: process.cwd(), runCommand, maxOutputBytes: 32 }),
    ).rejects.toThrow("npm pack output exceeded limit");
  });

  test("shares concurrent cleanup, then resets a failed attempt for retry", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "video digest cleanup tests "));
    let attempts = 0;
    let releaseFirst!: () => void;
    const firstAttempt = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const removeDirectory = async (path: string) => {
      expect(path.startsWith(tempRoot)).toBe(true);
      attempts += 1;
      if (attempts === 1) {
        await firstAttempt;
        throw new Error("injected cleanup failure");
      }
      await rm(path, { recursive: true, force: true });
    };
    const runCommand = async (invocation: CommandInvocation) => {
      if (invocation.executable === "npm") {
        await writeFile(join(invocation.args.at(-1)!, TARBALL_FILENAME), "fixture");
        return { exitCode: 0, stdout: npmPackJson(), stderr: "" };
      }
      return {
        exitCode: 0,
        stdout:
          invocation.args[0] === "-tvzf"
            ? tarVerboseListing()
            : validPackedFiles.join("\n") + "\n",
        stderr: "",
      };
    };
    try {
      const result = await packAndVerifyPackage({ tempRoot, runCommand, removeDirectory });
      const cleanupA = result.cleanup();
      const cleanupB = result.cleanup();
      expect(cleanupA).toBe(cleanupB);
      releaseFirst();
      await expect(cleanupA).rejects.toThrow("injected cleanup failure");
      expect(attempts).toBe(1);
      await result.cleanup();
      expect(attempts).toBe(2);
      await result.cleanup();
      expect(attempts).toBe(2);
    } finally {
      releaseFirst();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects invalid limits before allocating a temporary package directory", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "video digest invalid limit tests "));
    try {
      await expect(packAndVerifyPackage({ tempRoot, packTimeoutMs: 0 })).rejects.toThrow(
        "Command limit must be positive",
      );
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("bounded command execution", () => {
  test("forwards a parent signal once to every owned group and preserves parent semantics", () => {
    const host = new FakeProcessLifecycleHost();
    const supervisor = createProcessGroupSupervisor(host);
    const first: NodeJS.Signals[] = [];
    const second: NodeJS.Signals[] = [];
    const unregisterFirst = supervisor.register((signal) => first.push(signal));
    const unregisterSecond = supervisor.register((signal) => second.push(signal));

    expect(host.listenerCount("SIGINT")).toBe(1);
    expect(host.listenerCount("SIGTERM")).toBe(1);
    expect(host.listenerCount("exit")).toBe(1);
    host.emit("SIGTERM");

    expect(first).toEqual(["SIGTERM", "SIGKILL"]);
    expect(second).toEqual(["SIGTERM", "SIGKILL"]);
    expect(host.preservedSignals).toEqual(["SIGTERM"]);
    expect(host.listenerCount("SIGINT")).toBe(0);
    expect(host.listenerCount("SIGTERM")).toBe(0);
    expect(host.listenerCount("exit")).toBe(0);
    unregisterFirst();
    unregisterSecond();
  });

  test("kills every owned group synchronously during process exit", () => {
    const host = new FakeProcessLifecycleHost();
    const supervisor = createProcessGroupSupervisor(host);
    const signals: NodeJS.Signals[] = [];
    const unregister = supervisor.register((signal) => signals.push(signal));

    host.emit("exit");

    expect(signals).toEqual(["SIGKILL"]);
    expect(host.preservedSignals).toEqual([]);
    expect(host.listenerCount("exit")).toBe(0);
    unregister();
  });

  test("kills a real child and descendant on a forwarded signal without leaking handlers", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-forwarded-signal-tests-"));
    const groupPidFile = join(root, "group.pid");
    const childPidFile = join(root, "child.pid");
    const readyFile = join(root, "descendant-ready");
    const observedPids = new Set<number>();
    let observedGroupPid: number | undefined;
    const host = new FakeProcessLifecycleHost();
    const supervisor = createProcessGroupSupervisor(host);
    const childProgram = [
      'const { writeFileSync } = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `writeFileSync(${JSON.stringify(readyFile)}, "ready");`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const parentProgram = [
      'const { writeFileSync } = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `writeFileSync(${JSON.stringify(groupPidFile)}, String(process.pid));`,
      `const child = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(childProgram)}], { stdio: ["ignore", "inherit", "inherit"] });`,
      `writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
      "child.unref();",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    try {
      const resultPromise = runBoundedProcess(
        {
          executable: process.execPath,
          args: ["-e", parentProgram],
          cwd: process.cwd(),
          timeoutMs: 5_000,
          maxOutputBytes: 1024,
        },
        { supervisor },
      );
      await waitForCondition(async () =>
        (await Bun.file(readyFile).exists()) &&
        (await Bun.file(groupPidFile).exists()) &&
        (await Bun.file(childPidFile).exists()),
      );
      for (const file of [groupPidFile, childPidFile]) {
        const pid = Number(await readFile(file, "utf8"));
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        observedPids.add(pid);
        if (file === groupPidFile) observedGroupPid = pid;
      }

      host.emit("SIGTERM");
      const result = await resultPromise;
      expect(result.exitCode).not.toBe(0);
      await waitForCondition(() => [...observedPids].every((pid) => !processExists(pid)));
      expect(host.preservedSignals).toEqual(["SIGTERM"]);
      expect(host.listenerCount("SIGINT")).toBe(0);
      expect(host.listenerCount("SIGTERM")).toBe(0);
      expect(host.listenerCount("exit")).toBe(0);
    } finally {
      for (const pidFile of [groupPidFile, childPidFile]) {
        try {
          const pid = Number(await readFile(pidFile, "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0) observedPids.add(pid);
          if (pidFile === groupPidFile && Number.isSafeInteger(pid) && pid > 0) {
            observedGroupPid = pid;
          }
        } catch {
          // A pre-spawn failure has no process to record.
        }
      }
      if (observedGroupPid) {
        try { process.kill(-observedGroupPid, "SIGKILL"); } catch {}
      }
      for (const pid of observedPids) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  test("terminates and settles a timed-out child", async () => {
    await expect(
      runBoundedProcess({
        executable: process.execPath,
        args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
        timeoutMs: 25,
        maxOutputBytes: 1024,
      }),
    ).rejects.toThrow("Command timed out");
  });

  test("removes default process lifecycle handlers after normal settlement", async () => {
    const before = {
      exit: process.listenerCount("exit"),
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    const result = await runBoundedProcess({
      executable: process.execPath,
      args: ["-e", "console.log('settled')"],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      maxOutputBytes: 1024,
    });
    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "settled\n" });
    expect({
      exit: process.listenerCount("exit"),
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    }).toEqual(before);
  });

  test("terminates a child when combined output exceeds the limit", async () => {
    const secret = "x".repeat(2048);
    try {
      await runBoundedProcess({
        executable: process.execPath,
        args: ["-e", `console.log(${JSON.stringify(secret)}); setInterval(() => {}, 1000)`],
        cwd: process.cwd(),
        timeoutMs: 2_000,
        maxOutputBytes: 32,
      });
      throw new Error("expected output limit failure");
    } catch (error) {
      expect(String(error)).toContain("Command output exceeded limit");
      expect(String(error)).not.toContain(secret);
    }
  });

  test("kills a ready detached descendant before returning from an output limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-process-group-tests-"));
    const marker = join(root, "descendant-survived");
    const ready = join(root, "descendant-ready");
    const groupPidFile = join(root, "group.pid");
    const childPidFile = join(root, "child.pid");
    const observedPids = new Set<number>();
    let observedGroupPid: number | undefined;
    const childProgram = [
      'const { writeFileSync } = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `writeFileSync(${JSON.stringify(ready)}, "ready");`,
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "survived"), 500);`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const parentProgram = [
      'const { existsSync, writeFileSync } = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `writeFileSync(${JSON.stringify(groupPidFile)}, String(process.pid));`,
      `const child = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(childProgram)}], { stdio: ["ignore", "inherit", "inherit"] });`,
      `writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
      "child.unref();",
      "const waiter = new Int32Array(new SharedArrayBuffer(4));",
      "const deadline = Date.now() + 2000;",
      `while (!existsSync(${JSON.stringify(ready)}) && Date.now() < deadline) Atomics.wait(waiter, 0, 0, 5);`,
      `if (!existsSync(${JSON.stringify(ready)})) process.exit(4);`,
      `console.log(${JSON.stringify("x".repeat(2048))});`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const startedAt = performance.now();
    try {
      await expect(
        runBoundedProcess({
          executable: process.execPath,
          args: ["-e", parentProgram],
          cwd: process.cwd(),
          timeoutMs: 3_000,
          maxOutputBytes: 32,
        }),
      ).rejects.toThrow("Command output exceeded limit");
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(await Bun.file(ready).exists()).toBe(true);
      for (const file of [groupPidFile, childPidFile]) {
        const pid = Number(await readFile(file, "utf8"));
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        observedPids.add(pid);
        if (file === groupPidFile) observedGroupPid = pid;
      }
      await waitForCondition(() => [...observedPids].every((pid) => !processExists(pid)));
      await Bun.sleep(Math.max(0, 700 - (performance.now() - startedAt)));
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      for (const pidFile of [groupPidFile, childPidFile]) {
        try {
          const pid = Number(await readFile(pidFile, "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0) observedPids.add(pid);
          if (pidFile === groupPidFile && Number.isSafeInteger(pid) && pid > 0) {
            observedGroupPid = pid;
          }
        } catch {
          // A pre-spawn failure has no process to record.
        }
      }
      if (observedGroupPid) {
        try { process.kill(-observedGroupPid, "SIGKILL"); } catch {}
      }
      for (const pid of observedPids) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      await rm(root, { force: true, recursive: true });
    }
  });
});
