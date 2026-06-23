import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const TARBALL_FILENAME = `${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`;
const DEFAULT_PACK_TIMEOUT_MS = 60_000;
const DEFAULT_TAR_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TERMINATION_GRACE_MS = 250;

const expectedPackedFiles = [
  "package/package.json",
  "package/bin/video-digest",
  "package/README.md",
  "package/LICENSE",
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
  "package/src/summarizer/opencode-summarizer.ts",
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

const expectedPackedFileSet = new Set<string>(expectedPackedFiles);
const forbiddenSource =
  /(?:\.(?:test|spec)\.[^/]+$|\.snap(?:\.|$)|\/(?:__)?(?:snapshots?|fixtures?)(?:__)?\/)/i;
const controlCharacter = /[\u0000-\u001f\u007f]/;

export interface CommandInvocation {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<CommandResult>;

export type ProcessLifecycleEvent = "SIGINT" | "SIGTERM" | "exit";

export interface ProcessLifecycleHost {
  on(event: ProcessLifecycleEvent, listener: () => void): void;
  off(event: ProcessLifecycleEvent, listener: () => void): void;
  preserveSignal(signal: NodeJS.Signals): void;
}

export interface ProcessGroupSupervisor {
  register(signalGroup: (signal: NodeJS.Signals) => void): () => void;
}

export interface RunBoundedProcessOptions {
  supervisor?: ProcessGroupSupervisor;
}

const defaultProcessLifecycleHost: ProcessLifecycleHost = {
  off(event, listener) {
    process.off(event, listener);
  },
  on(event, listener) {
    process.on(event, listener);
  },
  preserveSignal(signal) {
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exitCode = signal === "SIGINT" ? 130 : 143;
    }
  },
};

export function createProcessGroupSupervisor(
  host: ProcessLifecycleHost = defaultProcessLifecycleHost,
): ProcessGroupSupervisor {
  const groups = new Map<symbol, (signal: NodeJS.Signals) => void>();
  let attached = false;

  const safelySignalAll = (signal: NodeJS.Signals): void => {
    for (const signalGroup of [...groups.values()]) {
      try {
        signalGroup(signal);
      } catch {
        // Continue terminating every owned group even if one has already exited.
      }
    }
  };
  const detach = (): void => {
    if (!attached) return;
    host.off("SIGINT", onSigint);
    host.off("SIGTERM", onSigterm);
    host.off("exit", onExit);
    attached = false;
  };
  const forwardAndPreserve = (signal: NodeJS.Signals): void => {
    detach();
    safelySignalAll(signal);
    safelySignalAll("SIGKILL");
    host.preserveSignal(signal);
  };
  const onSigint = () => forwardAndPreserve("SIGINT");
  const onSigterm = () => forwardAndPreserve("SIGTERM");
  const onExit = () => {
    detach();
    safelySignalAll("SIGKILL");
  };
  const attach = (): void => {
    if (attached) return;
    host.on("SIGINT", onSigint);
    host.on("SIGTERM", onSigterm);
    host.on("exit", onExit);
    attached = true;
  };

  return {
    register(signalGroup) {
      const token = Symbol("owned-process-group");
      groups.set(token, signalGroup);
      attach();
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        groups.delete(token);
        if (groups.size === 0) detach();
      };
    },
  };
}

const defaultProcessGroupSupervisor = createProcessGroupSupervisor();

export interface PackAndVerifyOptions {
  repositoryRoot?: string;
  tempRoot?: string;
  runCommand?: CommandRunner;
  packTimeoutMs?: number;
  tarTimeoutMs?: number;
  maxOutputBytes?: number;
  removeDirectory?: (path: string) => Promise<void>;
}

export interface VerifiedPackage {
  tarballPath: string;
  temporaryDirectory: string;
  cleanup: () => Promise<void>;
}

function displayPath(path: string): string {
  return controlCharacter.test(path) ? JSON.stringify(path) : path;
}

function normalizePackedFileName(name: string): string {
  if (
    name.length === 0 ||
    controlCharacter.test(name) ||
    name.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(name) ||
    name.startsWith("\\\\") ||
    name.includes("\\")
  ) {
    throw new Error(`Unsafe packed file name: ${displayPath(name)}`);
  }

  const withoutDotPrefix = name.replace(/^(?:\.\/)+/, "");
  if (withoutDotPrefix.split("/").includes("..")) {
    throw new Error(`Unsafe packed file name: ${displayPath(name)}`);
  }

  const normalized = posix.normalize(withoutDotPrefix);
  if (normalized === "." || normalized === ".." || !normalized.startsWith("package/")) {
    throw new Error(`Unsafe packed file name: ${displayPath(name)}`);
  }
  return normalized;
}

