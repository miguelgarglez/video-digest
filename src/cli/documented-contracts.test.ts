import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchTranscriptOnlyResult } from "../ingestion/transcript-only";
import type { IngestVideoResult } from "../ingestion/ingest-video";
import { TranscriptSourceError } from "../transcript/transcript-source";
import type { CliDependencies, CliIO } from "./main";
import { runCli } from "./main";
import type { DoctorReport } from "./doctor";
import {
  PUBLIC_CLI_ERROR_CODES,
  PUBLIC_CLI_EXIT_CODES,
  PUBLIC_CLI_SCHEMA_VERSIONS,
  PUBLIC_DOCTOR_CHECK_CAPABILITY,
  PUBLIC_DOCTOR_CHECK_IDS,
  type PublicCliExitCode,
} from "./public-contract";

const JSON_CONTRACTS = "docs/cli/json-contracts.md";
const EXIT_CODES = "docs/cli/exit-codes.md";
const COMPATIBILITY = "docs/cli/compatibility.md";
const VIDEO_ID = "1ZgUcrR0K7I";
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

type CapturedCliResult = {
  exitCode: PublicCliExitCode;
  payload: unknown;
  stderr: string[];
  stdout: string[];
  writes: string[];
};

describe("public CLI documentation contracts", () => {
  test("binds every JSON command surface to a stable tagged fixture emitted by runCli", async () => {
    const docs = await readFile(JSON_CONTRACTS, "utf8");
    const base = baseDependencies();
    const scenarios: Array<{
      args: string[];
      dependencies?: CliDependencies;
      exitCode: PublicCliExitCode;
      fixture: string;
    }> = [
      {
        args: ["ingest", VIDEO_URL, "--json"],
        dependencies: { ...base, env: { OPENCODE_API_KEY: "test-value" }, ingestVideo: async () => completedIngestion() },
        exitCode: 0,
        fixture: "ingest-success",
      },
      {
        args: ["ingest", VIDEO_URL, "--json"],
        dependencies: {
          ...base,
          env: { OPENCODE_API_KEY: "test-value" },
          ingestVideo: async () => {
            throw new TranscriptSourceError(
              "transcript-unavailable",
              "Could not retrieve transcript\nThis is most likely caused by:\n\nSubtitles are disabled",
            );
          },
        },
        exitCode: 2,
        fixture: "ingest-failure",
      },
      {
        args: ["ingest", VIDEO_URL, "--json"],
        dependencies: { ...base, env: { OPENCODE_API_KEY: "test-value" }, ingestVideo: async () => unusableIngestion() },
        exitCode: 2,
        fixture: "ingest-unusable",
      },
      {
        args: ["transcript", VIDEO_URL, "--json"],
        dependencies: { ...base, fetchTranscriptOnly: async () => completedTranscript() },
        exitCode: 0,
        fixture: "transcript-success",
      },
      {
        args: ["transcript", VIDEO_URL, "--json"],
        dependencies: {
          ...base,
          runtimeManager: {
            inspect: async () => ({ remediation: "Run video-digest setup.", status: "missing" }),
            prepare: async () => {},
          },
        },
        exitCode: 1,
        fixture: "transcript-failure",
      },
      {
        args: ["setup", "--yes", "--json"],
        dependencies: base,
        exitCode: 0,
        fixture: "setup-success",
      },
      {
        args: ["setup", "--json"],
        dependencies: base,
        exitCode: 1,
        fixture: "setup-failure",
      },
      {
        args: ["config", "get", "--json"],
        dependencies: base,
        exitCode: 0,
        fixture: "config-get-success",
      },
      {
        args: ["config", "set", "output-dir", "/artifact-library", "--json"],
        dependencies: base,
        exitCode: 0,
        fixture: "config-set-success",
      },
      {
        args: ["config", "unset", "api-key", "--provider", "opencode", "--json"],
        dependencies: base,
        exitCode: 0,
        fixture: "config-unset-success",
      },
      {
        args: ["config", "set", "api-key", "--provider", "opencode", "--json"],
        dependencies: base,
        exitCode: 1,
        fixture: "config-failure",
      },
      {
        args: ["doctor", "--json"],
        dependencies: { ...base, doctor: async () => doctorReport(true) },
        exitCode: 0,
        fixture: "doctor-success",
      },
      {
        args: ["doctor", "--json"],
        dependencies: { ...base, doctor: async () => doctorReport(false) },
        exitCode: 1,
        fixture: "doctor-failure",
      },
      {
        args: ["transcript", VIDEO_URL, "--json", "--stdout"],
        dependencies: base,
        exitCode: 1,
        fixture: "invocation-failure",
      },
    ];

    for (const scenario of scenarios) {
      const actual = await captureJson(scenario.args, scenario.dependencies ?? base);
      expect(actual.exitCode, scenario.fixture).toBe(scenario.exitCode);
      expect(actual.stdout, scenario.fixture).toHaveLength(1);
      expect(actual.stderr, scenario.fixture).toEqual([]);
      expect(actual.writes, scenario.fixture).toEqual([]);
      expect(actual.payload, scenario.fixture).toEqual(documentedFixture(docs, scenario.fixture));
    }

    const library = await createLibraryFixture();
    try {
      const libraryDependencies: CliDependencies = {
        ...base,
        appPaths: { ...base.appPaths!, defaultArtifactLibrary: library },
      };
      const libraryScenarios = [
        { args: ["list", "--json"], exitCode: 0, fixture: "list-success" },
        { args: ["open", VIDEO_ID, "--json"], exitCode: 0, fixture: "open-success" },
        { args: ["open", "AAAAAAAAAAA", "--json"], exitCode: 1, fixture: "open-failure" },
      ] as const;

      for (const scenario of libraryScenarios) {
        const actual = await captureJson([...scenario.args], libraryDependencies);
        expect(actual.exitCode, scenario.fixture).toBe(scenario.exitCode);
        expect(actual.stdout, scenario.fixture).toHaveLength(1);
        expect(actual.stderr, scenario.fixture).toEqual([]);
        expect(actual.writes, scenario.fixture).toEqual([]);
        expect(normalizeRoot(actual.payload, library), scenario.fixture)
          .toEqual(documentedFixture(docs, scenario.fixture));
      }

      const failedList = await captureJson(["list", "--json"], {
        ...libraryDependencies,
        withRecoveredOutputLibrary: async () => {
          throw new Error("Artifact Library could not be read.");
        },
      });
      expect(failedList.exitCode).toBe(1);
      expect(failedList.stdout).toHaveLength(1);
      expect(failedList.stderr).toEqual([]);
      expect(failedList.payload).toEqual(documentedFixture(docs, "list-failure"));
    } finally {
      await rm(library, { force: true, recursive: true });
    }
  });

  test("validates every tagged JSON fixture with its exact runtime structure", async () => {
    const docs = await readFile(JSON_CONTRACTS, "utf8");
    const fixtures = documentedFixtures(docs);
    const fences = [...docs.matchAll(/```json\n([\s\S]*?)\n```/g)];

    expect(fixtures.size).toBe(fences.length);
    for (const [id, payload] of fixtures) {
      expect(() => validatePublicPayload(payload), id).not.toThrow();
      const source = JSON.stringify(payload);
      expect(source, id).not.toMatch(/\/Users\/|\/home\/|OPENCODE_API_KEY\s*[=:]/);
      expect(source.toLowerCase(), id).not.toContain("secret");
    }
  });

  test("documents all stdout schemas, stable errors, and exact command-family exit behavior", async () => {
    const [jsonDocs, exitDocs] = await Promise.all([
      readFile(JSON_CONTRACTS, "utf8"),
      readFile(EXIT_CODES, "utf8"),
    ]);

    for (const schema of PUBLIC_CLI_SCHEMA_VERSIONS) expect(jsonDocs).toContain(`\`${schema}\``);
    for (const errorCode of PUBLIC_CLI_ERROR_CODES) expect(exitDocs).toContain(`\`${errorCode}\``);
    for (const exitCode of PUBLIC_CLI_EXIT_CODES) expect(exitDocs).toContain(`| ${exitCode} |`);
    for (const family of ["Invocation", "Setup", "Doctor", "Ingest / Transcript", "Library / Config"]) {
      expect(exitDocs).toContain(`| ${family} |`);
    }
    expect(exitDocs).not.toMatch(/^\| [3-9]\d* \|/m);
  });

  test("documents exact config precedence, Doctor checks, and optional failure video IDs", async () => {
    const docs = await readFile(JSON_CONTRACTS, "utf8");

    expect(docs).toContain("`env`, `config`, or `default`");
    expect(docs).not.toContain("`cli`, `env`, `config`, or `default`");
    expect(docs).toContain("`--output-dir` is not accepted by `config`");
    for (const id of PUBLIC_DOCTOR_CHECK_IDS) {
      expect(docs).toContain(`\`${id}\``);
      expect(docs).toContain(`| \`${id}\` | \`${PUBLIC_DOCTOR_CHECK_CAPABILITY[id]}\` |`);
    }
    expect(docs).toContain("may include `videoId`");
    expect(docs).toContain("Parsing, runtime-readiness, and failures without");
  });

  test("documents major-version compatibility and cross-links every contract page", async () => {
    const [jsonDocs, exitDocs, compatibilityDocs] = await Promise.all([
      readFile(JSON_CONTRACTS, "utf8"),
      readFile(EXIT_CODES, "utf8"),
      readFile(COMPATIBILITY, "utf8"),
    ]);

    expect(compatibilityDocs).toContain("macOS on Apple Silicon (`darwin`/`arm64`)");
    expect(compatibilityDocs).toContain("Bun");
    expect(compatibilityDocs).toContain("Python 3.12");
    expect(compatibilityDocs).toContain("`uv`");
    expect(compatibilityDocs).toContain("does not install or modify system Python");
    expect(compatibilityDocs).toContain("increment the affected `schemaVersion`");
    expect(compatibilityDocs).toContain("Breaking commands, defaults, or machine-readable formats require a major release");
    expect(jsonDocs).toContain("[Exit codes](./exit-codes.md)");
    expect(exitDocs).toContain("[JSON contracts](./json-contracts.md)");
    expect(compatibilityDocs).toContain("[JSON contracts](./json-contracts.md)");
    expect(compatibilityDocs).toContain("[Exit codes](./exit-codes.md)");
  });
});

