import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const REMEDIATION = "Run video-digest setup.";

export type RuntimeReadiness =
  | { status: "ready" }
  | { status: "missing"; remediation: string }
  | { status: "obsolete"; remediation: string };

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
