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
  filesystem?: RuntimeFilesystem;
  lockContents: string;
  pythonDir: string;
  runner?: RuntimeCommandRunner;
  runtimeDir: string;
  uvPath: string;
};

export type RuntimeFilesystem = {
  access: typeof access;
  mkdir: typeof mkdir;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
};

const defaultRuntimeFilesystem: RuntimeFilesystem = { access, mkdir, rename, rm, writeFile };

export async function prepareRuntime(input: PrepareRuntimeInput): Promise<void> {
  const stagingDir = `${input.runtimeDir}.staging`;
  const backupDir = `${input.runtimeDir}.backup`;
  const runner = input.runner ?? runRuntimeCommand;
  const filesystem = input.filesystem ?? defaultRuntimeFilesystem;

  await filesystem.mkdir(dirname(input.runtimeDir), { recursive: true });
  await Promise.all([
    filesystem.rm(stagingDir, { force: true, recursive: true }),
    filesystem.rm(backupDir, { force: true, recursive: true }),
  ]);

  try {
    const result = await runner(
      [input.uvPath, "sync", "--frozen", "--python", "3.12", "--project", input.pythonDir],
      { cwd: input.pythonDir, env: { UV_PROJECT_ENVIRONMENT: stagingDir } },
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `uv sync failed with exit code ${result.exitCode}`);
    }

    await filesystem.writeFile(runtimeMarkerPath(stagingDir), expectedRuntimeMarker(input.lockContents));
    const hadRuntime = await pathExists(input.runtimeDir, filesystem.access);
    if (hadRuntime) {
      await filesystem.rename(input.runtimeDir, backupDir);
    }
    try {
      await filesystem.rename(stagingDir, input.runtimeDir);
    } catch (error) {
      if (hadRuntime) {
        await filesystem.rename(backupDir, input.runtimeDir);
      }
      throw error;
    }
    await filesystem.rm(backupDir, { force: true, recursive: true });
  } finally {
    await filesystem.rm(stagingDir, { force: true, recursive: true });
  }
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
    env: { ...process.env, ...options.env },
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