function expectedMode(path: string): number {
  return path === "package/bin/video-digest" ? 0o755 : 0o644;
}

export function validatePackedFiles(files: readonly string[]): string[] {
  const normalizedFiles: string[] = [];
  const seen = new Set<string>();

  for (const input of files) {
    const file = normalizePackedFileName(input);
    if (seen.has(file)) throw new Error(`Duplicate packed file: ${file}`);
    seen.add(file);

    if (forbiddenSource.test(file)) {
      throw new Error(`Unexpected packed file: ${file}`);
    }
    if (!expectedPackedFileSet.has(file)) {
      throw new Error(`Unexpected packed file: ${file}`);
    }
    normalizedFiles.push(file);
  }

  for (const required of expectedPackedFiles) {
    if (!seen.has(required)) throw new Error(`Missing packed file: ${required}`);
  }

  return normalizedFiles.sort();
}

export function verifyPackedFileListsAgree(
  tarFiles: readonly string[],
  npmFiles: readonly string[],
): void {
  const normalizedTarFiles = tarFiles.map(normalizePackedFileName).sort();
  const normalizedNpmFiles = npmFiles.map(normalizePackedFileName).sort();
  if (
    normalizedTarFiles.length !== normalizedNpmFiles.length ||
    normalizedTarFiles.some((file, index) => file !== normalizedNpmFiles[index])
  ) {
    throw new Error("Packed manifests disagree");
  }
  validatePackedFiles(tarFiles);
  validatePackedFiles(npmFiles);
}

function validateCommandLimits(invocation: CommandInvocation): void {
  if (!Number.isFinite(invocation.timeoutMs) || invocation.timeoutMs <= 0) {
    throw new Error("Command timeout must be positive");
  }
  if (!Number.isSafeInteger(invocation.maxOutputBytes) || invocation.maxOutputBytes <= 0) {
    throw new Error("Command output limit must be a positive integer");
  }
}

export async function runBoundedProcess(
  invocation: CommandInvocation,
  options: RunBoundedProcessOptions = {},
): Promise<CommandResult> {
  validateCommandLimits(invocation);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([invocation.executable, ...invocation.args], {
      cwd: invocation.cwd,
      detached: true,
      env: invocation.env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new Error("Command could not be started");
  }

  let failure: Error | null = null;
  let outputBytes = 0;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
  let escalationPromise: Promise<void> | undefined;
  const outputReaders = new Set<{ cancel(reason?: unknown): Promise<void> }>();
  const signalOwnedProcessGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The owned process group may already have exited.
      }
    }
  };
  const unregisterProcessGroup = (
    options.supervisor ?? defaultProcessGroupSupervisor
  ).register(signalOwnedProcessGroup);
  const terminate = (reason: Error) => {
    if (failure) return;
    failure = reason;
    signalOwnedProcessGroup("SIGTERM");
    escalationPromise = new Promise((resolveEscalation) => {
      escalationTimer = setTimeout(() => {
        signalOwnedProcessGroup("SIGKILL");
        resolveEscalation();
      }, TERMINATION_GRACE_MS);
    });
    for (const reader of outputReaders) {
      void reader.cancel().catch(() => {
        // Promise settlement below normalizes stream cancellation failures.
      });
    }
  };

  try {
    const timeoutTimer = setTimeout(
      () => terminate(new Error("Command timed out")),
      invocation.timeoutMs,
    );

    const collect = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> => {
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      outputReaders.add(reader);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return chunks;
          outputBytes += value.byteLength;
          if (outputBytes > invocation.maxOutputBytes) {
            terminate(new Error("Command output exceeded limit"));
            continue;
          }
          chunks.push(value);
        }
      } finally {
        outputReaders.delete(reader);
      }
    };

    const stdoutPromise = collect(child.stdout as ReadableStream<Uint8Array>);
    const stderrPromise = collect(child.stderr as ReadableStream<Uint8Array>);
    const [exitResult, stdoutResult, stderrResult] = await Promise.allSettled([
      child.exited,
      stdoutPromise,
      stderrPromise,
    ]);
    clearTimeout(timeoutTimer);
    if (failure && escalationPromise) await escalationPromise;
    if (escalationTimer) clearTimeout(escalationTimer);

    if (failure) throw failure;
    if (
      exitResult.status !== "fulfilled" ||
      stdoutResult.status !== "fulfilled" ||
      stderrResult.status !== "fulfilled"
    ) {
      throw new Error("Command execution failed");
    }

    const decode = (chunks: Uint8Array[]) => {
      const decoder = new TextDecoder();
      return chunks.map((chunk, index) =>
        decoder.decode(chunk, { stream: index < chunks.length - 1 }),
      ).join("");
    };
    return {
      exitCode: exitResult.value,
      stdout: decode(stdoutResult.value),
      stderr: decode(stderrResult.value),
    };
  } finally {
    unregisterProcessGroup();
  }
}