function baseDependencies(): CliDependencies {
  return {
    appPaths: {
      configPath: "/application-support/config.json",
      defaultArtifactLibrary: "/example-home/Documents/Video Digest",
      runtimeDir: "/application-support/runtime/python",
    },
    configStore: { load: async () => null, save: async () => {} },
    credentialStore: {
      deleteApiKey: async () => {},
      getApiKey: async () => null,
      setApiKey: async () => {},
    },
    env: {},
    runtimeManager: { inspect: async () => ({ status: "ready" }), prepare: async () => {} },
    summarizerFactory: () => ({ generateDigest: async () => { throw new Error("not called"); } }),
  };
}

async function captureJson(args: string[], dependencies: CliDependencies): Promise<CapturedCliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writes: string[] = [];
  const io: CliIO = {
    error: (message) => stderr.push(message),
    inputIsTTY: false,
    isTTY: false,
    log: (message) => stdout.push(message),
    outputIsTTY: false,
    write: (message) => writes.push(message),
  };
  const exitCode = await runCli(args, io, dependencies);
  return {
    exitCode,
    payload: stdout.length === 1 ? JSON.parse(stdout[0]!) : null,
    stderr,
    stdout,
    writes,
  };
}

function completedIngestion(): IngestVideoResult {
  return {
    cleanText: "Useful content.\n",
    exitCode: 0,
    generation: {
      provider: "opencode",
      requestId: null,
      requestedModel: "gpt-5.4-mini",
      responseModel: null,
      usage: null,
    },
    paths: {
      digestPath: `/artifact-library/digests/${VIDEO_ID}.md`,
      emailPreviewPath: null,
      metadataPath: `/artifact-library/metadata/${VIDEO_ID}.json`,
      transcriptJsonPath: `/artifact-library/transcripts/${VIDEO_ID}.json`,
      transcriptMarkdownPath: `/artifact-library/transcripts/${VIDEO_ID}.md`,
      transcriptTextPath: `/artifact-library/transcripts/${VIDEO_ID}.txt`,
    },
    status: "completed",
    transcriptQuality: quality(),
  };
}

