import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const REMEDIATION = "Run video-digest setup.";

export type RuntimeReadiness =
  | { status: "ready" }
  | { status: "missing"; remediation: string }
  | { status: "obsolete"; remediation: string };

export type RuntimeCommandResult = { exitCode: number; stderr: string; stdout: string };
export type RuntimeCommandRunner = (
  command: string[],
  options: { cwd: string; env: Record<string, string> },
) => Promise<RuntimeCommandResult>;

export type PrepareRuntimeInput = {
  clock?: () => Date;
  filesystem?: RuntimeFilesystem;
  idFactory?: () => string;
  lockContents: string;
  pythonDir: string;
  pid?: number;
  processAlive?: (pid: number) => boolean;
  runner?: RuntimeCommandRunner;
  runtimeDir: string;
  uvPath: string;
};

export class RuntimeSetupError extends Error {
  constructor(public readonly code: "already-running" | "recovery-required", message: string) {
    super(message);
    this.name = "RuntimeSetupError";
  }
}

type SetupLockOwner = { schemaVersion: "runtime-setup-lock.v0"; pid: number; token: string; stagingDir: string; backupDir: string; createdAt: string };

export type RuntimeFilesystem = {
  access: typeof access;
  mkdir: typeof mkdir;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
};

const defaultRuntimeFilesystem: RuntimeFilesystem = { access, mkdir, rename, rm, writeFile };

export async function prepareRuntime(input: PrepareRuntimeInput): Promise<void> {
  const id = (input.idFactory ?? (() => crypto.randomUUID()))();
  const stagingDir = `${input.runtimeDir}.staging-${id}`;
  const backupDir = `${input.runtimeDir}.backup-${id}`;
  const lockDir = `${input.runtimeDir}.setup-lock`;
  const runner = input.runner ?? runRuntimeCommand;
  const filesystem = input.filesystem ?? defaultRuntimeFilesystem;
  const clock = input.clock ?? (() => new Date());
  const pid = input.pid ?? process.pid;
  const processAlive = input.processAlive ?? defaultProcessAlive;

  await filesystem.mkdir(dirname(input.runtimeDir), { recursive: true });
  try {
    await filesystem.mkdir(lockDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      await recoverExistingLock({ clock, filesystem, lockDir, lockContents: input.lockContents, processAlive, runtimeDir: input.runtimeDir });
      await filesystem.mkdir(lockDir);
    } else {
      throw error;
    }
  }
  const owner: SetupLockOwner = { schemaVersion: "runtime-setup-lock.v0", pid, token: id, stagingDir, backupDir, createdAt: clock().toISOString() };
  try {
    await filesystem.writeFile(join(lockDir, "owner.json"), JSON.stringify(owner));
  } catch (error) {
    await filesystem.rm(lockDir, { force: true, recursive: true });
    throw error;
  }

  let backupCreated = false;
  let backupConsumed = false;
  try {
    const result = await runner(
      [input.uvPath, "sync", "--frozen", "--python", "3.12", "--project", input.pythonDir],
      { cwd: input.pythonDir, env: { UV_PROJECT_ENVIRONMENT: stagingDir } },
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `uv sync failed with exit code ${result.exitCode}`);
    }

    await filesystem.writeFile(runtimeMarkerPath(stagingDir), expectedRuntimeMarker(input.lockContents));
    if ((await inspectRuntime(stagingDir, input.lockContents)).status !== "ready") {
      throw new Error("Prepared Python runtime is not ready.");
    }
    const hadRuntime = await pathExists(input.runtimeDir, filesystem.access);
    if (hadRuntime) {
      await filesystem.rename(input.runtimeDir, backupDir);
      backupCreated = true;
    }
    try {
      await filesystem.rename(stagingDir, input.runtimeDir);
    } catch (error) {
      if (hadRuntime) {
        try {
          await filesystem.rename(backupDir, input.runtimeDir);
          backupConsumed = true;
        } catch {
          throw new RuntimeSetupError("recovery-required", `Runtime recovery is required. Existing runtime backup preserved at ${backupDir}`);
        }
      }
      throw error;
    }
    if ((await inspectRuntime(input.runtimeDir, input.lockContents)).status !== "ready") {
      await filesystem.rm(input.runtimeDir, { force: true, recursive: true });
      if (hadRuntime) {
        try {
          await filesystem.rename(backupDir, input.runtimeDir);
          backupConsumed = true;
        } catch {
          throw new RuntimeSetupError("recovery-required", `Runtime recovery is required. Existing runtime backup preserved at ${backupDir}`);
        }
      }
      throw new Error("Installed Python runtime is not ready.");
    }
    await filesystem.rm(backupDir, { force: true, recursive: true });
    backupConsumed = true;
  } finally {
    await filesystem.rm(stagingDir, { force: true, recursive: true });
    if (!backupCreated || backupConsumed) await filesystem.rm(backupDir, { force: true, recursive: true });
    await filesystem.rm(lockDir, { force: true, recursive: true });
  }
}

