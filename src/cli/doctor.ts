import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { MacOSKeychainCredentialStore, resolveProviderApiKey, type CredentialStore } from "./credentials";
import type { ResolvedDigestSelection } from "./digest-config";
import { getProviderProfile } from "../summarizer/providers";
import { resolveAppPaths } from "./app-paths";
import { resolvePackageResources } from "./package-resources";
import { inspectRuntime, resolveUvExecutable, type RuntimeReadiness } from "./runtime-manager";
import {
  PUBLIC_DOCTOR_CHECK_CAPABILITY,
  PUBLIC_DOCTOR_CHECK_ID,
  type PublicDoctorCapability,
  type PublicDoctorCheckId,
} from "./public-contract";

export type DoctorCapability = PublicDoctorCapability;

export type DoctorCheck = {
  capability: DoctorCapability;
  id: PublicDoctorCheckId;
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
  getStoredApiKey?: (provider: ResolvedDigestSelection["provider"]["effective"]) => Promise<string | null>;
  outputDir?: string;
  runtimeReadiness: () => Promise<RuntimeReadiness>;
  sidecarPath?: string;
  selection?: ResolvedDigestSelection;
  uvAvailable: (uvPath: string) => Promise<boolean>;
};

export async function defaultDoctor(
  credentialStore: CredentialStore = new MacOSKeychainCredentialStore(),
  outputDir = resolveAppPaths(homedir()).defaultArtifactLibrary,
  selection: ResolvedDigestSelection = {
    model: { effective: getProviderProfile("opencode").defaultModel, source: "default" },
    provider: { effective: "opencode", source: "default" },
  },
  env: Record<string, string | undefined> = process.env,
): Promise<DoctorReport> {
  const resources = resolvePackageResources(import.meta.url);
  const appPaths = resolveAppPaths(homedir());
  const lockContents = await readFile(resources.uvLock, "utf8");
  return buildDoctorReport({
    bunVersion: Bun.version,
    canWriteOutputDir: async (path) => isOutputDirectoryWritable(path),
    env,
    fileExists: async (path) => fileExists(path),
    getStoredApiKey: async (provider) => credentialStore.getApiKey(provider),
    outputDir,
    runtimeReadiness: async () => inspectRuntime(appPaths.runtimeDir, lockContents),
    sidecarPath: resources.sidecarScript,
    selection,
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
      capability: PUBLIC_DOCTOR_CHECK_CAPABILITY[PUBLIC_DOCTOR_CHECK_ID.bun],
      id: PUBLIC_DOCTOR_CHECK_ID.bun,
      message: `Bun runtime is available (${probe.bunVersion})`,
      remediation: null,
      status: "pass",
    },
    await uvCheck(probe, uvPath, readiness),
    await sidecarCheck(probe, sidecarPath),
    runtimeCheck(readiness),
    await digestProviderCheck(probe),
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
      capability: PUBLIC_DOCTOR_CHECK_CAPABILITY[PUBLIC_DOCTOR_CHECK_ID.pythonRuntime],
      id: PUBLIC_DOCTOR_CHECK_ID.pythonRuntime,
      message: "Managed Python runtime is ready",
      remediation: null,
      status: "pass",
    };
  }
  return {
    capability: PUBLIC_DOCTOR_CHECK_CAPABILITY[PUBLIC_DOCTOR_CHECK_ID.pythonRuntime],
    id: PUBLIC_DOCTOR_CHECK_ID.pythonRuntime,
    message: `Managed Python runtime is ${readiness.status}`,
    remediation: readiness.remediation,
    status: "fail",
  };
}