function completedTranscript(): FetchTranscriptOnlyResult {
  return {
    cleanText: "Useful content.\n",
    exitCode: 0,
    paths: {
      metadataPath: `/artifact-library/metadata/${VIDEO_ID}.json`,
      transcriptJsonPath: `/artifact-library/transcripts/${VIDEO_ID}.json`,
      transcriptMarkdownPath: `/artifact-library/transcripts/${VIDEO_ID}.md`,
      transcriptTextPath: `/artifact-library/transcripts/${VIDEO_ID}.txt`,
    },
    status: "completed",
    transcriptQuality: quality(),
  };
}

function unusableIngestion(): IngestVideoResult {
  return {
    exitCode: 2,
    metadataPath: `/artifact-library/metadata/${VIDEO_ID}.json`,
    status: "unusable-transcript",
    transcriptQuality: { ...quality(), status: "unusable" },
  };
}

function quality() {
  return {
    averageCharsPerMinute: 720,
    durationSeconds: 300,
    language: "en",
    qualitySchemaVersion: "transcript-quality.v0" as const,
    segmentCount: 60,
    status: "usable" as const,
    totalTextLength: 3600,
    warnings: [],
  };
}

function doctorReport(ok: boolean): DoctorReport {
  return ok
    ? {
        checks: [
          {
            capability: "transcript" as const,
            id: "python-runtime",
            message: "Managed Python runtime is ready",
            remediation: null,
            status: "pass" as const,
          },
          {
            capability: "digest" as const,
            id: "digest-provider",
            message: "OPENCODE_API_KEY is missing; digest generation is unavailable",
            remediation: "Set OPENCODE_API_KEY to enable video-digest ingest. Transcript mode works without it.",
            status: "warn" as const,
          },
        ],
        ok: true,
      }
    : {
        checks: [
          {
            capability: "transcript" as const,
            id: "python-runtime",
            message: "Managed Python runtime is missing",
            remediation: "Run video-digest setup.",
            status: "fail" as const,
          },
        ],
        ok: false,
      };
}

