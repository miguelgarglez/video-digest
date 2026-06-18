import { stdin, stdout } from "node:process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { listArtifacts, resolveOpenTarget, type ArtifactEntry } from "./artifacts";
import {
  MacOSKeychainCredentialStore,
  resolveOpenCodeApiKey,
  type CredentialStore,
} from "./credentials";
import { defaultDoctor, type DoctorReport } from "./doctor";
import { parseCliArgs, type CliOptions } from "./parse-args";
import { createProgressRenderer } from "./progress-renderer";
import { resolveAppPaths, type AppPaths } from "./app-paths";
import { resolveArtifactLibrary } from "./artifact-library";
import { FileConfigStore, type AppConfig } from "./config-store";
import {
  ingestVideo,
  type IngestVideoInput,
  type IngestVideoResult,
} from "../ingestion/ingest-video";
import {
  fetchTranscriptOnly,
  type FetchTranscriptOnlyInput,
  type FetchTranscriptOnlyResult,
} from "../ingestion/transcript-only";
import { OpenCodeSummarizer } from "../summarizer/opencode-summarizer";
import { SummarizerError, type Summarizer } from "../summarizer/summarizer";
import { PythonYoutubeTranscriptSource } from "../transcript/python-youtube-transcript-source";
import { TranscriptSourceError } from "../transcript/transcript-source";

export type CliIO = {
  error: (message: string) => void;
  isTTY?: boolean;
  log: (message: string) => void;
  prompt?: (question: string) => Promise<string>;
  write?: (message: string) => void;
};

export type CliDependencies = {
  appPaths?: AppPaths;
  configStore?: Pick<FileConfigStore, "load" | "save">;
  credentialStore?: CredentialStore;
  doctor?: () => Promise<DoctorReport>;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  fetchTranscriptOnly?: (input: FetchTranscriptOnlyInput) => Promise<FetchTranscriptOnlyResult>;
  ingestVideo?: (input: IngestVideoInput) => Promise<IngestVideoResult>;
  openPath?: (path: string) => Promise<void>;
  outputDir?: string;
  spinnerIntervalMs?: number;
  summarizerFactory?: (apiKey: string | null) => Summarizer;
};

