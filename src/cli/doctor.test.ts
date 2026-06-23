import { describe, expect, test } from "bun:test";
import { buildDoctorReport, isOutputDirectoryWritable } from "./doctor";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants } from "node:fs";

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

  test.each([
    ["ready", "warn", true],
    ["missing", "fail", false],
  ] as const)("reports missing uv as %s when runtime is %s", async (runtimeStatus, uvStatus, ok) => {
    const readiness = runtimeStatus === "ready" ? { status: "ready" as const } : { status: "missing" as const, remediation: "Run video-digest setup." };
    const report = await buildDoctorReport({ bunVersion: "1", canWriteOutputDir: async () => true, env: { UV_BIN: "/invalid/uv" }, fileExists: async () => true, runtimeReadiness: async () => readiness, uvAvailable: async (path) => { expect(path).toBe("/invalid/uv"); return false; } });
    expect(report.checks.find((check) => check.id === "uv")?.status).toBe(uvStatus);
    expect(report.checks.find((check) => check.id === "uv")?.message).toBe("/invalid/uv is not available");
    expect(report.ok).toBe(ok);
  });

  test("checks the exact effective artifact library path", async () => {
    const paths: string[] = [];
    await buildDoctorReport({ bunVersion: "1", canWriteOutputDir: async (path) => { paths.push(path); return true; }, env: {}, fileExists: async () => true, outputDir: "/effective/library", runtimeReadiness: async () => ({ status: "ready" }), uvAvailable: async () => true });
    expect(paths).toEqual(["/effective/library"]);
  });
});

describe("isOutputDirectoryWritable", () => {
  test("rejects an existing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctor-output-")); const file = join(root, "file"); await writeFile(file, "x");
    await expect(isOutputDirectoryWritable(file)).resolves.toBe(false);
  });
  test("walks to the nearest existing writable ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctor-output-")); await mkdir(join(root, "parent"));
    await expect(isOutputDirectoryWritable(join(root, "parent", "missing", "nested"))).resolves.toBe(true);
  });
  test("requires write and search access on an existing directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctor-output-")); const modes: number[] = [];
    await expect(isOutputDirectoryWritable(root, async (_path, mode) => { modes.push(mode!); })).resolves.toBe(true);
    expect(modes).toEqual([constants.W_OK | constants.X_OK]);
  });
  test("rejects a write-only directory without search access", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctor-output-"));
    await expect(isOutputDirectoryWritable(root, async (_path, mode) => {
      expect(mode).toBe(constants.W_OK | constants.X_OK);
      const error = new Error("not searchable") as NodeJS.ErrnoException; error.code = "EACCES"; throw error;
    })).resolves.toBe(false);
  });
});