async function createLibraryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "video-digest-contracts-"));
  await mkdir(join(root, "digests"), { recursive: true });
  await mkdir(join(root, "metadata"), { recursive: true });
  await mkdir(join(root, "transcripts"), { recursive: true });
  await writeFile(join(root, "digests", `${VIDEO_ID}.md`), "# Example Video\n");
  await writeFile(join(root, "transcripts", `${VIDEO_ID}.json`), "{}\n");
  await writeFile(join(root, "transcripts", `${VIDEO_ID}.md`), "# Transcript\n");
  await writeFile(join(root, "transcripts", `${VIDEO_ID}.txt`), "Example text.\n");
  await writeFile(join(root, "metadata", `${VIDEO_ID}.json`), JSON.stringify({
    generation: {
      provider: "opencode",
      requestId: null,
      requestedModel: "gpt-5.4-mini",
      responseModel: null,
      usage: null,
    },
    metadataSchemaVersion: "metadata.v1",
    mode: "ingest",
    processedAt: "2026-06-18T12:00:00.000Z",
    video: {
      canonicalUrl: VIDEO_URL,
      channel: "Example Channel",
      durationSeconds: 60,
      videoId: VIDEO_ID,
      videoTitle: "Example Video",
    },
    videoDigestVersion: "0.2.0",
  }));
  return root;
}

function documentedFixtures(docs: string): Map<string, unknown> {
  const fixtures = new Map<string, unknown>();
  for (const match of docs.matchAll(/<!-- contract:([a-z0-9-]+) -->\s*```json\n([\s\S]*?)\n```/g)) {
    if (fixtures.has(match[1]!)) throw new Error(`Duplicate documented fixture: ${match[1]}`);
    fixtures.set(match[1]!, JSON.parse(match[2]!));
  }
  return fixtures;
}