export async function runCli(
  args: string[],
  io: CliIO = defaultCliIO,
  dependencies: CliDependencies = {},
): Promise<number> {
  try {
    const result = await resolveCliOptions(args, io);

    if (!result.ok) {
      if (args.includes("--json")) {
        io.log(JSON.stringify({
          error: {
            code: result.error.code,
            message: result.error.message,
          },
          schemaVersion: "cli-result.v0",
          status: "failed",
        }));
      } else {
        io.error(result.error.message);
      }
      return 1;
    }

    if (result.value.command === "help") {
      printHelp(io);
      return 0;
    }

    const env = dependencies.env ?? process.env;
    const appPaths = dependencies.appPaths ?? resolveAppPaths(dependencies.homeDir ?? homedir());
    const configStore = dependencies.configStore ?? new FileConfigStore(appPaths.configPath);
    const config = await configStore.load();
    const outputDir = resolveArtifactLibrary({
      cliOutputDir: ("outputDir" in result.value ? result.value.outputDir : undefined) ?? dependencies.outputDir,
      defaultArtifactLibrary: appPaths.defaultArtifactLibrary,
      envOutputDir: env.VIDEO_DIGEST_OUTPUT_DIR,
      savedArtifactLibrary: config?.artifactLibrary,
    });
    const credentialStore = dependencies.credentialStore ?? new MacOSKeychainCredentialStore();

    if (result.value.command === "config") {
      return await runConfigCommand(result.value, io, credentialStore, configStore, env, outputDir);
    }

    if (result.value.command === "doctor") {
      const report = dependencies.doctor
        ? await dependencies.doctor()
        : await defaultDoctor(credentialStore);
      if (result.value.json) {
        io.log(JSON.stringify({ schemaVersion: "doctor-report.v0", ...report }));
      } else {
        printDoctorReport(report, io);
      }
      return report.ok ? 0 : 1;
    }

    if (result.value.command === "list") {
      const items = await listArtifacts(outputDir);
      if (result.value.json) {
        io.log(JSON.stringify({ items, schemaVersion: "artifact-list.v0" }));
      } else {
        printArtifactList(items, io);
      }
      return 0;
    }

    if (result.value.command === "open") {
      const openResult = await resolveOpenTarget(outputDir, result.value.target);

      if (!openResult.ok) {
        const payload = {
          error: {
            code: "digest-not-found",
            message: openResult.message,
          },
          schemaVersion: "open-result.v0",
          status: "failed",
        };

        if (result.value.json) {
          io.log(JSON.stringify(payload));
        } else {
          io.error(openResult.message);
        }
        return 1;
      }

      if (result.value.json) {
        io.log(JSON.stringify({ schemaVersion: "open-result.v0", ...openResult.item }));
      } else {
        await (dependencies.openPath ?? openWithSystem)(openResult.item.digestPath);
        io.log(`Opened digest: ${openResult.item.digestPath}`);
      }

      return 0;
    }

    if (result.value.command === "transcript") {
      const { json, video } = result.value;
      const fetchTranscript = dependencies.fetchTranscriptOnly ?? fetchTranscriptOnly;
      return await runTranscriptCommand({
        fetchTranscript,
        io,
        json,
        outputDir,
        spinnerIntervalMs: dependencies.spinnerIntervalMs,
        video,
      });
    }

    const { emailPreview, json, video } = result.value;
    const ingest = dependencies.ingestVideo ?? ingestVideo;
    const credential = await resolveOpenCodeApiKey({
      env,
      store: credentialStore,
    });
    let apiKey = credential.value;

    if (!apiKey && !json && io.prompt) {
      const configured = await promptForOpenCodeApiKey(io, credentialStore);

      if (configured.mode === "configured") {
        apiKey = configured.apiKey;
      } else if (configured.mode === "transcript-only") {
        return await runTranscriptCommand({
          fetchTranscript: dependencies.fetchTranscriptOnly ?? fetchTranscriptOnly,
          io,
          json: false,
          outputDir,
          spinnerIntervalMs: dependencies.spinnerIntervalMs,
          video,
        });
      } else {
        io.error("Digest generation cancelled because OPENCODE_API_KEY is not configured.");
        return 1;
      }
    }

    const summarizerFactory = dependencies.summarizerFactory
      ?? ((apiKey: string | null) => new OpenCodeSummarizer({ apiKey: apiKey ?? "" }));
    const progress = json ? null : createProgressRenderer(io, {
      intervalMs: dependencies.spinnerIntervalMs,
    });

    const ingestion = await ingest({
      emailPreview,
      onProgress: progress?.handle,
      outputDir,
      summarizer: summarizerFactory(apiKey),
      transcriptSource: new PythonYoutubeTranscriptSource(),
      video,
    }).finally(() => progress?.stop());

    if (json) {
      printIngestionJson(video.canonicalUrl, video.videoId, ingestion, io);
    } else {
      printIngestionResult(video.videoId, ingestion, io);
    }
    return ingestion.exitCode;
  } catch (error) {
    const parsed = parseCliArgs(args);
    const parsedVideo = parsed.ok && (parsed.value.command === "ingest" || parsed.value.command === "transcript")
      ? parsed.value.video
      : undefined;
    const cliError = formatCliError(error, parsedVideo);

    if (parsed.ok && "json" in parsed.value && parsed.value.json) {
      io.log(JSON.stringify({
        error: {
          code: cliError.code,
          message: cliError.message,
        },
        schemaVersion: "cli-result.v0",
        status: "failed",
        videoId: parsedVideo?.videoId,
      }));
    } else {
      io.error(cliError.message);
    }
    return cliError.exitCode;
  }
}

