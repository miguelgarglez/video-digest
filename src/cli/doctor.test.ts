import { describe, expect, test } from "bun:test";
import { buildDoctorReport } from "./doctor";

describe("buildDoctorReport", () => {
  test("reports transcript readiness separately from digest readiness", async () => {
    const report = await buildDoctorReport({
      bunVersion: "1.3.14",
      canWriteOutputDir: async () => true,
      env: {},
      fileExists: async (path) => path.includes("fetch_transcript.py"),
      runtimeReadiness: async () => ({ status: "ready" }),
      uvAvailable: async () => true,
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual([
      {
        capability: "transcript",
        id: "bun",
        message: "Bun runtime is available (1.3.14)",
        remediation: null,
        status: "pass",
      },
      {
        capability: "transcript",
        id: "uv",
        message: "uv is available",
        remediation: null,
        status: "pass",
      },
      {
        capability: "transcript",
        id: "python-sidecar",
        message: "Python transcript sidecar exists",
        remediation: null,
        status: "pass",
      },
      {
        capability: "transcript",
        id: "python-runtime",
        message: "Managed Python runtime is ready",
        remediation: null,
        status: "pass",
      },
      {
        capability: "digest",
        id: "opencode-api-key",
        message: "OPENCODE_API_KEY is missing; digest generation is unavailable",
        remediation: "Set OPENCODE_API_KEY to enable video-digest ingest. Transcript mode works without it.",
        status: "warn",
      },
      {
        capability: "transcript",
        id: "output-dir",
        message: "Output directory is writable or can be created",
        remediation: null,
        status: "pass",
      },
    ]);
  });

  test("reports digest readiness when key is stored outside env", async () => {
    const report = await buildDoctorReport({
      bunVersion: "1.3.14",
      canWriteOutputDir: async () => true,
      env: {},
      fileExists: async (path) => path.includes("fetch_transcript.py"),
      getStoredOpenCodeApiKey: async () => "stored-key",
      runtimeReadiness: async () => ({ status: "ready" }),
      uvAvailable: async () => true,
    });

    expect(report.checks.find((check) => check.id === "opencode-api-key")).toEqual({
      capability: "digest",
      id: "opencode-api-key",
      message: "OPENCODE_API_KEY is configured via Keychain; digest generation is available",
      remediation: null,
      status: "pass",
    });
    expect(JSON.stringify(report)).not.toContain("stored-key");
  });

  test.each(["missing", "obsolete"] as const)("distinguishes a %s managed Python runtime", async (status) => {
    const report = await buildDoctorReport({
      bunVersion: "1.3.14",
      canWriteOutputDir: async () => true,
      env: {},
      fileExists: async () => true,
      runtimeReadiness: async () => ({ status, remediation: "Run video-digest setup." }),
      uvAvailable: async () => true,
    });

    expect(report.checks.find((check) => check.id === "python-runtime")).toEqual({
      capability: "transcript",
      id: "python-runtime",
      message: `Managed Python runtime is ${status}`,
      remediation: "Run video-digest setup.",
      status: "fail",
    });
    expect(report.ok).toBe(false);
  });
});