function documentedFixture(docs: string, id: string): unknown {
  const fixture = documentedFixtures(docs).get(id);
  if (fixture === undefined) throw new Error(`Missing documented fixture: ${id}`);
  return fixture;
}

function normalizeRoot(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.startsWith(root) ? `/artifact-library${value.slice(root.length)}` : value;
  if (Array.isArray(value)) return value.map((item) => normalizeRoot(item, root));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeRoot(item, root)]));
}

function validatePublicPayload(payload: unknown): void {
  requireRecord(payload, "payload");
  requireString(payload.schemaVersion, "schemaVersion");
  switch (payload.schemaVersion) {
    case "cli-result.v1": return validateCliResult(payload);
    case "doctor-report.v1": return validateDoctorReport(payload);
    case "library-list.v0": return validateLibraryList(payload);
    case "open-result.v0": return validateOpenResult(payload);
    case "config-status.v1": return validateConfigStatus(payload);
    case "config-result.v1": return validateConfigResult(payload);
    case "setup-result.v0": return validateSetupResult(payload);
    default: throw new Error(`Unknown public schema: ${payload.schemaVersion}`);
  }
}

function validateCliResult(payload: Record<string, unknown>): void {
  if (payload.status === "failed") {
    const keys = ["error", "schemaVersion", "status"];
    if (payload.videoId !== undefined) keys.push("videoId");
    if (payload.provider !== undefined) keys.push("model", "provider");
    exactKeys(payload, keys);
    validateError(payload.error);
    if (payload.videoId !== undefined) requireString(payload.videoId, "videoId");
    return;
  }
  if (payload.status === "unusable-transcript") {
    exactKeys(payload, ["metadataPath", "schemaVersion", "status", "transcriptQuality", "videoId"]);
    requireString(payload.metadataPath, "metadataPath");
    expect(payload.transcriptQuality).toBe("unusable");
    requireString(payload.videoId, "videoId");
    return;
  }
  expect(payload.status).toBe("completed");
  const resultKeys = ["canonicalUrl", "paths", "schemaVersion", "status", "transcriptQuality", "videoId"];
  if (payload.generation !== undefined) resultKeys.push("generation");
  exactKeys(payload, resultKeys);
  requireString(payload.canonicalUrl, "canonicalUrl");
  requireString(payload.videoId, "videoId");
  requireEnumString(payload.transcriptQuality, ["usable", "warning"], "transcriptQuality");
  validateResultPaths(payload.paths);
}

function validateResultPaths(value: unknown): void {
  requireRecord(value, "paths");
  const transcriptKeys = ["metadataPath", "transcriptJsonPath", "transcriptMarkdownPath", "transcriptTextPath"];
  const keys = Object.keys(value).sort();
  if (keys.includes("digestPath")) {
    exactKeys(value, ["digestPath", "emailPreviewPath", ...transcriptKeys]);
    requireString(value.digestPath, "digestPath");
    requireNullableString(value.emailPreviewPath, "emailPreviewPath");
  } else {
    exactKeys(value, transcriptKeys);
  }
  for (const key of transcriptKeys) requireString(value[key], key);
}

function validateDoctorReport(payload: Record<string, unknown>): void {
  exactKeys(payload, ["checks", "ok", "schemaVersion"]);
  expect(typeof payload.ok).toBe("boolean");
  expect(Array.isArray(payload.checks)).toBe(true);
  for (const check of payload.checks as unknown[]) {
    requireRecord(check, "Doctor check");
    exactKeys(check, ["capability", "id", "message", "remediation", "status"]);
    requireEnumString(check.capability, [...new Set(Object.values(PUBLIC_DOCTOR_CHECK_CAPABILITY))], "Doctor capability");
    requireEnumString(check.id, PUBLIC_DOCTOR_CHECK_IDS, "Doctor id");
    requireString(check.message, "Doctor message");
    requireNullableString(check.remediation, "Doctor remediation");
    requireEnumString(check.status, ["pass", "warn", "fail"], "Doctor status");
  }
}