function formatCliError(
  error: unknown,
  video?: { canonicalUrl: string },
): { code: string; exitCode: number; message: string } {
  if (error instanceof TranscriptSourceError && error.code === "transcript-unavailable") {
    const providerReason = extractProviderReason(error.message);
    const lines = [
      "No transcript is available for this video.",
      providerReason ? `Provider reason: ${providerReason}` : null,
      "Digest generation was skipped. Try another video or a future transcript fallback.",
    ];

    return {
      code: "transcript-unavailable",
      exitCode: 2,
      message: lines.filter((line): line is string => line !== null).join("\n"),
    };
  }

  if (error instanceof TranscriptSourceError) {
    return {
      code: error.code,
      exitCode: 1,
      message: `Transcript provider failed: ${error.message}`,
    };
  }

  if (error instanceof SummarizerError && error.code === "missing-api-key") {
    const transcriptCommand = video
      ? `video-digest transcript ${video.canonicalUrl}`
      : "video-digest transcript <youtube-url>";
    return {
      code: "missing-api-key",
      exitCode: 1,
      message: [
        "Digest generation requires OPENCODE_API_KEY.",
        "To fetch only the transcript, run:",
        `  ${transcriptCommand}`,
      ].join("\n"),
    };
  }

  if (error instanceof SummarizerError) {
    return {
      code: error.code,
      exitCode: 1,
      message: `Digest provider failed: ${error.message}`,
    };
  }

  if (error instanceof Error) {
    return {
      code: "unexpected-error",
      exitCode: 1,
      message: error.message,
    };
  }

  return {
    code: "unexpected-error",
    exitCode: 1,
    message: "Video ingestion failed",
  };
}

function extractProviderReason(message: string): string | null {
  const lines = message.split("\n").map((line) => line.trim());
  const causeIndex = lines.findIndex((line) => line === "This is most likely caused by:");

  if (causeIndex === -1) {
    return null;
  }

  return lines.slice(causeIndex + 1).find((line) => line.length > 0) ?? null;
}

const HELP_TEXT = [
  "Personal Video Digest",
  "",
  "Usage:",
  "  video-digest ingest <youtube-url> [--email-preview] [--json] [--output-dir <path>]",
  "  video-digest transcript <youtube-url> [--json] [--output-dir <path>]",
  "  video-digest config <get|set|unset> [opencode-api-key] [--json]",
  "  video-digest config set output-dir <path> [--json]",
  "  video-digest doctor [--json]",
  "  video-digest list [--json] [--output-dir <path>]",
  "  video-digest open <latest|video-id> [--json] [--output-dir <path>]",
  "",
  "Compatibility:",
  "  bun run video-digest <youtube-url> [--email-preview]",
  "  bun run video-digest",
  "  bun run video-digest --help",
  "",
  "Options:",
  "  --email-preview  Also write a Markdown email preview under outputs/emails/.",
  "  --json           Write one machine-readable JSON object.",
  "  --output-dir     Override the Artifact Library for this command.",
  "  --help, -h       Show this help message.",
  "",
  "Interactive mode:",
  "  Run without arguments to choose Digest or Transcript only.",
  "",
  "Environment:",
  "  OPENCODE_API_KEY      Required for digest generation with ingest.",
  "  OPENCODE_MODEL        Defaults to gpt-5.4-nano via .env.example.",
  "  VIDEO_DIGEST_OUTPUT_DIR  Overrides the configured Artifact Library.",
  "",
  "Transcript mode:",
  "  video-digest transcript <youtube-url> does not require OPENCODE_API_KEY.",
  "",
  "Configuration:",
  "  video-digest config set opencode-api-key stores the key in macOS Keychain.",
].join("\n");

const defaultCliIO: CliIO = {
  error: (message) => console.error(message),
  isTTY: stdout.isTTY,
  log: (message) => console.log(message),
  prompt: promptFromTerminal,
  write: (message) => stdout.write(message),
};

if (import.meta.main) {
  const exitCode = await runCli(Bun.argv.slice(2));
  process.exit(exitCode);
}

async function resolveCliOptions(args: string[], io: CliIO): Promise<ReturnType<typeof parseCliArgs>> {
  const parsed = parseCliArgs(args);

  if (parsed.ok || parsed.error.code !== "missing-url" || !io.prompt || args.includes("--json")) {
    return parsed;
  }

  const mode = (await io.prompt("What do you want to create? [1] Digest [2] Transcript only: ")).trim();
  const url = (await io.prompt("YouTube URL: ")).trim();

  if (mode === "2" || mode.toLowerCase() === "transcript") {
    return parseCliArgs(["transcript", url]);
  }

  const emailPreview = args.includes("--email-preview") || isAffirmative(
    await io.prompt("Create email preview? [y/N]: "),
  );

  return parseCliArgs(["ingest", url, ...(emailPreview ? ["--email-preview"] : [])]);
}

