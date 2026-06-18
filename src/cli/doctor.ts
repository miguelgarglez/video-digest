import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { MacOSKeychainCredentialStore, type CredentialStore } from "./credentials";
import { resolveAppPaths } from "./app-paths";
import { resolvePackageResources } from "./package-resources";
import { inspectRuntime, resolveUvExecutable, type RuntimeReadiness } from "./runtime-manager";

export type DoctorCapability = "transcript" | "digest";

export type DoctorCheck = {
  capability: DoctorCapability;
  id: string;
  message: string;
  remediation: string | null;
  status: "pass" | "warn" | "fail";
};

export type DoctorReport = {
  checks: DoctorCheck[];
  ok: boolean;
};

export type DoctorProbe = {
  bunVersion: string;
  canWriteOutputDir: (outputDir: string) => Promise<boolean>;
  env: Record<string, string | undefined>;
  fileExists: (path: string) => Promise<boolean>;
  getStoredOpenCodeApiKey?: () => Promise<string | null>;
  outputDir?: string;
  runtimeReadiness: () => Promise<RuntimeReadiness>;
  sidecarPath?: string;
  uvAvailable: (uvPath: string) => Promise<boolean>;
};

export async function defaultDoctor(
  credentialStore: CredentialStore = new MacOSKeychainCredentialStore(),
  outputDir = resolveAppPaths(homedir()).defaultArtifactLibrary,
): Promise<DoctorReport> {
  const resources = resolvePackageResources(import.meta.url);
  const appPaths = resolveAppPaths(homedir());
  const lockContents = await readFile(resources.uvLock, "utf8");
  return buildDoctorReport({
    bunVersion: Bun.version,
    canWriteOutputDir: async (path) => isOutputDirectoryWritable(path),
    env: process.env,
    fileExists: async (path) => fileExists(path),
    getStoredOpenCodeApiKey: async () => credentialStore.getOpenCodeApiKey(),
    outputDir,
    runtimeReadiness: async () => inspectRuntime(appPaths.runtimeDir, lockContents),
    sidecarPath: resources.sidecarScript,
    uvAvailable: async (uvPath) => uvAvailable(uvPath),
  });
}

export async function buildDoctorReport(probe: DoctorProbe): Promise<DoctorReport> {
  const outputDir = probe.outputDir ?? probe.env.VIDEO_DIGEST_OUTPUT_DIR ?? "outputs";
  const uvPath = resolveUvExecutable(probe.env);
  const sidecarPath = probe.sidecarPath ?? join(import.meta.dir, "../../python/fetch_transcript.py");
  const readiness = await probe.runtimeReadiness();
  const checks: DoctorCheck[] = [
    {
      capability: "transcript",
      id: "bun",
      message: `Bun runtime is available (${probe.bunVersion})`,
      remediation: null,
      status: "pass",
    },
    await uvCheck(probe, uvPath, readiness),
    await sidecarCheck(probe, sidecarPath),
    runtimeCheck(readiness),
    await opencodeCheck(probe),
    await outputDirCheck(probe, outputDir),
  ];

  return {
    checks,
    ok: checks.every((check) => check.status !== "fail"),
  };
}

function runtimeCheck(readiness: RuntimeReadiness): DoctorCheck {
  if (readiness.status === "ready") {
    return {
      capability: "transcript",
      id: "python-runtime",
      message: "Managed Python runtime is ready",
      remediation: null,
      status: "pass",
    };
  }
  return {
    capability: "transcript",
    id: "python-runtime",
    message: `Managed Python runtime is ${readiness.status}`,
    remediation: readiness.remediation,
    status: "fail",
  };
}

async function uvCheck(probe: DoctorProbe, uvPath: string, readiness: RuntimeReadiness): Promise<DoctorCheck> {
  const available = await probe.uvAvailable(uvPath);

  return available
    ? {
        capability: "transcript",
        id: "uv",
        message: uvPath === "uv" ? "uv is available" : `uv is available at ${uvPath}`,
        remediation: null,
        status: "pass",
      }
    : {
        capability: "transcript",
        id: "uv",
        message: `${uvPath} is not available`,
        remediation: "Install uv, source $HOME/.local/bin/env, or set UV_BIN.",
        status: readiness.status === "ready" ? "warn" : "fail",
      };
}

async function sidecarCheck(probe: DoctorProbe, sidecarPath: string): Promise<DoctorCheck> {
  const exists = await probe.fileExists(sidecarPath);

  return exists
    ? {
        capability: "transcript",
        id: "python-sidecar",
        message: "Python transcript sidecar exists",
        remediation: null,
        status: "pass",
      }
    : {
        capability: "transcript",
        id: "python-sidecar",
        message: `${sidecarPath} is not available`,
        remediation: "Restore python/fetch_transcript.py.",
        status: "fail",
      };
}

async function opencodeCheck(probe: DoctorProbe): Promise<DoctorCheck> {
  if (probe.env.OPENCODE_API_KEY) {
    return {
      capability: "digest",
      id: "opencode-api-key",
      message: "OPENCODE_API_KEY is configured via env; digest generation is available",
      remediation: null,
      status: "pass",
    };
  }

  if (await probe.getStoredOpenCodeApiKey?.()) {
    return {
      capability: "digest",
      id: "opencode-api-key",
      message: "OPENCODE_API_KEY is configured via Keychain; digest generation is available",
      remediation: null,
      status: "pass",
    };
  }

  return {
    capability: "digest",
    id: "opencode-api-key",
    message: "OPENCODE_API_KEY is missing; digest generation is unavailable",
    remediation: "Set OPENCODE_API_KEY to enable video-digest ingest. Transcript mode works without it.",
    status: "warn",
  };
}

async function outputDirCheck(probe: DoctorProbe, outputDir: string): Promise<DoctorCheck> {
  const writable = await probe.canWriteOutputDir(outputDir);

  return writable
    ? {
        capability: "transcript",
        id: "output-dir",
        message: "Output directory is writable or can be created",
        remediation: null,
        status: "pass",
      }
    : {
        capability: "transcript",
        id: "output-dir",
        message: `Output directory is not writable at ${outputDir}`,
        remediation: "Choose a writable VIDEO_DIGEST_OUTPUT_DIR.",
        status: "fail",
      };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function uvAvailable(uvPath: string): Promise<boolean> {
  try {
    const process = Bun.spawn([uvPath, "--version"], { stderr: "pipe", stdout: "pipe" });
    return (await process.exited) === 0;
  } catch {
    return false;
  }
}

export async function isOutputDirectoryWritable(outputDir: string): Promise<boolean> {
  let candidate = outputDir;
  while (true) {
    try {
      const metadata = await stat(candidate);
      if (candidate === outputDir && !metadata.isDirectory()) return false;
      await access(candidate, constants.W_OK);
      return metadata.isDirectory();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return false;
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}