interface NpmPackRecord {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  filename?: unknown;
  files?: unknown;
}

function validateRawNpmPath(path: string): string {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    controlCharacter.test(path) ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe npm pack file path: ${displayPath(path)}`);
  }
  return path;
}

export function parseNpmPackOutput(stdout: string): { filename: string; files: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack returned invalid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack must return exactly one package record");
  }

  const record = parsed[0] as NpmPackRecord;
  if (
    record.name !== PACKAGE_NAME ||
    record.version !== PACKAGE_VERSION ||
    record.id !== `${PACKAGE_NAME}@${PACKAGE_VERSION}`
  ) {
    throw new Error(`npm pack returned unexpected package identity`);
  }
  if (
    record.filename !== TARBALL_FILENAME ||
    basename(record.filename) !== record.filename ||
    controlCharacter.test(record.filename)
  ) {
    throw new Error("npm pack returned an unsafe tarball filename");
  }
  if (!Array.isArray(record.files)) {
    throw new Error("npm pack returned an invalid file manifest");
  }

  const seen = new Set<string>();
  const files = record.files.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      typeof entry.path !== "string"
    ) {
      throw new Error("npm pack returned an invalid file manifest");
    }
    const rawPath = validateRawNpmPath(entry.path);
    if (seen.has(rawPath)) throw new Error(`Duplicate npm pack file path: ${rawPath}`);
    seen.add(rawPath);
    const path = `package/${rawPath}`;

    if (!("mode" in entry) || entry.mode !== expectedMode(path)) {
      throw new Error(`Unexpected npm pack file mode: ${path}`);
    }
    if ("type" in entry && entry.type !== undefined && entry.type !== "file") {
      throw new Error(`Unexpected npm pack file type: ${path}`);
    }
    return path;
  });
  return { filename: record.filename, files };
}

function parseTarListing(stdout: string): string[] {
  const files = stdout.split(/\r?\n/);
  if (files.at(-1) === "") files.pop();
  if (files.length === 0 || files.some((file) => file.length === 0)) {
    throw new Error("tar returned an invalid file listing");
  }
  return files;
}

export function validateTarMetadata(stdout: string): string[] {
  const lines = parseTarListing(stdout);
  const paths = lines.map((line) => {
    const mode = line.slice(0, 10);
    if (!/^[\-bcdhlps][rwxStTs-]{9}$/.test(mode) || !/^\s$/.test(line[10] ?? "")) {
      throw new Error("tar returned an invalid verbose listing");
    }
    const pathTokens = line
      .trim()
      .split(/\s+/)
      .filter((token) => token.startsWith("package/") || token.startsWith("./package/"));
    if (pathTokens.length !== 1) {
      throw new Error("tar returned an ambiguous verbose listing");
    }
    const path = normalizePackedFileName(pathTokens[0]!);
    if (mode[0] !== "-") throw new Error(`Unexpected tar entry type: ${path}`);
    const requiredMode = expectedMode(path) === 0o755 ? "-rwxr-xr-x" : "-rw-r--r--";
    if (mode !== requiredMode) throw new Error(`Unexpected tar entry mode: ${path}`);
    return path;
  });
  return validatePackedFiles(paths);
}

function safePositiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error("Command limit must be positive");
  return value;
}

export async function packAndVerifyPackage(
  options: PackAndVerifyOptions = {},
): Promise<VerifiedPackage> {
  const repositoryRoot = resolve(
    options.repositoryRoot ?? fileURLToPath(new URL("..", import.meta.url)),
  );
  const packTimeoutMs = safePositiveLimit(options.packTimeoutMs, DEFAULT_PACK_TIMEOUT_MS);
  const tarTimeoutMs = safePositiveLimit(options.tarTimeoutMs, DEFAULT_TAR_TIMEOUT_MS);
  const maxOutputBytes = safePositiveLimit(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  if (!Number.isSafeInteger(maxOutputBytes)) {
    throw new Error("Command output limit must be a positive integer");
  }
  const temporaryDirectory = await mkdtemp(
    join(resolve(options.tempRoot ?? tmpdir()), "video-digest-pack-"),
  );
  const runCommand = options.runCommand ?? runBoundedProcess;
  const removeDirectory =
    options.removeDirectory ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  const invokeCommand = async (
    label: string,
    invocation: CommandInvocation,
  ): Promise<CommandResult> => {
    let result: CommandResult;
    try {
      result = await runCommand(invocation);
    } catch (error) {
      if (error instanceof Error && error.message === "Command timed out") {
        throw new Error(`${label} timed out`);
      }
      if (error instanceof Error && error.message === "Command output exceeded limit") {
        throw new Error(`${label} output exceeded limit`);
      }
      throw new Error(`${label} could not be executed`);
    }
    const outputBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    if (outputBytes > invocation.maxOutputBytes) {
      throw new Error(`${label} output exceeded limit`);
    }
    return result;
  };

  try {
    const packResult = await invokeCommand("npm pack", {
      executable: "npm",
      args: [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        temporaryDirectory,
      ],
      cwd: repositoryRoot,
      timeoutMs: packTimeoutMs,
      maxOutputBytes,
    });
    if (packResult.exitCode !== 0) {
      throw new Error(`npm pack failed with exit code ${packResult.exitCode}`);
    }

    const manifest = parseNpmPackOutput(packResult.stdout);
    const tarballPath = join(temporaryDirectory, manifest.filename);
    const tarResult = await invokeCommand("tar listing", {
      executable: "tar",
      args: ["-tzf", tarballPath],
      cwd: repositoryRoot,
      timeoutMs: tarTimeoutMs,
      maxOutputBytes,
    });
    if (tarResult.exitCode !== 0) {
      throw new Error(`tar listing failed with exit code ${tarResult.exitCode}`);
    }

    const tarFiles = parseTarListing(tarResult.stdout);
    const verboseTarResult = await invokeCommand("tar metadata listing", {
      executable: "tar",
      args: ["-tvzf", tarballPath],
      cwd: repositoryRoot,
      timeoutMs: tarTimeoutMs,
      maxOutputBytes,
    });
    if (verboseTarResult.exitCode !== 0) {
      throw new Error(`tar metadata listing failed with exit code ${verboseTarResult.exitCode}`);
    }

    const verboseTarFiles = validateTarMetadata(verboseTarResult.stdout);
    const npmFiles = manifest.files;
    verifyPackedFileListsAgree(tarFiles, npmFiles);
    verifyPackedFileListsAgree(tarFiles, verboseTarFiles);

    const cleanup = createOwnedDirectoryCleanup(temporaryDirectory, removeDirectory);
    return {
      tarballPath,
      temporaryDirectory,
      cleanup,
    };
  } catch (error) {
    try {
      await removeDirectory(temporaryDirectory);
    } catch {
      throw new Error("Package verification and temporary cleanup failed");
    }
    throw error;
  }
}

export function createOwnedDirectoryCleanup(
  directory: string,
  removeDirectory: (path: string) => Promise<void> = (path) =>
    rm(path, { recursive: true, force: true }),
): () => Promise<void> {
  let cleaned = false;
  let cleanupPromise: Promise<void> | undefined;
  return (): Promise<void> => {
    if (cleaned) return Promise.resolve();
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = Promise.resolve()
      .then(() => removeDirectory(directory))
      .then(() => {
        cleaned = true;
      })
      .finally(() => {
        cleanupPromise = undefined;
      });
    return cleanupPromise;
  };
}

if (import.meta.main) {
  try {
    const verifiedPackage = await packAndVerifyPackage();
    console.log(verifiedPackage.tarballPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Package verification failed");
    process.exitCode = 1;
  }
}