async function runConfigCommand(
  command: Extract<CliOptions, { command: "config" }>,
  io: CliIO,
  credentialStore: CredentialStore,
  configStore: Pick<FileConfigStore, "load" | "save">,
  env: Record<string, string | undefined>,
  artifactLibrary: string,
): Promise<number> {
  if (command.subcommand === "get") {
    const credential = await resolveOpenCodeApiKey({
      env,
      store: credentialStore,
    });
    const configured = credential.source !== "missing";
    const sourceLabel = credential.source === "keychain" ? "Keychain" : credential.source;

    if (command.json) {
      io.log(JSON.stringify({
        artifactLibrary,
        opencodeApiKey: {
          configured,
          source: credential.source,
        },
        schemaVersion: "config-status.v0",
      }));
    } else {
      io.log(configured
        ? `OpenCode API key: configured via ${sourceLabel}`
        : "OpenCode API key: not configured");
      io.log(`Artifact Library: ${artifactLibrary}`);
    }
    return 0;
  }

  if (command.subcommand === "set") {
    if (command.key === "output-dir") {
      const config: AppConfig = {
        artifactLibrary: command.value!,
        schemaVersion: "config.v0",
      };
      await configStore.save(config);
      if (command.json) {
        io.log(JSON.stringify({ artifactLibrary: config.artifactLibrary, schemaVersion: "config-result.v0", status: "saved" }));
      } else {
        io.log(`Artifact Library saved: ${config.artifactLibrary}`);
      }
      return 0;
    }
    if (command.json) {
      io.log(JSON.stringify({
        error: {
          code: "interactive-required",
          message: "config set opencode-api-key requires an interactive prompt.",
        },
        schemaVersion: "config-result.v0",
        status: "failed",
      }));
      return 1;
    }

    if (!io.prompt) {
      io.error("config set opencode-api-key requires an interactive terminal.");
      return 1;
    }

    const apiKey = (await io.prompt("OpenCode API key: ")).trim();
    if (!apiKey) {
      io.error("OpenCode API key cannot be empty.");
      return 1;
    }

    await credentialStore.setOpenCodeApiKey(apiKey);
    io.log("OpenCode API key stored in macOS Keychain.");
    return 0;
  }

  await credentialStore.deleteOpenCodeApiKey();
  if (command.json) {
    io.log(JSON.stringify({
      opencodeApiKey: {
        configured: false,
      },
      schemaVersion: "config-result.v0",
      status: "deleted",
    }));
  } else {
    io.log("OpenCode API key removed from macOS Keychain.");
  }
  return 0;
}

async function promptFromTerminal(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Interactive mode requires a terminal.");
  }

  const readline = createInterface({
    input: stdin,
    output: stdout,
  });

  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}

function isAffirmative(answer: string): boolean {
  return ["s", "si", "sí", "y", "yes"].includes(answer.trim().toLowerCase());
}

function isNegative(answer: string): boolean {
  return ["n", "no"].includes(answer.trim().toLowerCase());
}

function printHelp(io: CliIO): void {
  for (const line of HELP_TEXT.split("\n")) {
    io.log(line);
  }
}

async function runTranscriptCommand(input: {
  fetchTranscript: (input: FetchTranscriptOnlyInput) => Promise<FetchTranscriptOnlyResult>;
  io: CliIO;
  json: boolean;
  outputDir: string;
  spinnerIntervalMs?: number;
  video: { canonicalUrl: string; videoId: string };
}): Promise<number> {
  const progress = input.json ? null : createProgressRenderer(input.io, {
    intervalMs: input.spinnerIntervalMs,
  });

  const transcriptResult = await input.fetchTranscript({
    onProgress: progress?.handle,
    outputDir: input.outputDir,
    transcriptSource: new PythonYoutubeTranscriptSource(),
    video: input.video,
  }).finally(() => progress?.stop());

  if (input.json) {
    printTranscriptJson(input.video.canonicalUrl, input.video.videoId, transcriptResult, input.io);
  } else {
    printTranscriptResult(input.video.videoId, transcriptResult, input.io);
  }
  return transcriptResult.exitCode;
}

async function promptForOpenCodeApiKey(
  io: CliIO,
  credentialStore: CredentialStore,
): Promise<
  | { apiKey: string; mode: "configured" }
  | { mode: "cancelled" }
  | { mode: "transcript-only" }
