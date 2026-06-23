import { access, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

type LockOwner = {
  createdAt: string;
  pid: number;
  processIdentity: string;
  schemaVersion: "process-lock.v0";
  token: string;
};

export type ProcessLockFilesystem = {
  access(path: string): Promise<void>;
  mkdir(path: string): Promise<unknown>;
  lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readFile(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: boolean; recursive: boolean }): Promise<void>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  writeFile(path: string, contents: string): Promise<unknown>;
};

export type ProcessLockOptions = {
  filesystem?: ProcessLockFilesystem;
  getProcessIdentity?: (pid: number) => Promise<string | null>;
  lockDir: string;
  pid?: number;
  tokenFactory?: () => string;
};

export class ProcessLockError extends Error {
  constructor(public readonly code: "already-running" | "recovery-required", message: string) {
    super(message);
    this.name = "ProcessLockError";
  }
}

const defaultFilesystem: ProcessLockFilesystem = {
  access,
  mkdir,
  lstat,
  readFile: (path) => readFile(path, "utf8"),
  rename,
  rm,
  stat,
  writeFile,
};

export async function withProcessLock<T>(
  options: ProcessLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const filesystem = options.filesystem ?? defaultFilesystem;
  const pid = options.pid ?? process.pid;
  const token = (options.tokenFactory ?? (() => crypto.randomUUID()))();
  const getProcessIdentity = options.getProcessIdentity ?? defaultProcessIdentity;
  const processIdentity = await getProcessIdentity(pid);
  if (!processIdentity) {
    throw new ProcessLockError("recovery-required", "Could not establish process identity safely.");
  }
  const owner: LockOwner = {
    createdAt: new Date().toISOString(),
    pid,
    processIdentity,
    schemaVersion: "process-lock.v0",
    token,
  };

  await validateLockPathIfPresent(options.lockDir, filesystem);

  await acquireLock(options.lockDir, owner, filesystem, getProcessIdentity);
  try {
    await assertOwnership(options.lockDir, owner, filesystem);
    return await operation();
  } finally {
    await releaseLock(options.lockDir, owner, filesystem);
  }
}

async function acquireLock(
  lockDir: string,
  owner: LockOwner,
  filesystem: ProcessLockFilesystem,
  getProcessIdentity: (pid: number) => Promise<string | null>,
): Promise<void> {
  try {
    await filesystem.mkdir(lockDir);
    try {
      await publishOwner(lockDir, owner, filesystem);
    } catch (error) {
      await filesystem.rm(lockDir, { force: true, recursive: true });
      throw error;
    }
    return;
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
  await validateLockPathIfPresent(lockDir, filesystem);

  const claimDir = join(lockDir, "recovery-claim");
  if (await pathExists(claimDir, filesystem)) {
    await reclaimDeadClaim(claimDir, owner, filesystem, getProcessIdentity);
  }

  const current = await tryReadOwner(lockDir, filesystem);
  if (!current) {
    if (Date.now() - (await filesystem.stat(lockDir)).mtimeMs < 5 * 60_000) {
      throw new ProcessLockError("already-running", `Artifact Library lock is being published: ${lockDir}`);
    }
    await claimAndReplaceEmptyLock(lockDir, claimDir, owner, filesystem);
    return;
  }
  let currentIdentity: string | null;
  try {
    currentIdentity = await getProcessIdentity(current.pid);
  } catch {
    throw new ProcessLockError("already-running", `Library lock owner cannot be verified safely: ${lockDir}`);
  }
  if (currentIdentity === current.processIdentity) {
    throw new ProcessLockError("already-running", `Artifact Library is busy: ${lockDir}`);
  }

  try {
    await filesystem.mkdir(claimDir);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new ProcessLockError("already-running", `Artifact Library recovery is busy: ${lockDir}`);
    }
    throw error;
  }
  await publishOwner(claimDir, owner, filesystem);

  try {
    await validateLockPathIfPresent(lockDir, filesystem);
    const snapshot = await readOwner(lockDir, filesystem);
    if (snapshot.token !== current.token || snapshot.processIdentity !== current.processIdentity) {
      throw new ProcessLockError("already-running", `Artifact Library lock changed: ${lockDir}`);
    }
    await publishOwner(lockDir, owner, filesystem);
  } finally {
    await filesystem.rm(claimDir, { force: true, recursive: true });
  }
}

