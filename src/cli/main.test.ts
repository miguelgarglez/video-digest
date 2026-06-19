import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { runCli as runCliProduction, type CliDependencies, type CliIO } from "./main";
import type { AppConfig } from "./config-store";
import type { CredentialStore } from "./credentials";
import type { IngestVideoResult } from "../ingestion/ingest-video";
import type { FetchTranscriptOnlyResult } from "../ingestion/transcript-only";
import { SummarizerError } from "../summarizer/summarizer";
import { TranscriptSourceError, type Transcript } from "../transcript/transcript-source";
import type { TranscriptQuality } from "../transcript/transcript-quality";
import { RuntimeSetupError } from "./runtime-manager";

async function runCli(args: string[], io: CliIO, dependencies: CliDependencies = {}): Promise<number> {
  return runCliProduction(args, io, {
    appPaths: {
      configPath: "/test-home/Library/Application Support/video-digest/config.json",
      defaultArtifactLibrary: "/test-home/Documents/Video Digest",
      runtimeDir: "/test-home/Library/Application Support/video-digest/runtime/python",
    },
    configStore: { load: async () => null, save: async () => {} },
    runtimeManager: {
      inspect: async () => ({ status: "ready" }),
      prepare: async () => {},
    },
    ...dependencies,
  });
}

