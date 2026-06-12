import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { MacOSKeychainCredentialStore, type CredentialStore } from "./credentials";

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
  uvAvailable: (uvPath: string) => Promise<boolean>;
};

export async function defaultDoctor(
  credentialStore: CredentialStore = new MacOSKeychainCredentialStore(),
): Promise<DoctorReport> {
  return buildDoctorReport({
    bunVersion: Bun.version,
    canWriteOutputDir: async (outputDir) => directoryWritableOrCreatable(outputDir),
    env: process.env,
    fileExists: async (path) => fileExists(path),
    getStoredOpenCodeApiKey: async () => credentialStore.getOpenCodeApiKey(),
    uvAvailable: async (uvPath) => uvAvailable(uvPath),
  });
}

export async function buildDoctorReport(probe: DoctorProbe): Promise<DoctorReport> {
  const outputDir = probe.env.VIDEO_DIGEST_OUTPUT_DIR ?? "outputs";
  const uvPath = probe.env.UV_BIN ?? (probe.env.HOME ? `${probe.env.HOME}/.local/bin/uv` : "uv");
  const sidecarPath = join(import.meta.dir, "../../python/fetch_transcript.py");
  const checks: DoctorCheck[] = [
    {
      capability: "transcript",
      id: "bun",
      message: `Bun runtime is available (${probe.bunVersion})`,
      remediation: null,
      status: "pass",
    },
    await uvCheck(probe, uvPath),
    await sidecarCheck(probe, sidecarPath),
    await opencodeCheck(probe),
    await outputDirCheck(probe, outputDir),
  ];

  return {
    checks,
    ok: checks.every((check) => check.status !== "fail"),
  };
}

async function uvCheck(probe: DoctorProbe, uvPath: string): Promise<DoctorCheck> {
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
        message: `${uvPath} is not available and uv is not on PATH`,
        remediation: "Install uv, source $HOME/.local/bin/env, or set UV_BIN.",
        status: "fail",
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
  if (await fileExists(uvPath)) {
    return true;
  }

  const process = Bun.spawn(["uv", "--version"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  return (await process.exited) === 0;
}

async function directoryWritableOrCreatable(outputDir: string): Promise<boolean> {
  try {
    await access(outputDir, constants.W_OK);
    return true;
  } catch {
    try {
      await access(".", constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}