> {
  io.log("Digest generation needs an OpenCode API key.");
  io.log("");
  io.log("Get an OpenCode API key:");
  io.log("https://opencode.ai/zen");
  io.log("");

  const shouldPaste = !isNegative(await io.prompt!("Paste API key now? [Y/n]: "));

  if (shouldPaste) {
    const apiKey = (await io.prompt!("OpenCode API key: ")).trim();

    if (!apiKey) {
      io.error("OpenCode API key cannot be empty.");
      return { mode: "cancelled" };
    }

    const shouldSave = !isNegative(await io.prompt!("Save this key in macOS Keychain for future runs? [Y/n]: "));
    if (shouldSave) {
      await credentialStore.setOpenCodeApiKey(apiKey);
      io.log("OpenCode API key stored in macOS Keychain.");
    }

    return {
      apiKey,
      mode: "configured",
    };
  }

  const fallback = !isNegative(await io.prompt!("Continue with transcript only instead? [Y/n]: "));
  return fallback ? { mode: "transcript-only" } : { mode: "cancelled" };
}

function printIngestionResult(videoId: string, result: IngestVideoResult, io: CliIO): void {
  if (result.status === "unusable-transcript") {
    io.error(`Transcript quality: ${result.transcriptQuality.status}`);
    io.error(`Metadata: ${result.metadataPath}`);
    return;
  }

  io.log(`Ingested video ${videoId}`);
  io.log(`Transcript quality: ${result.transcriptQuality.status}`);
  io.log(`Transcript artifact: ${result.paths.transcriptPath}`);
  io.log(`Digest: ${result.paths.digestPath}`);
  io.log(`Metadata: ${result.paths.metadataPath}`);

  if (result.paths.emailPreviewPath) {
    io.log(`Email preview: ${result.paths.emailPreviewPath}`);
  }
}

function printIngestionJson(
  canonicalUrl: string,
  videoId: string,
  result: IngestVideoResult,
  io: CliIO,
): void {
  if (result.status === "unusable-transcript") {
    io.log(JSON.stringify({
      metadataPath: result.metadataPath,
      schemaVersion: "cli-result.v0",
      status: "unusable-transcript",
      transcriptQuality: result.transcriptQuality.status,
      videoId,
    }));
    return;
  }

  io.log(JSON.stringify({
    canonicalUrl,
    paths: result.paths,
    schemaVersion: "cli-result.v0",
    status: result.status,
    transcriptQuality: result.transcriptQuality.status,
    videoId,
  }));
}

function printTranscriptResult(
  videoId: string,
  result: FetchTranscriptOnlyResult,
  io: CliIO,
): void {
  io.log(`Fetched transcript for ${videoId}`);
  io.log(`Transcript quality: ${result.transcriptQuality.status}`);
  io.log(`Transcript artifact: ${result.paths.transcriptPath}`);
  io.log(`Metadata: ${result.paths.metadataPath}`);
}

function printTranscriptJson(
  canonicalUrl: string,
  videoId: string,
  result: FetchTranscriptOnlyResult,
  io: CliIO,
): void {
  io.log(JSON.stringify({
    canonicalUrl,
    paths: result.paths,
    schemaVersion: "cli-result.v0",
    status: result.status,
    transcriptQuality: result.transcriptQuality.status,
    videoId,
  }));
}

function printDoctorReport(report: DoctorReport, io: CliIO): void {
  io.log(report.ok ? "Doctor checks passed" : "Doctor checks failed");

  for (const check of report.checks) {
    const label = check.status === "pass" ? "ok" : check.status;
    io.log(`[${label}] ${check.capability}/${check.id}: ${check.message}`);
    if (check.remediation) {
      io.log(`  Fix: ${check.remediation}`);
    }
  }
}

function printArtifactList(items: ArtifactEntry[], io: CliIO): void {
  if (items.length === 0) {
    io.log("No digests found.");
    return;
  }

  for (const item of items) {
    io.log(`${item.videoId}  ${item.digestTitle ?? "(untitled)"}  ${item.digestPath}`);
  }
}

async function openWithSystem(path: string): Promise<void> {
  const process = Bun.spawn(["open", path], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`Could not open digest: ${path}`);
  }
}