describe("runCli", () => {
  test("setup requires explicit consent before preparing the isolated runtime", async () => {
    let prepareCalls = 0;
    const errors: string[] = [];
    const exitCode = await runCli(
      ["setup"],
      { error: (message) => errors.push(message), isTTY: true, log: () => {}, prompt: async () => "no" },
      { runtimeManager: { inspect: async () => ({ status: "missing", remediation: "Run video-digest setup." }), prepare: async () => { prepareCalls += 1; } } },
    );

    expect(exitCode).toBe(1);
    expect(prepareCalls).toBe(0);
    expect(errors.join("\n")).toContain("cancelled");
  });

  test("setup --yes prepares the runtime and emits exactly one stable JSON result", async () => {
    let prepareCalls = 0;
    const logs: string[] = [];
    const exitCode = await runCli(
      ["setup", "--yes", "--json"],
      { error: () => {}, isTTY: false, log: (message) => logs.push(message) },
      { runtimeManager: { inspect: async () => ({ status: "ready" }), prepare: async () => { prepareCalls += 1; } } },
    );

    expect(exitCode).toBe(0);
    expect(prepareCalls).toBe(1);
    expect(logs).toEqual([JSON.stringify({ schemaVersion: "setup-result.v0", status: "ready" })]);
  });

  test("setup is isolated from malformed application configuration", async () => {
    let prepareCalls = 0;
    const logs: string[] = [];
    const exitCode = await runCli(
      ["setup", "--yes", "--json"],
      { error: () => {}, log: (message) => logs.push(message) },
      {
        configStore: {
          load: async () => { throw new Error("Malformed config"); },
          save: async () => {},
        },
        runtimeManager: {
          inspect: async () => ({ status: "ready" }),
          prepare: async () => { prepareCalls += 1; },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(prepareCalls).toBe(1);
    expect(logs).toEqual([JSON.stringify({ schemaVersion: "setup-result.v0", status: "ready" })]);
  });

  test("setup --yes explains the isolated Python installation in human output", async () => {
    const logs: string[] = [];
    const exitCode = await runCli(
      ["setup", "--yes"],
      { error: () => {}, log: (message) => logs.push(message) },
      { runtimeManager: { inspect: async () => ({ status: "ready" }), prepare: async () => {} } },
    );
    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("may install an isolated Python 3.12");
    expect(logs.join("\n")).toContain("shipped uv.lock");
  });

  test("non-interactive setup without --yes fails without prompting or mutation", async () => {
    let prepareCalls = 0;
    let promptCalls = 0;
    const exitCode = await runCli(
      ["setup", "--json"],
      { error: () => {}, isTTY: false, log: () => {}, prompt: async () => { promptCalls += 1; return "yes"; } },
      { runtimeManager: { inspect: async () => ({ status: "missing", remediation: "Run video-digest setup." }), prepare: async () => { prepareCalls += 1; } } },
    );
    expect(exitCode).toBe(1);
    expect(promptCalls).toBe(0);
    expect(prepareCalls).toBe(0);
  });

  test("setup failures emit stable JSON without leaking command details", async () => {
    const logs: string[] = [];
    const exitCode = await runCli(
      ["setup", "--yes", "--json"],
      { error: () => {}, log: (message) => logs.push(message) },
      { runtimeManager: { inspect: async () => ({ status: "missing", remediation: "Run video-digest setup." }), prepare: async () => { throw new Error("secret-token"); } } },
    );
    expect(exitCode).toBe(1);
    expect(logs).toEqual([JSON.stringify({
      error: { code: "setup-failed", message: "Setup failed while preparing the isolated Python runtime." },
      schemaVersion: "setup-result.v0",
      status: "failed",
    })]);
    expect(logs.join("\n")).not.toContain("secret-token");
  });

  test.each([
    ["already-running", "Runtime setup is already in progress."],
    ["recovery-required", "Runtime recovery is required at /safe/backup"],
  ] as const)("surfaces safe runtime setup error %s", async (code, message) => {
    const logs: string[] = [];
    await runCli(["setup", "--yes", "--json"], { error: () => {}, log: (value) => logs.push(value) }, {
      runtimeManager: { inspect: async () => ({ status: "missing", remediation: "Run video-digest setup." }), prepare: async () => { throw new RuntimeSetupError(code, message); } },
    });
    expect(JSON.parse(logs[0]!)).toEqual({ error: { code, message }, schemaVersion: "setup-result.v0", status: "failed" });
  });

  test.each([
    ["--bogus"],
    ["unexpected"],
  ])("setup parse failures use the setup result schema: %s", async (argument) => {
    const logs: string[] = [];
    const exitCode = await runCli(
      ["setup", argument, "--json"],
      { error: () => {}, log: (message) => logs.push(message) },
    );
    expect(exitCode).toBe(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      error: { code: expect.stringMatching(/^unsupported-/) },
      schemaVersion: "setup-result.v0",
      status: "failed",
    });
  });

  test.each(["ingest", "transcript"])("gates %s before invoking providers when runtime is not ready", async (command) => {
    let providerCalls = 0;
    const logs: string[] = [];
    const exitCode = await runCli(
      [command, "https://youtu.be/1ZgUcrR0K7I", "--json"],
      { error: () => {}, log: (message) => logs.push(message) },
      {
        fetchTranscriptOnly: async () => { providerCalls += 1; return completedTranscriptOnly(); },
        ingestVideo: async () => { providerCalls += 1; return completedIngestion(); },
        runtimeManager: { inspect: async () => ({ status: "obsolete", remediation: "Run video-digest setup." }), prepare: async () => {} },
      },
    );
    expect(exitCode).toBe(1);
    expect(providerCalls).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      error: { code: "runtime-not-ready", message: expect.stringContaining("Run video-digest setup.") },
      schemaVersion: "cli-result.v0",
      status: "failed",
    });
  });
  test("persists output-dir config", async () => {
    let saved: AppConfig | undefined;
    const exitCode = await runCli(
      ["config", "set", "output-dir", "/chosen/library"],
      { error: () => {}, log: () => {} },
      {
        appPaths: { configPath: "/config.json", defaultArtifactLibrary: "/default", runtimeDir: "/runtime" },
        configStore: { load: async () => null, save: async (config) => { saved = config; } },
        env: {},
      },
    );
    expect(exitCode).toBe(0);
    expect(saved).toEqual({ artifactLibrary: "/chosen/library", schemaVersion: "config.v0" });
  });

  test("reports effective artifact library in human and JSON config output without secrets", async () => {
    const human: string[] = [];
    const json: string[] = [];
    const dependencies = {
      appPaths: { configPath: "/config.json", defaultArtifactLibrary: "/default", runtimeDir: "/runtime" },
      configStore: { load: async () => ({ artifactLibrary: "/saved", schemaVersion: "config.v0" as const }), save: async () => {} },
      credentialStore: fakeCredentialStore({ storedKey: "never-print-this" }),
      env: { VIDEO_DIGEST_OUTPUT_DIR: "/env" },
    };
    await runCli(["config", "get"], { error: () => {}, log: (message) => human.push(message) }, dependencies);
    await runCli(["config", "get", "--json"], { error: () => {}, log: (message) => json.push(message) }, dependencies);
    expect(human.join("\n")).toContain("Artifact Library: /env (env)");
    expect(human.join("\n")).toContain("Saved Artifact Library: /saved");
    expect(JSON.parse(json[0]!)).toMatchObject({
      artifactLibrary: { configured: "/saved", effective: "/env", source: "env" },
      opencodeApiKey: { configured: true, source: "keychain" },
    });
    expect(`${human.join("\n")} ${json.join("\n")}`).not.toContain("never-print-this");
  });

  test("passes CLI output-dir precedence to ingest", async () => {
    let seen = "";
    await runCli(
      ["ingest", "https://youtu.be/1ZgUcrR0K7I", "--output-dir", "/cli"],
      { error: () => {}, log: () => {} },
      {
        appPaths: { configPath: "/config.json", defaultArtifactLibrary: "/default", runtimeDir: "/runtime" },
        configStore: { load: async () => ({ artifactLibrary: "/saved", schemaVersion: "config.v0" }), save: async () => {} },
        env: { VIDEO_DIGEST_OUTPUT_DIR: "/env" },
        ingestVideo: async (input) => { seen = input.outputDir; return completedIngestion(); },
      },
    );
    expect(seen).toBe("/cli");
  });
  test("prints help and exits without running ingestion", async () => {
    const logs: string[] = [];
    let ingestCalls = 0;

    const exitCode = await runCli(
      ["--help"],
      {
        error: () => {},
        log: (message) => logs.push(message),
      },
      {
        ingestVideo: async () => {
          ingestCalls += 1;
          throw new Error("Should not ingest when printing help");
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(ingestCalls).toBe(0);
    expect(logs.join("\n")).toContain("Usage:");
    expect(logs.join("\n")).toContain("--email-preview");
    expect(logs.join("\n")).toContain("<Artifact Library>/emails/");
    expect(logs.join("\n")).not.toContain("under outputs/emails/");
    expect(logs.join("\n")).toContain("--help");
    expect(logs.join("\n")).toContain("Interactive mode");
  });

  test("runs ingestion and prints output paths", async () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(
      ["https://youtu.be/1ZgUcrR0K7I", "--email-preview"],
      {
        error: (message) => errors.push(message),
        log: (message) => logs.push(message),
      },
      {
        ingestVideo: async ({ emailPreview, video }) => ({
          exitCode: 0,
          paths: {
            digestPath: "outputs/digests/1ZgUcrR0K7I.md",
            emailPreviewPath: emailPreview ? "outputs/emails/1ZgUcrR0K7I.md" : null,
            metadataPath: "outputs/metadata/1ZgUcrR0K7I.json",
            transcriptJsonPath: "outputs/transcripts/1ZgUcrR0K7I.json",
            transcriptMarkdownPath: "outputs/transcripts/1ZgUcrR0K7I.md",
            transcriptTextPath: "outputs/transcripts/1ZgUcrR0K7I.txt",
          },
          status: "completed",
          transcriptQuality: {
            averageCharsPerMinute: 720,
            durationSeconds: 300,
            language: "en",
            qualitySchemaVersion: "transcript-quality.v0",
            segmentCount: 60,
            status: "usable",
            totalTextLength: 3600,
            warnings: [],
          },
        }),
        outputDir: "outputs",
      },
    );

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toEqual([
      "Ingested video 1ZgUcrR0K7I",
      "Transcript quality: usable",
      "Transcript JSON: outputs/transcripts/1ZgUcrR0K7I.json",
      "Transcript Markdown: outputs/transcripts/1ZgUcrR0K7I.md",
      "Transcript text: outputs/transcripts/1ZgUcrR0K7I.txt",
      "Digest: outputs/digests/1ZgUcrR0K7I.md",
      "Metadata: outputs/metadata/1ZgUcrR0K7I.json",
      "Email preview: outputs/emails/1ZgUcrR0K7I.md",
    ]);
  });

  test("passes stored OpenCode key to ingestion summarizer", async () => {
    const seenApiKeys: string[] = [];

    const exitCode = await runCli(
      ["ingest", "https://youtu.be/1ZgUcrR0K7I"],
      {
        error: () => {},
        log: () => {},
      },
      {
        credentialStore: fakeCredentialStore({ storedKey: "stored-key" }),
        env: {},
        ingestVideo: async ({ summarizer }) => {
          await summarizer.generateDigest({
            transcript: transcriptFixture(),
            transcriptQuality: usableQualityFixture(),
            video: {
              canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
              videoId: "1ZgUcrR0K7I",
            },
          });
          return completedIngestion();
        },
        summarizerFactory: (apiKey) => ({
          generateDigest: async () => {
            seenApiKeys.push(apiKey ?? "");
            return digestDraftFixture();
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(seenApiKeys).toEqual(["stored-key"]);
  });

  test("runs explicit ingest command", async () => {
    const logs: string[] = [];
    const commandVideoIds: string[] = [];

    const exitCode = await runCli(
      ["ingest", "https://youtu.be/1ZgUcrR0K7I"],
      {
        error: () => {},
        log: (message) => logs.push(message),
      },
      {
        ingestVideo: async ({ video }) => {
          commandVideoIds.push(video.videoId);
          return completedIngestion();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(commandVideoIds).toEqual(["1ZgUcrR0K7I"]);
    expect(logs).toContain("Ingested video 1ZgUcrR0K7I");
  });

  test("prints one json object for successful ingest json mode", async () => {
    const logs: string[] = [];
    const writes: string[] = [];

    const exitCode = await runCli(
      ["ingest", "https://youtu.be/1ZgUcrR0K7I", "--json"],
      {
        error: (message) => logs.push(`error:${message}`),
        isTTY: true,
        log: (message) => logs.push(message),
        write: (message) => writes.push(message),
      },
      {
        ingestVideo: async () => completedIngestion(),
        spinnerIntervalMs: 0,
      },
    );

    expect(exitCode).toBe(0);
    expect(writes).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toEqual({
      canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      paths: {
        digestPath: "outputs/digests/1ZgUcrR0K7I.md",
        emailPreviewPath: null,
        metadataPath: "outputs/metadata/1ZgUcrR0K7I.json",
        transcriptJsonPath: "outputs/transcripts/1ZgUcrR0K7I.json",
        transcriptMarkdownPath: "outputs/transcripts/1ZgUcrR0K7I.md",
        transcriptTextPath: "outputs/transcripts/1ZgUcrR0K7I.txt",
      },
      schemaVersion: "cli-result.v0",
      status: "completed",
      transcriptQuality: "usable",
      videoId: "1ZgUcrR0K7I",
    });
  });

  test("prints one json object for transcript-unavailable errors", async () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(
      ["ingest", "https://youtu.be/hrIdEuwtODc", "--json"],
      {
        error: (message) => errors.push(message),
        log: (message) => logs.push(message),
      },
      {
        ingestVideo: async () => {
          throw new TranscriptSourceError(
            "transcript-unavailable",
            "Could not retrieve transcript\nThis is most likely caused by:\n\nSubtitles are disabled",
          );
        },
      },
    );

    expect(exitCode).toBe(2);
    expect(errors).toEqual([]);
    expect(JSON.parse(logs[0]!)).toEqual({
      error: {
        code: "transcript-unavailable",
        message: "No transcript is available for this video.\nProvider reason: Subtitles are disabled\nDigest generation was skipped. Try another video or a future transcript fallback.",
      },
      schemaVersion: "cli-result.v0",
      status: "failed",
      videoId: "hrIdEuwtODc",
    });
  });

  test("prints json parse errors when json mode is requested", async () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(
      ["ingest", "https://example.com", "--json"],
      {
        error: (message) => errors.push(message),
        log: (message) => logs.push(message),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors).toEqual([]);
    expect(JSON.parse(logs[0]!)).toEqual({
      error: {
        code: "invalid-url",
        message: "Unsupported YouTube URL: https://example.com",
      },
      schemaVersion: "cli-result.v0",
      status: "failed",
    });
  });

  test("returns stable json for unusable transcripts", async () => {
    const logs: string[] = [];

    const exitCode = await runCli(
      ["ingest", "https://youtu.be/1ZgUcrR0K7I", "--json"],
      {
        error: () => {},
        log: (message) => logs.push(message),
      },
      {
        ingestVideo: async () => ({
          exitCode: 2,
          metadataPath: "outputs/metadata/1ZgUcrR0K7I.json",
          status: "unusable-transcript",
          transcriptQuality: {
            averageCharsPerMinute: 3,
            durationSeconds: 300,
            language: "en",
            qualitySchemaVersion: "transcript-quality.v0",
            segmentCount: 1,
            status: "unusable",
            totalTextLength: 20,
            warnings: [],
          },
        }),
      },
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(logs[0]!)).toEqual({
      metadataPath: "outputs/metadata/1ZgUcrR0K7I.json",
      schemaVersion: "cli-result.v0",
      status: "unusable-transcript",
      transcriptQuality: "unusable",
      videoId: "1ZgUcrR0K7I",
    });
  });

  test("returns stable json for unexpected failures", async () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(
      ["ingest", "https://youtu.be/1ZgUcrR0K7I", "--json"],
      {
        error: (message) => errors.push(message),
        log: (message) => logs.push(message),
      },
      {
        ingestVideo: async () => {
          throw new Error("Provider exploded");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(errors).toEqual([]);
    expect(JSON.parse(logs[0]!)).toEqual({
      error: {
        code: "unexpected-error",
        message: "Provider exploded",
      },
      schemaVersion: "cli-result.v0",
      status: "failed",
      videoId: "1ZgUcrR0K7I",
    });
  });

  test("suggests transcript command when ingest is missing OpenCode config", async () => {
    const errors: string[] = [];

    const exitCode = await runCli(
      ["ingest", "https://youtu.be/1ZgUcrR0K7I"],
      {
        error: (message) => errors.push(message),
        log: () => {},
      },
      {
        ingestVideo: async () => {
          throw new SummarizerError("missing-api-key", "Missing OPENCODE_API_KEY");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Digest generation requires OPENCODE_API_KEY.");
    expect(errors.join("\n")).toContain("video-digest transcript https://www.youtube.com/watch?v=1ZgUcrR0K7I");
  });

  test("returns structured missing-api-key json for ingest", async () => {
    const logs: string[] = [];

    const exitCode = await runCli(
      ["ingest", "https://youtu.be/1ZgUcrR0K7I", "--json"],
      {
        error: () => {},
        log: (message) => logs.push(message),
      },
      {
        ingestVideo: async () => {
          throw new SummarizerError("missing-api-key", "Missing OPENCODE_API_KEY");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(logs[0]!)).toEqual({
      error: {
        code: "missing-api-key",
        message: "Digest generation requires OPENCODE_API_KEY.\nTo fetch only the transcript, run:\n  video-digest transcript https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      },
      schemaVersion: "cli-result.v0",
      status: "failed",
      videoId: "1ZgUcrR0K7I",
    });
  });

  test("runs transcript command and prints transcript artifact paths", async () => {
    const logs: string[] = [];
    const transcriptVideoIds: string[] = [];

    const exitCode = await runCli(
      ["transcript", "https://youtu.be/1ZgUcrR0K7I"],
      {
        error: () => {},
        log: (message) => logs.push(message),
      },
      {
        fetchTranscriptOnly: async ({ video }) => {
          transcriptVideoIds.push(video.videoId);
          return completedTranscriptOnly();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(transcriptVideoIds).toEqual(["1ZgUcrR0K7I"]);
    expect(logs).toEqual([
      "Fetched transcript for 1ZgUcrR0K7I",
      "Transcript quality: usable",
      "Transcript JSON: outputs/transcripts/1ZgUcrR0K7I.json",
      "Transcript Markdown: outputs/transcripts/1ZgUcrR0K7I.md",
      "Transcript text: outputs/transcripts/1ZgUcrR0K7I.txt",
      "Metadata: outputs/metadata/1ZgUcrR0K7I.json",
    ]);
  });

  test("runs transcript command in json mode", async () => {
    const logs: string[] = [];
    const writes: string[] = [];

    const exitCode = await runCli(
      ["transcript", "https://youtu.be/1ZgUcrR0K7I", "--json"],
      {
        error: () => {},
        isTTY: true,
        log: (message) => logs.push(message),
        write: (message) => writes.push(message),
      },
      {
        fetchTranscriptOnly: async () => completedTranscriptOnly(),
      },
    );

    expect(exitCode).toBe(0);
    expect(writes).toEqual([]);
    expect(JSON.parse(logs[0]!)).toEqual({
      canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      paths: {
        metadataPath: "outputs/metadata/1ZgUcrR0K7I.json",
        transcriptJsonPath: "outputs/transcripts/1ZgUcrR0K7I.json",
        transcriptMarkdownPath: "outputs/transcripts/1ZgUcrR0K7I.md",
        transcriptTextPath: "outputs/transcripts/1ZgUcrR0K7I.txt",
      },
      schemaVersion: "cli-result.v0",
      status: "completed",
      transcriptQuality: "usable",
      videoId: "1ZgUcrR0K7I",
    });
  });

  test("reports config status without printing stored secrets", async () => {
    const logs: string[] = [];

    const exitCode = await runCli(
      ["config", "get"],
      {
        error: () => {},
        log: (message) => logs.push(message),
      },
      {
        credentialStore: fakeCredentialStore({ storedKey: "secret-key" }),
        env: {},
      },
    );

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("OpenCode API key: configured via Keychain");
    expect(logs.join("\n")).not.toContain("secret-key");
  });

  test("reports config status as json", async () => {
    const logs: string[] = [];

    const exitCode = await runCli(
      ["config", "get", "--json"],
      {
        error: () => {},
        log: (message) => logs.push(message),
      },
      {
        credentialStore: fakeCredentialStore({ storedKey: "secret-key" }),
        env: {},
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs[0]!)).toEqual({
      artifactLibrary: {
        configured: null,
        effective: "/test-home/Documents/Video Digest",
        source: "default",
      },
      opencodeApiKey: {
        configured: true,
        source: "keychain",
      },
      schemaVersion: "config-status.v0",
    });
  });

  test("stores OpenCode key from config set prompt", async () => {
    const logs: string[] = [];
    const prompts: string[] = [];
    const stored: string[] = [];

    const exitCode = await runCli(
      ["config", "set", "opencode-api-key"],
      {
        error: () => {},
        log: (message) => logs.push(message),
        prompt: async (question) => {
          prompts.push(question);
          return "secret-key";
        },
      },
      {
        credentialStore: fakeCredentialStore({ setKey: async (value) => { stored.push(value); } }),
      },
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual(["OpenCode API key: "]);
    expect(stored).toEqual(["secret-key"]);
    expect(logs.join("\n")).toContain("OpenCode API key stored in macOS Keychain.");
    expect(logs.join("\n")).not.toContain("secret-key");
  });

  test("unsets OpenCode key", async () => {
    const logs: string[] = [];
    let deleted = false;

    const exitCode = await runCli(
      ["config", "unset", "opencode-api-key"],
      {
        error: () => {},
        log: (message) => logs.push(message),
      },
      {
        credentialStore: fakeCredentialStore({ deleteKey: async () => { deleted = true; } }),
      },
    );

    expect(exitCode).toBe(0);
    expect(deleted).toBe(true);
    expect(logs).toEqual(["OpenCode API key removed from macOS Keychain."]);
  });

  test("runs doctor with human and json output", async () => {
    const humanLogs: string[] = [];
    const jsonLogs: string[] = [];

    const humanExit = await runCli(
      ["doctor"],
      {
        error: () => {},
        log: (message) => humanLogs.push(message),
      },
      {
        doctor: async () => ({
          checks: [
            {
              capability: "transcript",
              id: "uv",
              message: "uv is available",
              remediation: null,
              status: "pass",
            },
          ],
          ok: true,
        }),
      },
    );
    const jsonExit = await runCli(
      ["doctor", "--json"],
      {
        error: () => {},
        log: (message) => jsonLogs.push(message),
      },
      {
        doctor: async () => ({
          checks: [
            {
              capability: "transcript",
              id: "uv",
              message: "uv is available",
              remediation: null,
              status: "pass",
            },
          ],
          ok: true,
        }),
      },
    );

    expect(humanExit).toBe(0);
    expect(humanLogs.join("\n")).toContain("[ok] transcript/uv: uv is available");
    expect(jsonExit).toBe(0);
    expect(JSON.parse(jsonLogs[0]!)).toEqual({
      checks: [
        {
          capability: "transcript",
          id: "uv",
          message: "uv is available",
          remediation: null,
          status: "pass",
        },
      ],
      ok: true,
      schemaVersion: "doctor-report.v0",
    });
  });

  test("passes the resolved effective Artifact Library to doctor", async () => {
    let checkedPath = "";
    await runCli(["doctor"], { error: () => {}, log: () => {} }, {
      configStore: { load: async () => ({ artifactLibrary: "/saved", schemaVersion: "config.v0" }), save: async () => {} },
      env: { VIDEO_DIGEST_OUTPUT_DIR: "/effective-env" },
      doctor: async (path) => { checkedPath = path; return { checks: [], ok: true }; },
    });
    expect(checkedPath).toBe("/effective-env");
  });

  test("lists digest artifacts in human and json output", async () => {
    const outputDir = await createOutputDirWithDigest("1ZgUcrR0K7I");
    const logs: string[] = [];
    const jsonLogs: string[] = [];

    const humanExit = await runCli(["list"], { error: () => {}, log: (message) => logs.push(message) }, { outputDir });
    const jsonExit = await runCli(
      ["list", "--json"],
      { error: () => {}, log: (message) => jsonLogs.push(message) },
      { outputDir },
    );

    expect(humanExit).toBe(0);
    expect(logs.join("\n")).toContain("1ZgUcrR0K7I");
    expect(logs.join("\n")).toContain("Generated Digest Title");
    expect(jsonExit).toBe(0);
    expect(JSON.parse(jsonLogs[0]!).items[0]).toMatchObject({
      digestPath: join(outputDir, "digests", "1ZgUcrR0K7I.md"),
      digestTitle: "Generated Digest Title",
      metadataPath: join(outputDir, "metadata", "1ZgUcrR0K7I.json"),
      videoId: "1ZgUcrR0K7I",
    });
  });

  test("recovers before list and open without duplicating writer recovery", async () => {
    const outputDir = await createOutputDirWithDigest("1ZgUcrR0K7I");
    const events: string[] = [];
    const baseDependencies: CliDependencies = {
      env: { OPENCODE_API_KEY: "configured-key" },
      fetchTranscriptOnly: async () => {
        events.push("transcript");
        return completedTranscriptOnly();
      },
      ingestVideo: async () => {
        events.push("ingest");
        return completedIngestion();
      },
      outputDir,
      recoverPendingOutputTransactions: async (path) => {
        events.push(`recover:${path}`);
      },
    };
    const io = { error: () => {}, log: () => {} };

    await runCli(["list"], io, baseDependencies);
    await runCli(["open", "latest", "--json"], io, baseDependencies);
    await runCli(["transcript", "https://youtu.be/1ZgUcrR0K7I"], io, baseDependencies);
    await runCli(["ingest", "https://youtu.be/1ZgUcrR0K7I"], io, baseDependencies);

    expect(events).toEqual([
      `recover:${outputDir}`,
      `recover:${outputDir}`,
      "transcript",
      "ingest",
    ]);
  });

  test("resolves latest digest without opening it in json mode", async () => {
    const outputDir = await createOutputDirWithDigest("1ZgUcrR0K7I");
    const logs: string[] = [];
    const opened: string[] = [];

    const exitCode = await runCli(
      ["open", "latest", "--json"],
      { error: () => {}, log: (message) => logs.push(message) },
      {
        openPath: async (path) => {
          opened.push(path);
        },
        outputDir,
      },
    );

    expect(exitCode).toBe(0);
    expect(opened).toEqual([]);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      digestPath: join(outputDir, "digests", "1ZgUcrR0K7I.md"),
      schemaVersion: "open-result.v0",
      videoId: "1ZgUcrR0K7I",
    });
  });

  test("prints ingestion progress events", async () => {
    const logs: string[] = [];

    await runCli(
      ["https://youtu.be/1ZgUcrR0K7I"],
      {
        error: () => {},
        log: (message) => logs.push(message),
      },
      {
        ingestVideo: async (input) => {
          input.onProgress?.({ stage: "fetching-transcript", videoId: input.video.videoId });
          input.onProgress?.({ stage: "scoring-transcript", videoId: input.video.videoId });
          input.onProgress?.({ stage: "generating-digest", videoId: input.video.videoId });
          input.onProgress?.({ stage: "writing-outputs", videoId: input.video.videoId });
          input.onProgress?.({ stage: "completed", videoId: input.video.videoId });

          return {
            exitCode: 0,
            paths: {
              digestPath: "outputs/digests/1ZgUcrR0K7I.md",
              emailPreviewPath: null,
              metadataPath: "outputs/metadata/1ZgUcrR0K7I.json",
              transcriptJsonPath: "outputs/transcripts/1ZgUcrR0K7I.json",
              transcriptMarkdownPath: "outputs/transcripts/1ZgUcrR0K7I.md",
              transcriptTextPath: "outputs/transcripts/1ZgUcrR0K7I.txt",
            },
            status: "completed",
            transcriptQuality: {
              averageCharsPerMinute: 720,
              durationSeconds: 300,
              language: "en",
              qualitySchemaVersion: "transcript-quality.v0",
              segmentCount: 60,
              status: "usable",
              totalTextLength: 3600,
              warnings: [],
            },
          };
        },
      },
    );

    expect(logs.slice(0, 5)).toEqual([
      "[1/5] Fetching transcript for 1ZgUcrR0K7I",
      "[2/5] Scoring transcript quality",
      "[3/5] Generating digest",
      "[4/5] Writing output artifacts",
      "[5/5] Completed ingestion",
    ]);
  });

  test("renders animated terminal progress when TTY output is available", async () => {
    const logs: string[] = [];
    const writes: string[] = [];

    await runCli(
      ["https://youtu.be/1ZgUcrR0K7I"],
      {
        error: () => {},
        isTTY: true,
        log: (message) => logs.push(message),
        write: (message) => writes.push(message),
      },
      {
        ingestVideo: async (input) => {
          input.onProgress?.({ stage: "fetching-transcript", videoId: input.video.videoId });
          input.onProgress?.({ stage: "scoring-transcript", videoId: input.video.videoId });
          input.onProgress?.({ stage: "completed", videoId: input.video.videoId });

          return {
            exitCode: 0,
            paths: {
              digestPath: "outputs/digests/1ZgUcrR0K7I.md",
              emailPreviewPath: null,
              metadataPath: "outputs/metadata/1ZgUcrR0K7I.json",
              transcriptJsonPath: "outputs/transcripts/1ZgUcrR0K7I.json",
              transcriptMarkdownPath: "outputs/transcripts/1ZgUcrR0K7I.md",
              transcriptTextPath: "outputs/transcripts/1ZgUcrR0K7I.txt",
            },
            status: "completed",
            transcriptQuality: {
              averageCharsPerMinute: 720,
              durationSeconds: 300,
              language: "en",
              qualitySchemaVersion: "transcript-quality.v0",
              segmentCount: 60,
              status: "usable",
              totalTextLength: 3600,
              warnings: [],
            },
          };
        },
        spinnerIntervalMs: 0,
      },
    );

    expect(logs.slice(0, 4)).toEqual([
      "",
      "+----------------------+",
      "| VIDEO DIGEST         |",
      "+----------------------+",
    ]);
    expect(writes.join("")).toContain("\r- Fetching transcript for 1ZgUcrR0K7I");
    expect(writes.join("")).toContain("\r[ok] Fetching transcript for 1ZgUcrR0K7I");
    expect(logs).toContain("[done] Completed ingestion");
  });

  test("prints usage errors and exits non-zero", async () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli([], {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    });

    expect(exitCode).toBe(1);
    expect(logs).toEqual([]);
    expect(errors).toEqual(["Usage: bun run video-digest <youtube-url> [--email-preview]"]);
  });

  test("prints a friendly message when a transcript is unavailable", async () => {
    const errors: string[] = [];

    const exitCode = await runCli(
      ["https://youtu.be/hrIdEuwtODc"],
      {
        error: (message) => errors.push(message),
        log: () => {},
      },
      {
        ingestVideo: async () => {
          throw new TranscriptSourceError(
            "transcript-unavailable",
            [
              "Could not retrieve a transcript for the video https://www.youtube.com/watch?v=hrIdEuwtODc!",
              "This is most likely caused by:",
              "",
              "Subtitles are disabled for this video",
              "",
              "If you are sure that the described cause is not responsible for this error and that a transcript should be retrievable, please create an issue at https://github.com/jdepoix/youtube-transcript-api/issues.",
            ].join("\n"),
          );
        },
      },
    );

    expect(exitCode).toBe(2);
    expect(errors.join("\n")).toContain("No transcript is available for this video.");
    expect(errors.join("\n")).toContain("Provider reason: Subtitles are disabled for this video");
    expect(errors.join("\n")).not.toContain("github.com");
  });

  test("prompts for URL and email preview when run interactively", async () => {
    const prompts: string[] = [];
    const logs: string[] = [];
    const answers = [
      "1",
      "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      "y",
    ];

    const exitCode = await runCli(
      [],
      {
        error: () => {},
        log: (message) => logs.push(message),
        prompt: async (question) => {
          prompts.push(question);
          return answers.shift() ?? "";
        },
      },
      {
        ingestVideo: async ({ emailPreview }) => ({
          exitCode: 0,
          paths: {
            digestPath: "outputs/digests/1ZgUcrR0K7I.md",
            emailPreviewPath: emailPreview ? "outputs/emails/1ZgUcrR0K7I.md" : null,
            metadataPath: "outputs/metadata/1ZgUcrR0K7I.json",
            transcriptJsonPath: "outputs/transcripts/1ZgUcrR0K7I.json",
            transcriptMarkdownPath: "outputs/transcripts/1ZgUcrR0K7I.md",
            transcriptTextPath: "outputs/transcripts/1ZgUcrR0K7I.txt",
          },
          status: "completed",
          transcriptQuality: {
            averageCharsPerMinute: 720,
            durationSeconds: 300,
            language: "en",
            qualitySchemaVersion: "transcript-quality.v0",
            segmentCount: 60,
            status: "usable",
            totalTextLength: 3600,
            warnings: [],
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual([
      "What do you want to create? [1] Digest [2] Transcript only: ",
      "YouTube URL: ",
      "Create email preview? [y/N]: ",
    ]);
    expect(logs).toContain("Email preview: outputs/emails/1ZgUcrR0K7I.md");
  });

  test("preserves output-dir when prompting for an ingest URL", async () => {
    const answers = ["1", "https://www.youtube.com/watch?v=1ZgUcrR0K7I", "n"];
    let outputDir = "";

    const exitCode = await runCli(
      ["ingest", "--output-dir", "/cli"],
      {
        error: () => {},
        log: () => {},
        prompt: async () => answers.shift() ?? "",
      },
      {
        credentialStore: fakeCredentialStore({ storedKey: "stored-key" }),
        ingestVideo: async (input) => {
          outputDir = input.outputDir;
          return completedIngestion();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(outputDir).toBe("/cli");
  });

  test("interactive mode can choose transcript only", async () => {
    const prompts: string[] = [];
    const logs: string[] = [];
    const transcriptCalls: string[] = [];
    const answers = ["2", "https://www.youtube.com/watch?v=1ZgUcrR0K7I"];

    const exitCode = await runCli(
      [],
      {
        error: () => {},
        log: (message) => logs.push(message),
        prompt: async (question) => {
          prompts.push(question);
          return answers.shift() ?? "";
        },
      },
      {
        fetchTranscriptOnly: async ({ video }) => {
          transcriptCalls.push(video.videoId);
          return completedTranscriptOnly();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual([
      "What do you want to create? [1] Digest [2] Transcript only: ",
      "YouTube URL: ",
    ]);
    expect(transcriptCalls).toEqual(["1ZgUcrR0K7I"]);
    expect(logs).toContain("Fetched transcript for 1ZgUcrR0K7I");
  });

  test("preserves output-dir when interactively selecting transcript", async () => {
    const answers = ["2", "https://www.youtube.com/watch?v=1ZgUcrR0K7I"];
    let outputDir = "";

    const exitCode = await runCli(
      ["ingest", "--output-dir", "/cli"],
      {
        error: () => {},
        log: () => {},
        prompt: async () => answers.shift() ?? "",
      },
      {
        fetchTranscriptOnly: async (input) => {
          outputDir = input.outputDir;
          return completedTranscriptOnly();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(outputDir).toBe("/cli");
  });

  test("interactive digest setup can store a token and continue", async () => {
    const prompts: string[] = [];
    const logs: string[] = [];
    const stored: string[] = [];
    const seenApiKeys: string[] = [];
    const answers = [
      "1",
      "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      "n",
      "y",
      "secret-key",
      "y",
    ];

    const exitCode = await runCli(
      [],
      {
        error: (message) => logs.push(`error:${message}`),
        log: (message) => logs.push(message),
        prompt: async (question) => {
          prompts.push(question);
          return answers.shift() ?? "";
        },
      },
      {
        credentialStore: fakeCredentialStore({ setKey: async (value) => { stored.push(value); } }),
        env: {},
        ingestVideo: async ({ summarizer }) => {
          await summarizer.generateDigest({
            transcript: transcriptFixture(),
            transcriptQuality: usableQualityFixture(),
            video: {
              canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
              videoId: "1ZgUcrR0K7I",
            },
          });
          return completedIngestion();
        },
        summarizerFactory: (apiKey) => ({
          generateDigest: async () => {
            seenApiKeys.push(apiKey ?? "");
            return digestDraftFixture();
          },
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual([
      "What do you want to create? [1] Digest [2] Transcript only: ",
      "YouTube URL: ",
      "Create email preview? [y/N]: ",
      "Paste API key now? [Y/n]: ",
      "OpenCode API key: ",
      "Save this key in macOS Keychain for future runs? [Y/n]: ",
    ]);
    expect(logs.join("\n")).toContain("Get an OpenCode API key:");
    expect(logs.join("\n")).toContain("https://opencode.ai/zen");
    expect(stored).toEqual(["secret-key"]);
    expect(seenApiKeys).toEqual(["secret-key"]);
    expect(logs.join("\n")).not.toContain("secret-key");
  });

  test("interactive digest setup can fall back to transcript only", async () => {
    const prompts: string[] = [];
    const transcriptCalls: string[] = [];
    const answers = [
      "1",
      "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      "n",
      "n",
      "y",
    ];

    const exitCode = await runCli(
      [],
      {
        error: () => {},
        log: () => {},
        prompt: async (question) => {
          prompts.push(question);
          return answers.shift() ?? "";
        },
      },
      {
        credentialStore: fakeCredentialStore({ storedKey: null }),
        env: {},
        fetchTranscriptOnly: async ({ video }) => {
          transcriptCalls.push(video.videoId);
          return completedTranscriptOnly();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual([
      "What do you want to create? [1] Digest [2] Transcript only: ",
      "YouTube URL: ",
      "Create email preview? [y/N]: ",
      "Paste API key now? [Y/n]: ",
      "Continue with transcript only instead? [Y/n]: ",
    ]);
    expect(transcriptCalls).toEqual(["1ZgUcrR0K7I"]);
  });
});

function completedIngestion(): IngestVideoResult {
  return {
    exitCode: 0,
    paths: {
      digestPath: "outputs/digests/1ZgUcrR0K7I.md",
      emailPreviewPath: null,
      metadataPath: "outputs/metadata/1ZgUcrR0K7I.json",
      transcriptJsonPath: "outputs/transcripts/1ZgUcrR0K7I.json",
      transcriptMarkdownPath: "outputs/transcripts/1ZgUcrR0K7I.md",
      transcriptTextPath: "outputs/transcripts/1ZgUcrR0K7I.txt",
    },
    status: "completed" as const,
    transcriptQuality: {
      averageCharsPerMinute: 720,
      durationSeconds: 300,
      language: "en",
      qualitySchemaVersion: "transcript-quality.v0" as const,
      segmentCount: 60,
      status: "usable" as const,
      totalTextLength: 3600,
      warnings: [],
    },
  };
}

function completedTranscriptOnly(): FetchTranscriptOnlyResult {
  return {
    exitCode: 0,
    paths: {
      metadataPath: "outputs/metadata/1ZgUcrR0K7I.json",
      transcriptJsonPath: "outputs/transcripts/1ZgUcrR0K7I.json",
      transcriptMarkdownPath: "outputs/transcripts/1ZgUcrR0K7I.md",
      transcriptTextPath: "outputs/transcripts/1ZgUcrR0K7I.txt",
    },
    status: "completed",
    transcriptQuality: {
      averageCharsPerMinute: 720,
      durationSeconds: 300,
      language: "en",
      qualitySchemaVersion: "transcript-quality.v0",
      segmentCount: 60,
      status: "usable",
      totalTextLength: 3600,
      warnings: [],
    },
  };
}

function transcriptFixture(): Transcript {
  return {
    language: "en",
    provenance: { isAutoGenerated: false },
    schemaVersion: "transcript.v0",
    segments: [
      {
        duration: 1,
        start: 0,
        text: "Useful content.",
      },
    ],
    source: "youtube-transcript-api",
    videoId: "1ZgUcrR0K7I",
  };
}

function usableQualityFixture(): TranscriptQuality {
  return {
    averageCharsPerMinute: 720,
    durationSeconds: 300,
    language: "en",
    qualitySchemaVersion: "transcript-quality.v0",
    segmentCount: 60,
    status: "usable",
    totalTextLength: 3600,
    warnings: [],
  };
}

function digestDraftFixture() {
  return {
    actionableIdeas: [],
    conceptsToInvestigate: [],
    connections: [],
    digestTitle: "Useful Digest",
    keyIdeas: [],
    relevantTimestamps: [],
    tldr: [],
    verdict: "watch_fragments" as const,
  };
}

async function createOutputDirWithDigest(videoId: string): Promise<string> {
  const outputDir = await mkdtemp(join(tmpdir(), "video-digest-cli-"));
  const digestPath = join(outputDir, "digests", `${videoId}.md`);
  const metadataPath = join(outputDir, "metadata", `${videoId}.json`);

  await mkdir(join(outputDir, "digests"), { recursive: true });
  await mkdir(join(outputDir, "metadata"), { recursive: true });
  await writeFile(digestPath, "# Generated Digest Title\n\nUseful content.", { flag: "w" });
  await writeFile(
    metadataPath,
    JSON.stringify({
      digest: {
        digestTitle: "Generated Digest Title",
      },
      video: {
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        videoId,
      },
    }),
    { flag: "w" },
  );

  expect(await readFile(digestPath, "utf8")).toContain("Generated Digest Title");
  return outputDir;
}

function fakeCredentialStore(options: {
  deleteKey?: () => Promise<void>;
  setKey?: (value: string) => Promise<void>;
  storedKey?: string | null;
}): CredentialStore {
  return {
    deleteOpenCodeApiKey: options.deleteKey ?? (async () => {}),
    getOpenCodeApiKey: async () => options.storedKey ?? null,
    setOpenCodeApiKey: options.setKey ?? (async () => {}),
  };
}