async function recoverExistingLock(input: { clock: () => Date; filesystem: RuntimeFilesystem; lockDir: string; lockContents: string; processAlive: (pid: number) => boolean; runtimeDir: string }): Promise<void> {
  let owner: SetupLockOwner;
  try {
    owner = JSON.parse(await readFile(join(input.lockDir, "owner.json"), "utf8")) as SetupLockOwner;
    if (owner.schemaVersion !== "runtime-setup-lock.v0" || !Number.isInteger(owner.pid) || typeof owner.token !== "string" || owner.stagingDir !== `${input.runtimeDir}.staging-${owner.token}` || owner.backupDir !== `${input.runtimeDir}.backup-${owner.token}`) throw new Error("invalid metadata");
  } catch {
    const age = input.clock().getTime() - (await stat(input.lockDir)).mtimeMs;
    if (age < 5 * 60_000) throw new RuntimeSetupError("already-running", "Runtime setup is already in progress.");
    throw new RuntimeSetupError("recovery-required", `Runtime setup recovery is required. Inspect ${input.lockDir}`);
  }
  if (input.processAlive(owner.pid)) throw new RuntimeSetupError("already-running", "Runtime setup is already in progress.");
  await input.filesystem.rm(owner.stagingDir, { force: true, recursive: true });
  if (await pathExists(owner.backupDir, input.filesystem.access)) {
    const readiness = await inspectRuntime(input.runtimeDir, input.lockContents);
    if (readiness.status === "ready") {
      await input.filesystem.rm(owner.backupDir, { force: true, recursive: true });
    } else {
      await input.filesystem.rm(input.runtimeDir, { force: true, recursive: true });
      await input.filesystem.rename(owner.backupDir, input.runtimeDir);
    }
  }
  await input.filesystem.rm(input.lockDir, { force: true, recursive: true });
}

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return error instanceof Error && "code" in error && error.code === "EPERM"; }
}

export function expectedRuntimeMarker(lockContents: string): string {
  return new Bun.CryptoHasher("sha256").update(lockContents).digest("hex");
}

export function managedInterpreterPath(runtimeDir: string): string {
  return join(runtimeDir, "bin", "python");
}

export function runtimeMarkerPath(runtimeDir: string): string {
  return join(runtimeDir, ".lock-hash");
}

export async function inspectRuntime(runtimeDir: string, lockContents: string): Promise<RuntimeReadiness> {
  if (!(await isExecutableFile(managedInterpreterPath(runtimeDir)))) {
    return { remediation: REMEDIATION, status: "missing" };
  }

  let markerContents: string;
  try {
    markerContents = await readFile(runtimeMarkerPath(runtimeDir), "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return { remediation: REMEDIATION, status: "missing" };
    }
    throw error;
  }

  if (markerContents.trim() !== expectedRuntimeMarker(lockContents)) {
    return { remediation: REMEDIATION, status: "obsolete" };
  }

  return { status: "ready" };
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) {
      return false;
    }
    await access(path, constants.X_OK);
    return true;
  } catch (error) {
    if (isUnavailablePathError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isUnavailablePathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM")
  );
}

async function pathExists(path: string, accessPath: typeof access = access): Promise<boolean> {
  try {
    await accessPath(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function runRuntimeCommand(
  command: string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<RuntimeCommandResult> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: buildRuntimeCommandEnvironment(process.env, options.env.UV_PROJECT_ENVIRONMENT!),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

const RUNTIME_ENV_ALLOWLIST = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
] as const;

export function buildRuntimeCommandEnvironment(
  source: Record<string, string | undefined>,
  stagingDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of RUNTIME_ENV_ALLOWLIST) {
    if (source[key] !== undefined) env[key] = source[key]!;
  }
  env.UV_PROJECT_ENVIRONMENT = stagingDir;
  return env;
}

export function resolveUvExecutable(env: Record<string, string | undefined>): string {
  return env.UV_BIN ?? "uv";
}
