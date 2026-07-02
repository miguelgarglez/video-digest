import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, symlink, unlink, writeFile } from "node:fs/promises";
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
import type { LibraryFileOperations } from "./artifacts";
import { writeTranscriptOnlyOutputs } from "../output/output-writer";
import { SystemActionError } from "./system-actions";
import type { PublicCliExitCode } from "./public-contract";
import { VIDEO_DIGEST_VERSION } from "../version";

async function runCli(args: string[], io: CliIO, dependencies: CliDependencies = {}): Promise<PublicCliExitCode> {
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
  test("transcript --stdout writes artifacts and emits exact clean text only", async () => {
    const logs: string[] = [];
    const writes: string[] = [];
    const errors: string[] = [];
    let fetchCalls = 0;
    const exitCode = await runCli(
      ["transcript", "https://youtu.be/1ZgUcrR0K7I", "--stdout"],
      { error: (message) => errors.push(message), log: (message) => logs.push(message), write: (message) => writes.push(message) },
      {
        fetchTranscriptOnly: async () => { fetchCalls += 1; return completedTranscriptOnly(); },
      },
    );
    expect(exitCode).toBe(0);
    expect(fetchCalls).toBe(1);
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
    expect(writes.join("")).toBe("Hello from the transcript.\n");
  });

  test("transcript actions copy clean text and open Markdown after writing artifacts", async () => {
    const calls: string[] = [];
    const exitCode = await runCli(
      ["transcript", "https://youtu.be/1ZgUcrR0K7I", "--copy", "--open"],
      { error: () => {}, log: () => {} },
      {
        fetchTranscriptOnly: async () => { calls.push("write"); return completedTranscriptOnly(); },
        systemActions: {
          copy: async (text) => { calls.push(`copy:${text}`); },
          openExternal: async () => {},
          open: async (path) => { calls.push(`open:${path}`); },
          reveal: async () => {},
        },
        openGeneratedTranscript: async ({ open, path }) => open(path),
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      "write",
      "copy:Hello from the transcript.\n",
      "open:outputs/transcripts/1ZgUcrR0K7I.md",
    ]);
  });

  test("holds the Artifact Library lock while opening the revalidated generated Markdown", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-action-open-"));
    const paths = await writeTranscriptOnlyOutputs({
      outputDir,
      transcript: transcriptFixture(),
      transcriptQuality: qualityFixture(),
      video: videoFixture(),
    });
    let writerWasFenced = false;
    const errors: string[] = [];
    const exitCode = await runCli(
      ["transcript", videoFixture().canonicalUrl, "--open", "--output-dir", outputDir],
      { error: (message) => errors.push(message), log: () => {} },
      {
        fetchTranscriptOnly: async () => ({ cleanText: "Useful content.\n", exitCode: 0, paths, status: "completed", transcriptQuality: qualityFixture() }),
        systemActions: {
          copy: async () => {},
          openExternal: async () => {},
          open: async (path) => {
            expect(path).toBe(paths.transcriptMarkdownPath);
            await expect(writeTranscriptOnlyOutputs({
              outputDir,
              transcript: transcriptFixture(),
              transcriptQuality: qualityFixture(),
              video: videoFixture(),
            })).rejects.toMatchObject({ code: "already-running" });
            writerWasFenced = true;
          },
          reveal: async () => {},
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(writerWasFenced).toBe(true);
  });

  test("refuses a swapped generated Markdown path before invoking the opener", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-action-swap-"));
    const paths = await writeTranscriptOnlyOutputs({
      outputDir,
      transcript: transcriptFixture(),
      transcriptQuality: qualityFixture(),
      video: videoFixture(),
    });
    const victim = join(outputDir, "outside.md");
    await writeFile(victim, "outside");
    await unlink(paths.transcriptMarkdownPath);
    await symlink(victim, paths.transcriptMarkdownPath);
    let openCalls = 0;
    const errors: string[] = [];
    const exitCode = await runCli(
      ["transcript", videoFixture().canonicalUrl, "--open", "--output-dir", outputDir],
      { error: (message) => errors.push(message), log: () => {} },
      {
        fetchTranscriptOnly: async () => ({ cleanText: "Useful content.\n", exitCode: 0, paths, status: "completed", transcriptQuality: qualityFixture() }),
        systemActions: { copy: async () => {}, openExternal: async () => {}, open: async () => { openCalls += 1; }, reveal: async () => {} },
      },
    );
    expect(exitCode).toBe(1);
    expect(openCalls).toBe(0);
    expect(errors).toEqual(["Could not open the transcript. Open the Markdown file from its reported path."]);
    expect(await readFile(victim, "utf8")).toBe("outside");
  });

  test.each([
    ["--copy", "copy-failed", "Could not copy the transcript. Ensure pbcopy is available and try again."],
    ["--open", "open-failed", "Could not open the transcript. Open the Markdown file from its reported path."],
  ] as const)("keeps committed artifacts and reports stable %s action failures", async (flag, code, message) => {
    let artifactsCommitted = false;
    const logs: string[] = [];
    const errors: string[] = [];
    const failure = new SystemActionError(code, message);
    const exitCode = await runCli(
      ["transcript", videoFixture().canonicalUrl, flag],
      { error: (value) => errors.push(value), log: (value) => logs.push(value) },
      {
        fetchTranscriptOnly: async () => { artifactsCommitted = true; return completedTranscriptOnly(); },
        openGeneratedTranscript: async ({ open, path }) => open(path),
        systemActions: {
          copy: async () => { throw failure; },
          openExternal: async () => { throw failure; },
          open: async () => { throw failure; },
          reveal: async () => {},
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(artifactsCommitted).toBe(true);
    expect(errors).toEqual([message]);
    expect(logs).not.toContain("Copied transcript text to the clipboard.");
    expect(logs).not.toContain("Opened transcript Markdown.");
  });

  test("json mode never performs system actions", async () => {
    let actions = 0;
    await runCli(
      ["transcript", "https://youtu.be/1ZgUcrR0K7I", "--json"],
      { error: () => {}, log: () => {} },
      {
        fetchTranscriptOnly: async () => completedTranscriptOnly(),
        systemActions: {
          copy: async () => { actions += 1; },
          openExternal: async () => { actions += 1; },
          open: async () => { actions += 1; },
          reveal: async () => { actions += 1; },
        },
      },
    );
    expect(actions).toBe(0);
  });

  test("prints package-backed version without loading application state", async () => {
    const logs: string[] = [];
    const exitCode = await runCli(["--version"], { error: () => {}, log: (message) => logs.push(message) }, {
      configStore: { load: async () => { throw new Error("must not load"); }, save: async () => {} },
    });
    expect(exitCode).toBe(0);
    expect(logs).toEqual([`video-digest ${VIDEO_DIGEST_VERSION}`]);
  });

  test("prints command-scoped transcript help", async () => {
    const logs: string[] = [];
    await runCli(["transcript", "--help"], { error: () => {}, log: (message) => logs.push(message) });
    expect(logs.join("\n")).toContain("video-digest transcript <youtube-url>");
    expect(logs.join("\n")).toContain("--copy");
    expect(logs.join("\n")).not.toContain("video-digest setup");
  });

  test("renders OSC 8 artifact paths only when capability is explicit", async () => {
    const linked: string[] = [];
    const plain: string[] = [];
    const deps = { fetchTranscriptOnly: async () => completedTranscriptOnly() };
    await runCli(["transcript", "https://youtu.be/1ZgUcrR0K7I"], { error: () => {}, log: (message) => linked.push(message), supportsHyperlinks: true }, deps);
    await runCli(["transcript", "https://youtu.be/1ZgUcrR0K7I"], { error: () => {}, log: (message) => plain.push(message), supportsHyperlinks: false }, deps);
    expect(linked.join("\n")).toContain("\u001b]8;;file://");
    expect(linked.join("\n")).toContain("outputs/transcripts/1ZgUcrR0K7I.md\u001b]8;;\u0007");
    expect(plain.join("\n")).not.toContain("\u001b]8;;");
  });

  test("sanitizes control characters in terminal paths and disables their hyperlinks", async () => {
    const logs: string[] = [];
    await runCli(
      ["transcript", "https://youtu.be/1ZgUcrR0K7I", "--output-dir", "/tmp/bad\n\u001b]8;;https://evil.example\u0007"],
      { error: () => {}, log: (message) => logs.push(message), supportsHyperlinks: true },
      { fetchTranscriptOnly: async () => completedTranscriptOnly("/tmp/bad\n\u001b]8;;https://evil.example\u0007") },
    );
    const output = logs.join("\n");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
    expect(output.split("\n")).toHaveLength(6);
    expect(output).toContain("�");
  });

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
      schemaVersion: "cli-result.v1",
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
    expect(saved).toEqual({
      artifactLibrary: "/chosen/library",
      digest: { defaultProvider: "opencode", models: {} },
      schemaVersion: "config.v1",
    });
  });

  test("persists provider and provider-scoped model without dropping config", async () => {
    let saved: AppConfig | null = {
      artifactLibrary: "/saved-library",
      digest: { defaultProvider: "opencode", models: { opencode: "existing-model" } },
      schemaVersion: "config.v1",
    };
    const configStore = {
      load: async () => saved,
      save: async (config: AppConfig) => { saved = config; },
    };
    await runCli(["config", "set", "provider", "anthropic"], { error: () => {}, log: () => {} }, { configStore });
    await runCli(["config", "set", "model", "claude-custom", "--provider", "anthropic"], { error: () => {}, log: () => {} }, { configStore });

    expect(saved).toEqual({
      artifactLibrary: "/saved-library",
      digest: { defaultProvider: "anthropic", models: { anthropic: "claude-custom", opencode: "existing-model" } },
      schemaVersion: "config.v1",
    });
  });

  test("reports effective artifact library in human and JSON config output without secrets", async () => {
    const human: string[] = [];
    const json: string[] = [];
    const dependencies = {
      appPaths: { configPath: "/config.json", defaultArtifactLibrary: "/default", runtimeDir: "/runtime" },
      configStore: { load: async () => ({ artifactLibrary: "/saved", digest: { defaultProvider: "opencode" as const, models: {} }, schemaVersion: "config.v1" as const }), save: async () => {} },
      credentialStore: fakeCredentialStore({ storedKey: "never-print-this" }),
      env: { VIDEO_DIGEST_OUTPUT_DIR: "/env" },
    };
    await runCli(["config", "get"], { error: () => {}, log: (message) => human.push(message) }, dependencies);
    await runCli(["config", "get", "--json"], { error: () => {}, log: (message) => json.push(message) }, dependencies);
    expect(human.join("\n")).toContain("Artifact Library: /env (env)");
    expect(human.join("\n")).toContain("Saved Artifact Library: /saved");
    expect(JSON.parse(json[0]!)).toMatchObject({
      artifactLibrary: { configured: "/saved", effective: "/env", source: "env" },
      credential: { configured: true, provider: "opencode", source: "keychain" },
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
        configStore: { load: async () => ({ artifactLibrary: "/saved", digest: { defaultProvider: "opencode", models: {} }, schemaVersion: "config.v1" }), save: async () => {} },
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
    expect(logs[0]).toBe("Video Digest");
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
          cleanText: "Hello from the transcript.\n",
          exitCode: 0,
          generation: testGeneration(),
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
        summarizerFactory: (_selection, apiKey) => ({
          generateDigest: async () => {
            seenApiKeys.push(apiKey ?? "");
            return { draft: digestDraftFixture(), generation: testGeneration() };
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

  test("resolves only the selected provider credential and passes the effective model", async () => {
    const credentialLookups: string[] = [];
    const selections: Array<{ apiKey: string; model: string; provider: string }> = [];
    const exitCode = await runCli(
      ["ingest", "https://youtu.be/1ZgUcrR0K7I", "--provider", "openai", "--model", "gpt-custom"],
      { error: () => {}, log: () => {} },
      {
        credentialStore: {
          deleteApiKey: async () => {},
          getApiKey: async (provider) => { credentialLookups.push(provider); return "openai-key"; },
          setApiKey: async () => {},
        },
        ingestVideo: async () => completedIngestion(),
        summarizerFactory: (selection, apiKey) => {
          selections.push({ apiKey, model: selection.model.effective, provider: selection.provider.effective });
          return { generateDigest: async () => ({ draft: digestDraftFixture(), generation: testGeneration() }) };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(credentialLookups).toEqual(["openai"]);
    expect(selections).toEqual([{ apiKey: "openai-key", model: "gpt-custom", provider: "openai" }]);
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
      generation: testGeneration(),
      schemaVersion: "cli-result.v1",
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
      model: "gpt-5.4-mini",
      provider: "opencode",
      schemaVersion: "cli-result.v1",
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
      schemaVersion: "cli-result.v1",
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
      schemaVersion: "cli-result.v1",
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
      model: "gpt-5.4-mini",
      provider: "opencode",
      schemaVersion: "cli-result.v1",
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
    expect(errors.join("\n")).toContain("Digest generation requires OPENCODE_API_KEY for OpenCode Zen.");
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
        message: "Digest generation requires OPENCODE_API_KEY for OpenCode Zen.\nTo fetch only the transcript, run:\n  video-digest transcript https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      },
      model: "gpt-5.4-mini",
      provider: "opencode",
      schemaVersion: "cli-result.v1",
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
      schemaVersion: "cli-result.v1",
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
    expect(logs.join("\n")).toContain("OpenCode Zen API key: configured via Keychain");
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
      credential: {
        configured: true,
        provider: "opencode",
        source: "keychain",
      },
      digest: {
        model: { effective: "gpt-5.4-mini", source: "default" },
        provider: { effective: "opencode", source: "default" },
      },
      schemaVersion: "config-status.v1",
    });
  });

  test("stores OpenCode key from config set prompt", async () => {
    const logs: string[] = [];
    const prompts: string[] = [];
    const stored: string[] = [];

    const exitCode = await runCli(
      ["config", "set", "api-key", "--provider", "opencode"],
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
    expect(prompts).toEqual(["OpenCode Zen API key: "]);
    expect(stored).toEqual(["secret-key"]);
    expect(logs.join("\n")).toContain("OpenCode Zen API key stored in macOS Keychain.");
    expect(logs.join("\n")).not.toContain("secret-key");
  });

  test("unsets OpenCode key", async () => {
    const logs: string[] = [];
    let deleted = false;

    const exitCode = await runCli(
      ["config", "unset", "api-key", "--provider", "opencode"],
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
    expect(logs).toEqual(["OpenCode Zen API key removed from macOS Keychain."]);
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
      schemaVersion: "doctor-report.v1",
    });
  });

  test("passes the resolved effective Artifact Library to doctor", async () => {
    let checkedPath = "";
    await runCli(["doctor"], { error: () => {}, log: () => {} }, {
      configStore: { load: async () => ({ artifactLibrary: "/saved", digest: { defaultProvider: "opencode", models: {} }, schemaVersion: "config.v1" }), save: async () => {} },
      env: { VIDEO_DIGEST_OUTPUT_DIR: "/effective-env" },
      doctor: async (path) => { checkedPath = path; return { checks: [], ok: true }; },
    });
    expect(checkedPath).toBe("/effective-env");
  });

  test("lists Library Entries in human and versioned json output", async () => {
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
    expect(logs.join("\n")).toContain("Generated Video Title");
    expect(jsonExit).toBe(0);
    expect(JSON.parse(jsonLogs[0]!)).toMatchObject({
      schemaVersion: "library-list.v0",
      items: [{
        channel: "Generated Channel",
        paths: {
          digestPath: join(outputDir, "digests", "1ZgUcrR0K7I.md"),
          metadataPath: join(outputDir, "metadata", "1ZgUcrR0K7I.json"),
        },
        title: "Generated Video Title",
        updatedAt: "2026-06-18T12:00:00.000Z",
        videoId: "1ZgUcrR0K7I",
      }],
    });
  });

  test("lists and resolves transcript-only Library Entries", async () => {
    const outputDir = await createOutputDirWithTranscript("1ZgUcrR0K7I");
    const listLogs: string[] = [];
    const openLogs: string[] = [];

    expect(await runCli(
      ["list", "--json"],
      { error: () => {}, log: (message) => listLogs.push(message) },
      { outputDir },
    )).toBe(0);
    expect(JSON.parse(listLogs[0]!)).toMatchObject({
      items: [{
        paths: {
          digestPath: null,
          transcriptMarkdownPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.md"),
        },
        videoId: "1ZgUcrR0K7I",
      }],
      schemaVersion: "library-list.v0",
    });

    expect(await runCli(
      ["open", "latest", "--json"],
      { error: () => {}, log: (message) => openLogs.push(message) },
      { outputDir },
    )).toBe(0);
    expect(JSON.parse(openLogs[0]!)).toMatchObject({
      openPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.md"),
      paths: { digestPath: null },
      schemaVersion: "open-result.v0",
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
      withRecoveredOutputLibrary: async (path, operation) => {
        events.push(`recover:${path}`);
        return operation();
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
      openPath: join(outputDir, "digests", "1ZgUcrR0K7I.md"),
      paths: { digestPath: join(outputDir, "digests", "1ZgUcrR0K7I.md") },
      schemaVersion: "open-result.v0",
      videoId: "1ZgUcrR0K7I",
    });
  });

  test("returns distinct stable open errors for absent and non-openable Library Entries", async () => {
    const outputDir = await createOutputDirWithTranscript("1ZgUcrR0K7I");
    await Bun.file(join(outputDir, "transcripts", "1ZgUcrR0K7I.md")).delete();

    for (const [target, code] of [
      ["AAAAAAAAAAA", "library-entry-not-found"],
      ["1ZgUcrR0K7I", "library-entry-not-openable"],
    ] as const) {
      const logs: string[] = [];
      const exitCode = await runCli(
        ["open", target, "--json"],
        { error: () => {}, log: (message) => logs.push(message) },
        { outputDir },
      );
      expect(exitCode).toBe(1);
      expect(JSON.parse(logs[0]!)).toMatchObject({
        error: { code },
        schemaVersion: "open-result.v0",
        status: "failed",
      });
    }
  });

  test.each(["readdir", "lstat", "open", "fstat", "read"] as const)(
    "reports an injected %s EACCES as a nonzero stable CLI error",
    async (stage) => {
      const outputDir = await createOutputDirWithTranscript("1ZgUcrR0K7I");
      const logs: string[] = [];
      const failure = Object.assign(new Error(`${stage} unavailable`), { code: "EACCES" });
      const metadataPath = join(outputDir, "metadata", "1ZgUcrR0K7I.json");
      const overrides: Partial<LibraryFileOperations> = stage === "readdir"
        ? { readdir: async () => { throw failure; } }
        : stage === "lstat"
          ? { lstat: async (path) => {
            if (path === metadataPath) throw failure;
            return lstat(path);
          } }
          : stage === "open"
            ? { open: async () => { throw failure; } }
            : { open: async (path, flags) => {
              const handle = await open(path, flags);
              return {
                close: () => handle.close(),
                readFile: stage === "read"
                  ? async () => { throw failure; }
                  : (options) => handle.readFile(options),
                stat: stage === "fstat"
                  ? async () => { throw failure; }
                  : () => handle.stat(),
              };
            } };

      const exitCode = await runCli(
        ["list", "--json"],
        { error: () => {}, log: (message) => logs.push(message) },
        { libraryFileOperations: mainLibraryOperations(overrides), outputDir },
      );

      expect(exitCode).toBe(1);
      expect(JSON.parse(logs[0]!)).toMatchObject({
        error: { code: "unexpected-error" },
        schemaVersion: "cli-result.v1",
        status: "failed",
      });
    },
  );

  test("revalidates the selected artifact under the library lock immediately before opening", async () => {
    const outputDir = await createOutputDirWithDigest("1ZgUcrR0K7I");
    const digestPath = join(outputDir, "digests", "1ZgUcrR0K7I.md");
    let digestLstats = 0;
    let openCalls = 0;
    const errors: string[] = [];
    const exitCode = await runCli(
      ["open", "latest"],
      { error: (message) => errors.push(message), log: () => {} },
      {
        libraryFileOperations: mainLibraryOperations({
          lstat: async (path) => {
            const stats = await lstat(path);
            if (path === digestPath && ++digestLstats === 3) {
              return {
                dev: stats.dev,
                ino: stats.ino + 1,
                isDirectory: () => stats.isDirectory(),
                isFile: () => stats.isFile(),
                isSymbolicLink: () => stats.isSymbolicLink(),
              };
            }
            return stats;
          },
        }),
        openPath: async () => { openCalls += 1; },
        outputDir,
      },
    );

    expect(exitCode).toBe(1);
    expect(openCalls).toBe(0);
    expect(errors.join("\n")).toContain("changed during validation");
  });

  test("revalidates the Library root after artifact inspection and before human openPath", async () => {
    const outputDir = await createOutputDirWithDigest("1ZgUcrR0K7I");
    const digestPath = join(outputDir, "digests", "1ZgUcrR0K7I.md");
    let rootSwapped = false;
    let openCalls = 0;
    const errors: string[] = [];
    const exitCode = await runCli(
      ["open", "latest"],
      { error: (message) => errors.push(message), log: () => {} },
      {
        libraryFileOperations: mainLibraryOperations({
          lstat: async (path) => {
            const stats = await lstat(path);
            if (path === outputDir && rootSwapped) {
              return {
                dev: stats.dev,
                ino: stats.ino + 1,
                isDirectory: () => true,
                isFile: () => false,
                isSymbolicLink: () => false,
              };
            }
            return stats;
          },
          open: async (path, flags) => {
            const handle = await open(path, flags);
            if (path === digestPath) rootSwapped = true;
            return handle;
          },
        }),
        openPath: async () => { openCalls += 1; },
        outputDir,
      },
    );

    expect(exitCode).toBe(1);
    expect(openCalls).toBe(0);
    expect(errors.join("\n")).toContain("changed during validation");
  });

  test.each(["symlink-retarget", "canonical-target-replacement"] as const)(
    "fails closed before the opener on linked Library root %s",
    async (rootChange) => {
      const targetDir = await createOutputDirWithDigest("1ZgUcrR0K7I");
      const canonicalTarget = await realpath(targetDir);
      const linkParent = await mkdtemp(join(tmpdir(), "video-digest-cli-linked-"));
      const outputDir = join(linkParent, "library");
      await symlink(targetDir, outputDir);
      const digestPath = join(outputDir, "digests", "1ZgUcrR0K7I.md");
      let changed = false;
      let openCalls = 0;
      const errors: string[] = [];

      const exitCode = await runCli(
        ["open", "latest"],
        { error: (message) => errors.push(message), log: () => {} },
        {
          libraryFileOperations: mainLibraryOperations({
            lstat: async (path) => {
              const stats = await lstat(path);
              if (changed && rootChange === "symlink-retarget" && path === outputDir) {
                return {
                  dev: stats.dev,
                  ino: stats.ino + 1,
                  isDirectory: () => false,
                  isFile: () => false,
                  isSymbolicLink: () => true,
                };
              }
              if (changed && rootChange === "canonical-target-replacement" && path === canonicalTarget) {
                return {
                  dev: stats.dev,
                  ino: stats.ino + 1,
                  isDirectory: () => true,
                  isFile: () => false,
                  isSymbolicLink: () => false,
                };
              }
              return stats;
            },
            open: async (path, flags) => {
              const handle = await open(path, flags);
              if (path === digestPath) changed = true;
              return handle;
            },
            readlink: async (path) => changed && rootChange === "symlink-retarget" && path === outputDir
              ? "retargeted-library"
              : readlink(path),
          }),
          openPath: async () => { openCalls += 1; },
          outputDir,
        },
      );

      expect(exitCode).toBe(1);
      expect(openCalls).toBe(0);
      expect(errors.join("\n")).toContain("changed during validation");
    },
  );

  test("keeps the library lock while human openPath is running", async () => {
    const outputDir = await createOutputDirWithDigest("1ZgUcrR0K7I");
    const events: string[] = [];

    const exitCode = await runCli(
      ["open", "latest"],
      { error: () => {}, log: () => {} },
      {
        openPath: async () => { events.push("open"); },
        outputDir,
        withRecoveredOutputLibrary: async (_path, operation) => {
          events.push("lock-enter");
          const result = await operation();
          events.push("lock-exit");
          return result;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(events).toEqual(["lock-enter", "open", "lock-exit"]);
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
            cleanText: "Hello from the transcript.\n",
            exitCode: 0,
            generation: testGeneration(),
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
            cleanText: "Hello from the transcript.\n",
            exitCode: 0,
            generation: testGeneration(),
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

    const exitCode = await runCli(["ingest"], {
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

  test("launches the TUI for no arguments only when stdin and stdout are TTYs", async () => {
    let starts = 0;
    let prompts = 0;
    const exitCode = await runCli(
      [],
      {
        error: () => {},
        inputIsTTY: true,
        outputIsTTY: true,
        log: () => {},
        prompt: async () => { prompts += 1; return ""; },
      },
      { startTui: async () => { starts += 1; return 0; } },
    );

    expect(exitCode).toBe(0);
    expect(starts).toBe(1);
    expect(prompts).toBe(0);
  });

  test.each([
    [true, false],
    [false, true],
    [false, false],
  ] as const)("prints help and never initializes the TUI with stdinTTY=%s stdoutTTY=%s", async (inputIsTTY, outputIsTTY) => {
    const logs: string[] = [];
    let starts = 0;
    let prompts = 0;
    const exitCode = await runCli(
      [],
      {
        error: () => {},
        inputIsTTY,
        outputIsTTY,
        log: (message) => logs.push(message),
        prompt: async () => { prompts += 1; return ""; },
      },
      { startTui: async () => { starts += 1; return 0; } },
    );

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("video-digest ingest <youtube-url>");
    expect(starts).toBe(0);
    expect(prompts).toBe(0);
  });

  test("does not infer full interactivity from the legacy output-only TTY hint", async () => {
    const logs: string[] = [];
    let starts = 0;
    const exitCode = await runCli([], {
      error: () => {},
      isTTY: true,
      log: (message) => logs.push(message),
    }, { startTui: async () => { starts += 1; return 0; } });

    expect(exitCode).toBe(1);
    expect(starts).toBe(0);
    expect(logs.join("\n")).toContain("Usage:");
  });

  test("direct commands never initialize the TUI", async () => {
    let starts = 0;
    const exitCode = await runCli(
      ["--help"],
      { error: () => {}, inputIsTTY: true, log: () => {}, outputIsTTY: true },
      { startTui: async () => { starts += 1; return 0; } },
    );

    expect(exitCode).toBe(0);
    expect(starts).toBe(0);
  });
});

function completedIngestion(): IngestVideoResult {
  return {
    cleanText: "Hello from the transcript.\n",
    exitCode: 0,
    generation: testGeneration(),
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

function testGeneration() {
  return {
    provider: "opencode" as const,
    requestId: null,
    requestedModel: "gpt-5.4-mini",
    responseModel: null,
    usage: null,
  };
}

function completedTranscriptOnly(outputDir = "outputs"): FetchTranscriptOnlyResult {
  return {
    cleanText: "Hello from the transcript.\n",
    exitCode: 0,
    paths: {
      metadataPath: join(outputDir, "metadata", "1ZgUcrR0K7I.json"),
      transcriptJsonPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.json"),
      transcriptMarkdownPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.md"),
      transcriptTextPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.txt"),
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

function videoFixture() {
  return {
    canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
    videoId: "1ZgUcrR0K7I",
  };
}

function qualityFixture(): TranscriptQuality {
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
      generation: testGeneration(),
      metadataSchemaVersion: "metadata.v1",
      processedAt: "2026-06-18T12:00:00.000Z",
      digest: {
        digestTitle: "Generated Digest Title",
      },
      video: {
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        channel: "Generated Channel",
        durationSeconds: 60,
        videoId,
        videoTitle: "Generated Video Title",
      },
      videoDigestVersion: VIDEO_DIGEST_VERSION,
    }),
    { flag: "w" },
  );

  expect(await readFile(digestPath, "utf8")).toContain("Generated Digest Title");
  return outputDir;
}

async function createOutputDirWithTranscript(videoId: string): Promise<string> {
  const outputDir = await mkdtemp(join(tmpdir(), "video-digest-cli-transcript-"));
  await mkdir(join(outputDir, "metadata"), { recursive: true });
  await mkdir(join(outputDir, "transcripts"), { recursive: true });
  await writeFile(join(outputDir, "transcripts", `${videoId}.md`), "# Transcript\n");
  await writeFile(join(outputDir, "transcripts", `${videoId}.json`), "{}\n");
  await writeFile(join(outputDir, "transcripts", `${videoId}.txt`), "Transcript\n");
  await writeFile(join(outputDir, "metadata", `${videoId}.json`), JSON.stringify({
    digest: null,
    generation: null,
    metadataSchemaVersion: "metadata.v1",
    mode: "transcript-only",
    processedAt: "2026-06-18T12:00:00.000Z",
    transcriptQuality: {},
    video: {
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      channel: null,
      durationSeconds: 60,
      videoId,
      videoTitle: null,
    },
    videoDigestVersion: VIDEO_DIGEST_VERSION,
  }));
  return outputDir;
}

function mainLibraryOperations(overrides: Partial<LibraryFileOperations> = {}) {
  return { lstat, open, readdir, realpath, ...overrides } as never;
}

function fakeCredentialStore(options: {
  deleteKey?: () => Promise<void>;
  setKey?: (value: string) => Promise<void>;
  storedKey?: string | null;
}): CredentialStore {
  return {
    deleteApiKey: options.deleteKey ?? (async () => {}),
    getApiKey: async () => options.storedKey ?? null,
    setApiKey: async (_provider, value) => options.setKey?.(value),
  };
}