async function uvCheck(probe: DoctorProbe, uvPath: string, readiness: RuntimeReadiness): Promise<DoctorCheck> {
  const available = await probe.uvAvailable(uvPath);

  return available
    ? {
        capability: PUBLIC_DOCTOR_CHECK_CAPABILITY[PUBLIC_DOCTOR_CHECK_ID.uv],
        id: PUBLIC_DOCTOR_CHECK_ID.uv,
        message: uvPath === "uv" ? "uv is available" : `uv is available at ${uvPath}`,
        remediation: null,
        status: "pass",
      }
    : {
        capability: PUBLIC_DOCTOR_CHECK_CAPABILITY[PUBLIC_DOCTOR_CHECK_ID.uv],
        id: PUBLIC_DOCTOR_CHECK_ID.uv,
        message: `${uvPath} is not available`,
        remediation: "Install uv, source $HOME/.local/bin/env, or set UV_BIN.",
        status: readiness.status === "ready" ? "warn" : "fail",
      };
}

async function sidecarCheck(probe: DoctorProbe, sidecarPath: string): Promise<DoctorCheck> {
  const exists = await probe.fileExists(sidecarPath);

  return exists
    ? {
        capability: PUBLIC_DOCTOR_CHECK_CAPABILITY[PUBLIC_DOCTOR_CHECK_ID.pythonSidecar],
        id: PUBLIC_DOCTOR_CHECK_ID.pythonSidecar,
        message: "Python transcript sidecar exists",
        remediation: null,
        status: "pass",
      }
    : {
        capability: PUBLIC_DOCTOR_CHECK_CAPABILITY[PUBLIC_DOCTOR_CHECK_ID.pythonSidecar],
        id: PUBLIC_DOCTOR_CHECK_ID.pythonSidecar,
        message: `${sidecarPath} is not available`,
        remediation: "Restore python/fetch_transcript.py.",
        status: "fail",
      };
}

async function digestProviderCheck(probe: DoctorProbe): Promise<DoctorCheck> {
  const selection = probe.selection ?? {
    model: { effective: getProviderProfile("opencode").defaultModel, source: "default" as const },
    provider: { effective: "opencode" as const, source: "default" as const },
  };
  const profile = getProviderProfile(selection.provider.effective);
  const stored = await probe.getStoredApiKey?.(selection.provider.effective) ?? null;
  const credential = await resolveProviderApiKey({
    env: probe.env,
    provider: selection.provider.effective,
    store: { deleteApiKey: async () => {}, getApiKey: async () => stored, setApiKey: async () => {} },
  });
  const configured = credential.source !== "missing";
  return {
    capability: PUBLIC_DOCTOR_CHECK_CAPABILITY[PUBLIC_DOCTOR_CHECK_ID.digestProvider],
    id: PUBLIC_DOCTOR_CHECK_ID.digestProvider,
    message: configured
      ? `${profile.displayName} (${selection.model.effective}) credential is configured via ${credential.source}`
      : `${profile.displayName} (${selection.model.effective}) credential is missing; digest generation is unavailable`,
    remediation: configured ? null : `Set ${profile.credentialEnv} or save the ${profile.displayName} API key. Transcript mode works without it.`,
    status: configured ? "pass" : "warn",
  };
}

async function outputDirCheck(probe: DoctorProbe, outputDir: string): Promise<DoctorCheck> {
  const writable = await probe.canWriteOutputDir(outputDir);

  return writable
    ? {
        capability: PUBLIC_DOCTOR_CHECK_CAPABILITY[PUBLIC_DOCTOR_CHECK_ID.outputDir],
        id: PUBLIC_DOCTOR_CHECK_ID.outputDir,
        message: "Output directory is writable or can be created",
        remediation: null,
        status: "pass",
      }
    : {
        capability: PUBLIC_DOCTOR_CHECK_CAPABILITY[PUBLIC_DOCTOR_CHECK_ID.outputDir],
        id: PUBLIC_DOCTOR_CHECK_ID.outputDir,
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

export async function isOutputDirectoryWritable(
  outputDir: string,
  accessPath: (path: string, mode?: number) => Promise<void> = access,
): Promise<boolean> {
  let candidate = outputDir;
  while (true) {
    try {
      const metadata = await stat(candidate);
      if (candidate === outputDir && !metadata.isDirectory()) return false;
      await accessPath(candidate, constants.W_OK | constants.X_OK);
      return metadata.isDirectory();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return false;
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}