async function reclaimDeadClaim(
  claimDir: string,
  owner: LockOwner,
  filesystem: ProcessLockFilesystem,
  getProcessIdentity: (pid: number) => Promise<string | null>,
): Promise<void> {
  const claimOwner = await tryReadOwner(claimDir, filesystem);
  if (!claimOwner && Date.now() - (await filesystem.stat(claimDir)).mtimeMs < 5 * 60_000) {
    throw new ProcessLockError("already-running", `Artifact Library recovery is being published: ${claimDir}`);
  }
  if (claimOwner && await getProcessIdentity(claimOwner.pid) === claimOwner.processIdentity) {
    throw new ProcessLockError("already-running", `Artifact Library recovery is busy: ${claimDir}`);
  }
  const abandoned = `${claimDir}.abandoned-${owner.token}`;
  try {
    await filesystem.rename(claimDir, abandoned);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  await filesystem.rm(abandoned, { force: true, recursive: true });
}

async function claimAndReplaceEmptyLock(
  lockDir: string,
  claimDir: string,
  owner: LockOwner,
  filesystem: ProcessLockFilesystem,
): Promise<void> {
  try {
    await filesystem.mkdir(claimDir);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new ProcessLockError("already-running", `Artifact Library recovery is busy: ${lockDir}`);
    }
    throw error;
  }
  await publishOwner(claimDir, owner, filesystem);
  try {
    await validateLockPathIfPresent(lockDir, filesystem);
    if (await tryReadOwner(lockDir, filesystem)) {
      throw new ProcessLockError("already-running", `Artifact Library lock changed: ${lockDir}`);
    }
    await publishOwner(lockDir, owner, filesystem);
  } finally {
    await filesystem.rm(claimDir, { force: true, recursive: true });
  }
}

async function assertOwnership(
  lockDir: string,
  owner: LockOwner,
  filesystem: ProcessLockFilesystem,
): Promise<void> {
  if (await pathExists(join(lockDir, "recovery-claim"), filesystem)) {
    throw new ProcessLockError("recovery-required", `Library lock ownership was fenced: ${lockDir}`);
  }
  const current = await readOwner(lockDir, filesystem);
  if (current.token !== owner.token || current.processIdentity !== owner.processIdentity) {
    throw new ProcessLockError("recovery-required", `Library lock ownership was lost: ${lockDir}`);
  }
}

async function releaseLock(
  lockDir: string,
  owner: LockOwner,
  filesystem: ProcessLockFilesystem,
): Promise<void> {
  await assertOwnership(lockDir, owner, filesystem);
  const releaseDir = `${lockDir}.release-${owner.token}`;
  await validateLockPathIfPresent(lockDir, filesystem);
  await filesystem.rename(lockDir, releaseDir);
  try {
    await assertOwnership(releaseDir, owner, filesystem);
    await filesystem.rm(releaseDir, { force: true, recursive: true });
  } catch (error) {
    try {
      await filesystem.rename(releaseDir, lockDir);
    } catch {}
    throw error;
  }
}

async function publishOwner(
  directory: string,
  owner: LockOwner,
  filesystem: ProcessLockFilesystem,
): Promise<void> {
  const temporaryPath = join(directory, `owner.${owner.token}.tmp`);
  await filesystem.writeFile(temporaryPath, `${JSON.stringify(owner)}\n`);
  await filesystem.rename(temporaryPath, join(directory, "owner.json"));
}

async function readOwner(directory: string, filesystem: ProcessLockFilesystem): Promise<LockOwner> {
  const owner = await tryReadOwner(directory, filesystem);
  if (!owner) {
    throw new ProcessLockError("recovery-required", `Library lock owner is unreadable: ${directory}`);
  }
  return owner;
}

async function tryReadOwner(
  directory: string,
  filesystem: ProcessLockFilesystem,
): Promise<LockOwner | null> {
  let value: unknown;
  try {
    value = JSON.parse(await filesystem.readFile(join(directory, "owner.json")));
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw new ProcessLockError("recovery-required", `Library lock owner is unreadable: ${directory}`);
  }
  if (!isLockOwner(value)) {
    throw new ProcessLockError("recovery-required", `Library lock owner is malformed: ${directory}`);
  }
  return value;
}

function isLockOwner(value: unknown): value is LockOwner {
  if (typeof value !== "object" || value === null) return false;
  const owner = value as Partial<LockOwner>;
  return owner.schemaVersion === "process-lock.v0"
    && Number.isInteger(owner.pid)
    && typeof owner.processIdentity === "string"
    && typeof owner.token === "string"
    && typeof owner.createdAt === "string";
}

async function pathExists(path: string, filesystem: ProcessLockFilesystem): Promise<boolean> {
  try {
    await filesystem.access(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function validateLockPathIfPresent(
  lockDir: string,
  filesystem: ProcessLockFilesystem,
): Promise<void> {
  try {
    const lockStats = await filesystem.lstat(lockDir);
    if (lockStats.isSymbolicLink() || !lockStats.isDirectory()) {
      throw new ProcessLockError("recovery-required", `Library lock path is unsafe: ${lockDir}`);
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

async function defaultProcessIdentity(pid: number): Promise<string | null> {
  const child = Bun.spawn(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
    env: Object.fromEntries(
      ["PATH", "LANG", "LC_ALL"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []),
    ),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const identity = stdout.trim();
  return exitCode === 0 && identity ? `${pid}:${identity}` : null;
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
