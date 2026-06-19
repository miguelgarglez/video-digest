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
  getProcessIdentity?: (pid: number) => Promise<string | null>;
  idFactory?: () => string;
  lockContents: string;
  pythonDir: string;
  pid?: number;
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

type SetupLockOwner = { schemaVersion: "runtime-setup-lock.v2"; pid: number; processIdentity: string; token: string; stagingDir: string; backupDir: string; createdAt: string };

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
  const getProcessIdentity = input.getProcessIdentity ?? defaultProcessIdentity;

  await filesystem.mkdir(dirname(input.runtimeDir), { recursive: true });
  const createdAt = clock().toISOString();
  const processIdentity = await getProcessIdentity(pid);
  if (!processIdentity) throw new RuntimeSetupError("recovery-required", "Could not establish setup process identity safely.");
  const owner: SetupLockOwner = { schemaVersion: "runtime-setup-lock.v2", pid, processIdentity, token: id, stagingDir, backupDir, createdAt };
  await acquireSetupLock({ clock, filesystem, getProcessIdentity, lockDir, lockContents: input.lockContents, owner, runtimeDir: input.runtimeDir });

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
    await assertLockOwnership(lockDir, owner);
    const hadRuntime = await pathExists(input.runtimeDir, filesystem.access);
    if (hadRuntime) {
      await filesystem.rename(input.runtimeDir, backupDir);
      backupCreated = true;
    }
    try {
      await assertLockOwnership(lockDir, owner);
      await filesystem.rename(stagingDir, input.runtimeDir);
    } catch (error) {
      if (hadRuntime) {
        try {
          await assertLockOwnership(lockDir, owner);
          await filesystem.rename(backupDir, input.runtimeDir);
          backupConsumed = true;
        } catch {
          throw new RuntimeSetupError("recovery-required", `Runtime recovery is required. Existing runtime backup preserved at ${backupDir}`);
        }
      }
      throw error;
    }
    if ((await inspectRuntime(input.runtimeDir, input.lockContents)).status !== "ready") {
      await assertLockOwnership(lockDir, owner);
      await filesystem.rm(input.runtimeDir, { force: true, recursive: true });
      if (hadRuntime) {
        try {
          await assertLockOwnership(lockDir, owner);
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
    await releaseOwnedLock(filesystem, lockDir, owner);
  }
}

async function acquireSetupLock(input: { clock: () => Date; filesystem: RuntimeFilesystem; getProcessIdentity: (pid: number) => Promise<string | null>; lockDir: string; lockContents: string; owner: SetupLockOwner; runtimeDir: string }): Promise<void> {
  while (true) {
    try {
      await input.filesystem.mkdir(input.lockDir);
      try { await publishOwner(input.filesystem, input.lockDir, input.owner); }
      catch (error) { await input.filesystem.rm(input.lockDir, { force: true, recursive: true }); throw error; }
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const recoveryClaim = join(input.lockDir, "recovery-claim");
    if (await pathExists(recoveryClaim, input.filesystem.access)) {
      const recoveryRequired = await pathExists(join(recoveryClaim, "recovery-required"), input.filesystem.access);
      throw new RuntimeSetupError(recoveryRequired ? "recovery-required" : "already-running", recoveryRequired
        ? `Runtime setup recovery is required. Inspect ${input.lockDir}`
        : "Runtime setup recovery is already in progress.");
    }
    let owner: SetupLockOwner | null = null;
    let missing = false;
    try {
      const parsed = JSON.parse(await readFile(join(input.lockDir, "owner.json"), "utf8"));
      if (!isValidOwner(parsed, input.runtimeDir)) throw new Error("malformed-owner");
      owner = parsed;
    } catch (error) {
      missing = isMissingPathError(error);
      if (!missing) {
        if (!(await acquireRecoveryClaim(input.filesystem, recoveryClaim))) continue;
        await input.filesystem.writeFile(join(recoveryClaim, "recovery-required"), `Manual recovery required for ${input.lockDir}`);
        throw new RuntimeSetupError("recovery-required", `Runtime setup recovery is required. Inspect ${input.lockDir}`);
      }
    }
    if (owner) {
      let currentIdentity: string | null;
      try { currentIdentity = await input.getProcessIdentity(owner.pid); }
      catch { throw new RuntimeSetupError("already-running", "Runtime setup is already in progress; owner identity could not be verified safely."); }
      if (currentIdentity === owner.processIdentity) throw new RuntimeSetupError("already-running", "Runtime setup is already in progress.");
    }
    if (missing) {
      const age = input.clock().getTime() - (await stat(input.lockDir)).mtimeMs;
      if (age < 5 * 60_000) throw new RuntimeSetupError("already-running", "Runtime setup is already in progress.");
    }
    if (!(await acquireRecoveryClaim(input.filesystem, recoveryClaim))) continue;
    if (owner) {
      let snapshot: unknown;
      try { snapshot = JSON.parse(await readFile(join(input.lockDir, "owner.json"), "utf8")); } catch { snapshot = null; }
      if (!isValidOwner(snapshot, input.runtimeDir) || snapshot.token !== owner.token || snapshot.processIdentity !== owner.processIdentity) {
        await input.filesystem.rm(recoveryClaim, { force: true, recursive: true });
        continue;
      }
      await recoverClaimedLock({ ...input, owner });
    } else {
      try {
        await readFile(join(input.lockDir, "owner.json"), "utf8");
        await input.filesystem.rm(recoveryClaim, { force: true, recursive: true });
        continue;
      } catch (error) {
        if (!isMissingPathError(error)) {
          await input.filesystem.writeFile(join(recoveryClaim, "recovery-required"), `Manual recovery required for ${input.lockDir}`);
          throw new RuntimeSetupError("recovery-required", `Runtime setup recovery is required. Inspect ${input.lockDir}`);
        }
      }
    }
    await input.filesystem.rm(input.lockDir, { force: true, recursive: true });
  }
}

async function recoverClaimedLock(input: { filesystem: RuntimeFilesystem; lockContents: string; owner: SetupLockOwner; runtimeDir: string }): Promise<void> {
  await input.filesystem.rm(input.owner.stagingDir, { force: true, recursive: true });
  if (await pathExists(input.owner.backupDir, input.filesystem.access)) {
    const readiness = await inspectRuntime(input.runtimeDir, input.lockContents);
    if (readiness.status === "ready") {
      await input.filesystem.rm(input.owner.backupDir, { force: true, recursive: true });
    } else {
      await input.filesystem.rm(input.runtimeDir, { force: true, recursive: true });
      await input.filesystem.rename(input.owner.backupDir, input.runtimeDir);
    }
  }
}

async function acquireRecoveryClaim(filesystem: RuntimeFilesystem, recoveryClaim: string): Promise<boolean> {
  try { await filesystem.mkdir(recoveryClaim); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") return false; throw error; }
}

function isValidOwner(value: unknown, runtimeDir: string): value is SetupLockOwner {
  if (typeof value !== "object" || value === null) return false;
  const owner = value as Partial<SetupLockOwner>;
  return owner.schemaVersion === "runtime-setup-lock.v2" && Number.isInteger(owner.pid) && typeof owner.processIdentity === "string" && typeof owner.token === "string"
    && owner.stagingDir === `${runtimeDir}.staging-${owner.token}` && owner.backupDir === `${runtimeDir}.backup-${owner.token}`
    && typeof owner.createdAt === "string";
}

async function publishOwner(filesystem: RuntimeFilesystem, lockDir: string, owner: SetupLockOwner): Promise<void> {
  const temp = join(lockDir, `owner.${owner.token}.tmp`);
  await filesystem.writeFile(temp, JSON.stringify(owner));
  await filesystem.rename(temp, join(lockDir, "owner.json"));
}

async function assertLockOwnership(lockDir: string, owner: SetupLockOwner): Promise<void> {
  try {
    await access(join(lockDir, "recovery-claim"));
    throw new Error("recovery in progress");
  } catch (error) {
    if (!isMissingPathError(error)) throw new RuntimeSetupError("recovery-required", `Runtime setup lock ownership was lost. Inspect ${lockDir}`);
  }
  try {
    const current = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")) as Partial<SetupLockOwner>;
    if (current.token === owner.token && current.processIdentity === owner.processIdentity) return;
  } catch {}
  throw new RuntimeSetupError("recovery-required", `Runtime setup lock ownership was lost. Inspect ${lockDir}`);
}

async function releaseOwnedLock(filesystem: RuntimeFilesystem, lockDir: string, owner: SetupLockOwner): Promise<void> {
  await assertLockOwnership(lockDir, owner);
  const releaseDir = `${lockDir}.release-${owner.token}`;
  try { await filesystem.rename(lockDir, releaseDir); }
  catch { throw new RuntimeSetupError("recovery-required", `Runtime setup lock ownership was lost. Inspect ${lockDir}`); }
  try {
    await assertLockOwnership(releaseDir, owner);
  } catch {
    try { await filesystem.rename(releaseDir, lockDir); } catch {}
    throw new RuntimeSetupError("recovery-required", `Runtime setup lock changed during release. Inspect ${releaseDir}`);
  }
  await filesystem.rm(releaseDir, { force: true, recursive: true });
}

async function defaultProcessIdentity(pid: number): Promise<string | null> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "LANG", "LC_ALL"] as const) if (process.env[key]) env[key] = process.env[key]!;
  const child = Bun.spawn(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const identity = stdout.trim();
  return exitCode === 0 && identity ? `${pid}:${identity}` : null;
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