function validateLibraryList(payload: Record<string, unknown>): void {
  exactKeys(payload, ["items", "schemaVersion"]);
  expect(Array.isArray(payload.items)).toBe(true);
  for (const item of payload.items as unknown[]) validateLibraryEntry(item);
}

function validateOpenResult(payload: Record<string, unknown>): void {
  if (payload.status === "failed") {
    exactKeys(payload, ["error", "schemaVersion", "status"]);
    validateError(payload.error);
    return;
  }
  exactKeys(payload, ["channel", "openPath", "paths", "schemaVersion", "title", "updatedAt", "videoId"]);
  requireString(payload.openPath, "openPath");
  validateLibraryEntry(payload);
}

function validateLibraryEntry(value: unknown): void {
  requireRecord(value, "Library Entry");
  const allowed = ["channel", "paths", "title", "updatedAt", "videoId"];
  const actual = Object.keys(value).filter((key) => key !== "openPath" && key !== "schemaVersion");
  expect(actual.sort()).toEqual(allowed.sort());
  requireNullableString(value.channel, "channel");
  requireNullableString(value.title, "title");
  requireString(value.updatedAt, "updatedAt");
  requireString(value.videoId, "videoId");
  requireRecord(value.paths, "Library paths");
  exactKeys(value.paths, ["digestPath", "emailPreviewPath", "metadataPath", "transcriptJsonPath", "transcriptMarkdownPath", "transcriptTextPath"]);
  requireString(value.paths.metadataPath, "metadataPath");
  for (const key of ["digestPath", "emailPreviewPath", "transcriptJsonPath", "transcriptMarkdownPath", "transcriptTextPath"]) {
    requireNullableString(value.paths[key], key);
  }
}

function validateConfigStatus(payload: Record<string, unknown>): void {
  exactKeys(payload, ["artifactLibrary", "credential", "digest", "schemaVersion"]);
  requireRecord(payload.artifactLibrary, "artifactLibrary");
  exactKeys(payload.artifactLibrary, ["configured", "effective", "source"]);
  requireNullableString(payload.artifactLibrary.configured, "configured Artifact Library");
  requireString(payload.artifactLibrary.effective, "effective Artifact Library");
  requireEnumString(payload.artifactLibrary.source, ["env", "config", "default"], "Artifact Library source");
  requireRecord(payload.credential, "credential");
  exactKeys(payload.credential, ["configured", "provider", "source"]);
  expect(typeof payload.credential.configured).toBe("boolean");
  requireString(payload.credential.provider, "credential provider");
  requireEnumString(payload.credential.source, ["env", "keychain", "missing"], "credential source");
  requireRecord(payload.digest, "digest");
}

function validateConfigResult(payload: Record<string, unknown>): void {
  if (payload.status === "failed") {
    exactKeys(payload, ["error", "schemaVersion", "status"]);
    validateError(payload.error);
  } else if (payload.status === "saved") {
    exactKeys(payload, ["artifactLibrary", "schemaVersion", "status"]);
    requireString(payload.artifactLibrary, "artifactLibrary");
  } else {
    expect(payload.status).toBe("deleted");
    exactKeys(payload, ["credential", "schemaVersion", "status"]);
    requireRecord(payload.credential, "credential");
    exactKeys(payload.credential, ["configured", "provider"]);
    expect(payload.credential.configured).toBe(false);
  }
}

function validateSetupResult(payload: Record<string, unknown>): void {
  if (payload.status === "failed") {
    exactKeys(payload, ["error", "schemaVersion", "status"]);
    validateError(payload.error);
  } else {
    expect(payload.status).toBe("ready");
    exactKeys(payload, ["schemaVersion", "status"]);
  }
}

function validateError(value: unknown): void {
  requireRecord(value, "error");
  exactKeys(value, ["code", "message"]);
  requireEnumString(value.code, PUBLIC_CLI_ERROR_CODES, "error.code");
  requireString(value.message, "error.message");
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

function requireRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
}

function requireNullableString(value: unknown, label: string): void {
  if (value !== null && typeof value !== "string") throw new Error(`${label} must be a string or null`);
}

function requireEnumString(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
