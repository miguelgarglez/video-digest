import { stdin, stdout } from "node:process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import {
  listLibraryEntries,
  resolveLibraryEntry,
  revalidateLibraryOpenTarget,
  type LibraryEntry,
  type LibraryFileOperations,
} from "./artifacts";
import {
  MacOSKeychainCredentialStore,
  resolveOpenCodeApiKey,
  type CredentialStore,
} from "./credentials";
import { defaultDoctor, type DoctorReport } from "./doctor";
import { parseCliArgs, type CliOptions } from "./parse-args";
import { createProgressRenderer } from "./progress-renderer";
import { resolveAppPaths, type AppPaths } from "./app-paths";
import { resolveArtifactLibrary, type ArtifactLibraryResolution } from "./artifact-library";
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
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { resolvePackageResources } from "./package-resources";
import { inspectRuntime, prepareRuntime, resolveUvExecutable, RuntimeSetupError, type RuntimeReadiness } from "./runtime-manager";
import { withRecoveredOutputLibrary } from "../output/output-writer";
import type { VideoMetadataSource } from "../video/video-metadata-source";
import { YouTubeOEmbedMetadataSource } from "../video/youtube-oembed-metadata-source";
import { createMacOSSystemActions, SystemActionError, type SystemActions } from "./system-actions";
import {
  PUBLIC_CLI_ERROR_CODE,
  PUBLIC_CLI_SCHEMA,
  type PublicCliErrorCode,
} from "./public-contract";

export type CliIO = {
  error: (message: string) => void;
  inputIsTTY?: boolean;
  /** @deprecated Use outputIsTTY. Retained for direct-command progress compatibility. */
  isTTY?: boolean;
  log: (message: string) => void;
  outputIsTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
  supportsHyperlinks?: boolean;
  write?: (message: string) => void;
};

export type CliDependencies = {
  appPaths?: AppPaths;
  configStore?: Pick<FileConfigStore, "load" | "save">;
  credentialStore?: CredentialStore;
  doctor?: (outputDir: string) => Promise<DoctorReport>;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  fetchTranscriptOnly?: (input: FetchTranscriptOnlyInput) => Promise<FetchTranscriptOnlyResult>;
  ingestVideo?: (input: IngestVideoInput) => Promise<IngestVideoResult>;
  libraryFileOperations?: Partial<LibraryFileOperations>;
  metadataSource?: VideoMetadataSource;
  openGeneratedTranscript?: (input: {
    open: (path: string) => Promise<void>;
    outputDir: string;
    path: string;
    videoId: string;
  }) => Promise<void>;
  openPath?: (path: string) => Promise<void>;
  outputDir?: string;
  systemActions?: SystemActions;
  withRecoveredOutputLibrary?: <T>(outputDir: string, operation: () => Promise<T>) => Promise<T>;
  runtimeManager?: RuntimeManager;
  spinnerIntervalMs?: number;
  startTui?: () => Promise<number>;
  summarizerFactory?: (apiKey: string | null) => Summarizer;
};

export type RuntimeManager = {
  inspect: () => Promise<RuntimeReadiness>;
  prepare: () => Promise<void>;
};

export async function runCli(
  args: string[],
  io: CliIO = defaultCliIO,
  dependencies: CliDependencies = {},
): Promise<number> {
  try {
    if (args.length === 0) {
      if (io.inputIsTTY !== true || io.outputIsTTY !== true) {
        printHelp(io);
        return 1;
      }
      if (dependencies.startTui) return await dependencies.startTui();
      const { startTui } = await import("../tui/start");
      return await startTui({ onError: io.error });
    }

    const result = parseCliArgs(args);

    if (!result.ok) {
      if (args.includes("--json")) {
        io.log(JSON.stringify({
          error: {
            code: result.error.code,
            message: result.error.message,
          },
          schemaVersion: args[0] === "setup" ? PUBLIC_CLI_SCHEMA.setupResult : PUBLIC_CLI_SCHEMA.cliResult,
          status: "failed",
        }));
      } else {
        io.error(result.error.message);
      }
      return 1;
    }

    if (result.value.command === "help") {
      printHelp(io, result.value.topic);
      return 0;
    }

    if (result.value.command === "version") {
      const resources = resolvePackageResources(import.meta.url);
      const metadata = JSON.parse(await readFile(resources.packageJson, "utf8")) as { version?: unknown };
      if (typeof metadata.version !== "string") throw new Error("Package version is unavailable.");
      io.log(`video-digest ${metadata.version}`);
      return 0;
    }

    const env = dependencies.env ?? process.env;
    const appPaths = dependencies.appPaths ?? resolveAppPaths(dependencies.homeDir ?? homedir());
    const runtimeManager = dependencies.runtimeManager ?? createRuntimeManager(appPaths, env);

    if (result.value.command === "setup") {
      return await runSetupCommand(result.value, io, runtimeManager);
    }

    const configStore = dependencies.configStore ?? new FileConfigStore(appPaths.configPath);
    const config = await configStore.load();
    const artifactLibrary = resolveArtifactLibrary({
      cliOutputDir: ("outputDir" in result.value ? result.value.outputDir : undefined) ?? dependencies.outputDir,
      defaultArtifactLibrary: appPaths.defaultArtifactLibrary,
      envOutputDir: env.VIDEO_DIGEST_OUTPUT_DIR,
      savedArtifactLibrary: config?.artifactLibrary,
    });
    const credentialStore = dependencies.credentialStore ?? new MacOSKeychainCredentialStore();

    if (result.value.command === "config") {
      return await runConfigCommand(result.value, io, credentialStore, configStore, env, artifactLibrary, config?.artifactLibrary ?? null);
    }

    if (result.value.command === "doctor") {
      const report = dependencies.doctor
        ? await dependencies.doctor(artifactLibrary.path)
        : await defaultDoctor(credentialStore, artifactLibrary.path);
      if (result.value.json) {
        io.log(JSON.stringify({ schemaVersion: PUBLIC_CLI_SCHEMA.doctorReport, ...report }));
      } else {
        printDoctorReport(report, io);
      }
      return report.ok ? 0 : 1;
    }

    if (result.value.command === "list") {
      const items = await (dependencies.withRecoveredOutputLibrary ?? withRecoveredOutputLibrary)(
        artifactLibrary.path,
        () => listLibraryEntries(artifactLibrary.path, dependencies.libraryFileOperations),
      );
      if (result.value.json) {
        io.log(JSON.stringify({ items, schemaVersion: PUBLIC_CLI_SCHEMA.libraryList }));
      } else {
        printLibraryEntries(items, io);
      }
      return 0;
    }

    if (result.value.command === "open") {
      const target = result.value.target;
      const json = result.value.json;
      const openResult = await (dependencies.withRecoveredOutputLibrary ?? withRecoveredOutputLibrary)(
        artifactLibrary.path,
        async () => {
          const resolved = await resolveLibraryEntry(
            artifactLibrary.path,
            target,
            dependencies.libraryFileOperations,
          );
          if (resolved.ok && !json) {
            await revalidateLibraryOpenTarget(resolved.openTarget, dependencies.libraryFileOperations);
            await (dependencies.openPath ?? openWithSystem)(resolved.openPath);
          }
          return resolved;
        },
      );

      if (!openResult.ok) {
        const payload = {
          error: {
            code: openResult.errorCode,
            message: openResult.message,
          },
          schemaVersion: PUBLIC_CLI_SCHEMA.openResult,
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
        io.log(JSON.stringify({
          ...openResult.item,
          openPath: openResult.openPath,
          schemaVersion: PUBLIC_CLI_SCHEMA.openResult,
        }));
      } else {
        io.log(`Opened: ${formatTerminalPath(openResult.openPath, io)}`);
      }

      return 0;
    }

    if (result.value.command === "transcript") {
      const readinessExitCode = await requireReadyRuntime(runtimeManager, result.value.json, io);
      if (readinessExitCode !== null) return readinessExitCode;
      const { copy, json, open, stdout: stdoutMode, video } = result.value;
      const fetchTranscript = dependencies.fetchTranscriptOnly ?? fetchTranscriptOnly;
      return await runTranscriptCommand({
        fetchTranscript,
        io,
        json,
        metadataSource: dependencies.metadataSource ?? new YouTubeOEmbedMetadataSource(),
        outputDir: artifactLibrary.path,
        openGeneratedTranscript: dependencies.openGeneratedTranscript ?? ((openInput) =>
          openGeneratedTranscriptSecurely({
            ...openInput,
            fileOperations: dependencies.libraryFileOperations,
            withRecoveredLibrary: dependencies.withRecoveredOutputLibrary ?? withRecoveredOutputLibrary,
          })),
        presentation: { copy, open, stdout: stdoutMode },
        spinnerIntervalMs: dependencies.spinnerIntervalMs,
        systemActions: dependencies.systemActions ?? createMacOSSystemActions(),
        video,
      });
    }

    const { emailPreview, json, video } = result.value;
    const readinessExitCode = await requireReadyRuntime(runtimeManager, json, io);
    if (readinessExitCode !== null) return readinessExitCode;
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
          metadataSource: dependencies.metadataSource ?? new YouTubeOEmbedMetadataSource(),
          outputDir: artifactLibrary.path,
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
      metadataSource: dependencies.metadataSource ?? new YouTubeOEmbedMetadataSource(),
      onProgress: progress?.handle,
      outputDir: artifactLibrary.path,
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
        schemaVersion: PUBLIC_CLI_SCHEMA.cliResult,
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
): { code: PublicCliErrorCode; exitCode: number; message: string } {
  if (error instanceof TranscriptSourceError && error.code === "transcript-unavailable") {
    const providerReason = extractProviderReason(error.message);
    const lines = [
      "No transcript is available for this video.",
      providerReason ? `Provider reason: ${providerReason}` : null,
      "Digest generation was skipped. Try another video or a future transcript fallback.",
    ];

    return {
      code: PUBLIC_CLI_ERROR_CODE.transcriptUnavailable,
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
      code: PUBLIC_CLI_ERROR_CODE.missingApiKey,
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

  if (error instanceof SystemActionError) {
    return { code: error.code, exitCode: 1, message: error.message };
  }

  if (error instanceof Error) {
    return {
      code: PUBLIC_CLI_ERROR_CODE.unexpectedError,
      exitCode: 1,
      message: error.message,
    };
  }

  return {
    code: PUBLIC_CLI_ERROR_CODE.unexpectedError,
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
  "Video Digest",
  "",
  "Usage:",
  "  video-digest ingest <youtube-url> [--email-preview] [--json] [--output-dir <path>]",
  "  video-digest transcript <youtube-url> [--json] [--output-dir <path>]",
  "  video-digest config <get|set|unset> [opencode-api-key] [--json]",
  "  video-digest config set output-dir <path> [--json]",
  "  video-digest doctor [--json]",
  "  video-digest setup [--yes] [--json]",
  "  video-digest list [--json] [--output-dir <path>]",
  "  video-digest open <latest|video-id> [--json] [--output-dir <path>]",
  "",
  "Compatibility:",
  "  bun run video-digest <youtube-url> [--email-preview]",
  "  bun run video-digest",
  "  bun run video-digest --help",
  "",
  "Options:",
  "  --email-preview  Also write a Markdown email preview under <Artifact Library>/emails/.",
  "  --copy           Copy clean transcript text after writing artifacts.",
  "  --open           Open the transcript Markdown after writing artifacts.",
  "  --stdout         Emit only clean transcript text to stdout.",
  "  --json           Write one machine-readable JSON object.",
  "  --yes            Confirm setup without an interactive prompt.",
  "  --output-dir     Override the Artifact Library for this command.",
  "  --help, -h       Show this help message.",
  "",
  "Interactive mode:",
  "  Run without arguments in a terminal to open the guided interface.",
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

const TRANSCRIPT_HELP_TEXT = [
  "Video Digest — Transcript",
  "",
  "Usage:",
  "  video-digest transcript <youtube-url> [options]",
  "",
  "Options:",
  "  --copy               Copy clean text to the macOS clipboard.",
  "  --open               Open the human-readable Markdown transcript.",
  "  --stdout             Emit only clean text for shell pipelines.",
  "  --json               Emit one versioned JSON result (incompatible with --stdout).",
  "  --output-dir <path>  Override the Artifact Library.",
  "  --help, -h           Show this command help.",
].join("\n");

const COMMAND_HELP_TEXT: Record<string, string> = {
  config: [
    "Video Digest — Configuration",
    "",
    "Usage:",
    "  video-digest config get [--json]",
    "  video-digest config set opencode-api-key",
    "  video-digest config unset opencode-api-key [--json]",
    "  video-digest config set output-dir <path> [--json]",
  ].join("\n"),
  doctor: "Usage: video-digest doctor [--json]",
  ingest: [
    "Usage: video-digest ingest <youtube-url> [options]",
    "",
    "Options: --email-preview, --json, --output-dir <path>",
  ].join("\n"),
  list: "Usage: video-digest list [--json] [--output-dir <path>]",
  open: "Usage: video-digest open <latest|video-id> [--json] [--output-dir <path>]",
  setup: "Usage: video-digest setup [--yes] [--json]",
  transcript: TRANSCRIPT_HELP_TEXT,
};

const defaultCliIO: CliIO = {
  error: (message) => console.error(message),
  inputIsTTY: stdin.isTTY,
  isTTY: stdout.isTTY,
  log: (message) => console.log(message),
  outputIsTTY: stdout.isTTY,
  prompt: promptFromTerminal,
  supportsHyperlinks: Boolean(stdout.isTTY && (
    process.env.TERM_PROGRAM || process.env.VTE_VERSION || process.env.WT_SESSION
  )),
  write: (message) => stdout.write(message),
};

if (import.meta.main) {
  const exitCode = await runCli(Bun.argv.slice(2));
  process.exit(exitCode);
}

async function runConfigCommand(
  command: Extract<CliOptions, { command: "config" }>,
  io: CliIO,
  credentialStore: CredentialStore,
  configStore: Pick<FileConfigStore, "load" | "save">,
  env: Record<string, string | undefined>,
  artifactLibrary: ArtifactLibraryResolution,
  configuredArtifactLibrary: string | null,
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
        artifactLibrary: {
          configured: configuredArtifactLibrary,
          effective: artifactLibrary.path,
          source: artifactLibrary.source,
        },
        opencodeApiKey: {
          configured,
          source: credential.source,
        },
        schemaVersion: PUBLIC_CLI_SCHEMA.configStatus,
      }));
    } else {
      io.log(configured
        ? `OpenCode API key: configured via ${sourceLabel}`
        : "OpenCode API key: not configured");
      io.log(`Artifact Library: ${formatTerminalPath(artifactLibrary.path, io)} (${artifactLibrary.source})`);
      if (configuredArtifactLibrary !== null && configuredArtifactLibrary !== artifactLibrary.path) {
        io.log(`Saved Artifact Library: ${formatTerminalPath(configuredArtifactLibrary, io)}`);
      }
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
        io.log(JSON.stringify({
          artifactLibrary: config.artifactLibrary,
          schemaVersion: PUBLIC_CLI_SCHEMA.configResult,
          status: "saved",
        }));
      } else {
        io.log(`Artifact Library saved: ${formatTerminalPath(config.artifactLibrary, io)}`);
      }
      return 0;
    }
    if (command.json) {
      io.log(JSON.stringify({
        error: {
          code: PUBLIC_CLI_ERROR_CODE.interactiveRequired,
          message: "config set opencode-api-key requires an interactive prompt.",
        },
        schemaVersion: PUBLIC_CLI_SCHEMA.configResult,
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
      schemaVersion: PUBLIC_CLI_SCHEMA.configResult,
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

function printHelp(io: CliIO, topic?: string): void {
  const text = topic ? COMMAND_HELP_TEXT[topic] ?? HELP_TEXT : HELP_TEXT;
  for (const line of text.split("\n")) {
    io.log(line);
  }
}

async function runTranscriptCommand(input: {
  fetchTranscript: (input: FetchTranscriptOnlyInput) => Promise<FetchTranscriptOnlyResult>;
  io: CliIO;
  json: boolean;
  metadataSource: VideoMetadataSource;
  outputDir: string;
  openGeneratedTranscript?: NonNullable<CliDependencies["openGeneratedTranscript"]>;
  presentation?: { copy: boolean; open: boolean; stdout: boolean };
  spinnerIntervalMs?: number;
  systemActions?: SystemActions;
  video: { canonicalUrl: string; videoId: string };
}): Promise<number> {
  const presentation = input.presentation ?? { copy: false, open: false, stdout: false };
  const progress = input.json || presentation.stdout ? null : createProgressRenderer(input.io, {
    intervalMs: input.spinnerIntervalMs,
  });

  const transcriptResult = await input.fetchTranscript({
    metadataSource: input.metadataSource,
    onProgress: progress?.handle,
    outputDir: input.outputDir,
    transcriptSource: new PythonYoutubeTranscriptSource(),
    video: input.video,
  }).finally(() => progress?.stop());

  const cleanText = transcriptResult.cleanText;

  if (input.json) {
    printTranscriptJson(input.video.canonicalUrl, input.video.videoId, transcriptResult, input.io);
  } else if (presentation.stdout) {
    writeExact(input.io, cleanText!);
  } else {
    printTranscriptResult(input.video.videoId, transcriptResult, input.io);
  }

  if (!input.json) {
    if (presentation.copy) {
      await input.systemActions!.copy(cleanText!);
      if (!presentation.stdout) input.io.log("Copied transcript text to the clipboard.");
    }
    if (presentation.open) {
      await input.openGeneratedTranscript!({
        open: input.systemActions!.open,
        outputDir: input.outputDir,
        path: transcriptResult.paths.transcriptMarkdownPath,
        videoId: input.video.videoId,
      });
      if (!presentation.stdout) input.io.log("Opened transcript Markdown.");
    }
  }
  return transcriptResult.exitCode;
}

async function openGeneratedTranscriptSecurely(input: {
  fileOperations?: Partial<LibraryFileOperations>;
  open: (path: string) => Promise<void>;
  outputDir: string;
  path: string;
  videoId: string;
  withRecoveredLibrary: <T>(outputDir: string, operation: () => Promise<T>) => Promise<T>;
}): Promise<void> {
  const failure = new SystemActionError(
    "open-failed",
    "Could not open the transcript. Open the Markdown file from its reported path.",
  );
  try {
    await input.withRecoveredLibrary(input.outputDir, async () => {
      const resolved = await resolveLibraryEntry(input.outputDir, input.videoId, input.fileOperations);
      if (!resolved.ok || resolved.openPath !== input.path) throw failure;
      await revalidateLibraryOpenTarget(resolved.openTarget, input.fileOperations);
      await input.open(resolved.openPath);
    });
  } catch (error) {
    if (error instanceof SystemActionError) throw error;
    throw failure;
  }
}

function writeExact(io: CliIO, text: string): void {
  if (io.write) {
    io.write(text);
    return;
  }
  io.log(text.endsWith("\n") ? text.slice(0, -1) : text);
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
    io.error(`Metadata: ${formatTerminalPath(result.metadataPath, io)}`);
    return;
  }

  io.log(`Ingested video ${videoId}`);
  io.log(`Transcript quality: ${result.transcriptQuality.status}`);
  io.log(`Transcript JSON: ${formatTerminalPath(result.paths.transcriptJsonPath, io)}`);
  io.log(`Transcript Markdown: ${formatTerminalPath(result.paths.transcriptMarkdownPath, io)}`);
  io.log(`Transcript text: ${formatTerminalPath(result.paths.transcriptTextPath, io)}`);
  io.log(`Digest: ${formatTerminalPath(result.paths.digestPath, io)}`);
  io.log(`Metadata: ${formatTerminalPath(result.paths.metadataPath, io)}`);

  if (result.paths.emailPreviewPath) {
    io.log(`Email preview: ${formatTerminalPath(result.paths.emailPreviewPath, io)}`);
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
      schemaVersion: PUBLIC_CLI_SCHEMA.cliResult,
      status: "unusable-transcript",
      transcriptQuality: result.transcriptQuality.status,
      videoId,
    }));
    return;
  }

  io.log(JSON.stringify({
    canonicalUrl,
    paths: result.paths,
    schemaVersion: PUBLIC_CLI_SCHEMA.cliResult,
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
  io.log(`Transcript JSON: ${formatTerminalPath(result.paths.transcriptJsonPath, io)}`);
  io.log(`Transcript Markdown: ${formatTerminalPath(result.paths.transcriptMarkdownPath, io)}`);
  io.log(`Transcript text: ${formatTerminalPath(result.paths.transcriptTextPath, io)}`);
  io.log(`Metadata: ${formatTerminalPath(result.paths.metadataPath, io)}`);
}

function formatTerminalPath(path: string, io: CliIO): string {
  const label = sanitizeTerminalLabel(path);
  if (io.supportsHyperlinks !== true || label !== path) return label;
  const uri = pathToFileURL(resolve(path)).href;
  if (sanitizeTerminalLabel(uri) !== uri) return label;
  return `\u001b]8;;${uri}\u0007${label}\u001b]8;;\u0007`;
}

export function sanitizeTerminalLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�");
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
    schemaVersion: PUBLIC_CLI_SCHEMA.cliResult,
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

function printLibraryEntries(items: LibraryEntry[], io: CliIO): void {
  if (items.length === 0) {
    io.log("No Library Entries found.");
    return;
  }

  for (const item of items) {
    const label = sanitizeTerminalLabel(item.title ?? item.videoId);
    const path = item.paths.digestPath ?? item.paths.transcriptMarkdownPath ?? item.paths.metadataPath;
    io.log(`${item.videoId}  ${label}  ${formatTerminalPath(path, io)}`);
  }
}

function createRuntimeManager(
  appPaths: AppPaths,
  env: Record<string, string | undefined>,
): RuntimeManager {
  const resources = resolvePackageResources(import.meta.url);
  const readLock = () => readFile(resources.uvLock, "utf8");
  const uvPath = resolveUvExecutable(env);
  return {
    inspect: async () => inspectRuntime(appPaths.runtimeDir, await readLock()),
    prepare: async () => prepareRuntime({
      lockContents: await readLock(),
      pythonDir: resources.pythonDir,
      runtimeDir: appPaths.runtimeDir,
      uvPath,
    }),
  };
}

async function runSetupCommand(
  command: Extract<CliOptions, { command: "setup" }>,
  io: CliIO,
  runtimeManager: RuntimeManager,
): Promise<number> {
  if (!command.yes) {
    if (command.json || !io.isTTY || !io.prompt) {
      const message = "Setup requires explicit consent; rerun with --yes.";
      if (command.json) {
        io.log(JSON.stringify({
          error: { code: PUBLIC_CLI_ERROR_CODE.consentRequired, message },
          schemaVersion: PUBLIC_CLI_SCHEMA.setupResult,
          status: "failed",
        }));
      } else {
        io.error(message);
      }
      return 1;
    }
    io.log("Setup may install an isolated Python 3.12 runtime and dependencies locked in the shipped uv.lock.");
    if (!isAffirmative(await io.prompt("Continue with setup? [y/N]: "))) {
      io.error("Setup cancelled; no changes were made.");
      return 1;
    }
  } else if (!command.json) {
    io.log("Setup may install an isolated Python 3.12 runtime and dependencies locked in the shipped uv.lock.");
  }

  try {
    await runtimeManager.prepare();
    if (command.json) {
      io.log(JSON.stringify({ schemaVersion: PUBLIC_CLI_SCHEMA.setupResult, status: "ready" }));
    } else {
      io.log("Python runtime is ready.");
    }
    return 0;
  } catch (error) {
    const message = error instanceof RuntimeSetupError
      ? error.message
      : "Setup failed while preparing the isolated Python runtime.";
    const code = error instanceof RuntimeSetupError ? error.code : PUBLIC_CLI_ERROR_CODE.setupFailed;
    if (command.json) {
      io.log(JSON.stringify({
        error: { code, message },
        schemaVersion: PUBLIC_CLI_SCHEMA.setupResult,
        status: "failed",
      }));
    } else {
      io.error(message);
    }
    return 1;
  }
}

async function requireReadyRuntime(
  runtimeManager: RuntimeManager,
  json: boolean,
  io: CliIO,
): Promise<number | null> {
  const readiness = await runtimeManager.inspect();
  if (readiness.status === "ready") return null;
  const message = `Python runtime is ${readiness.status}. ${readiness.remediation}`;
  if (json) {
    io.log(JSON.stringify({
      error: { code: PUBLIC_CLI_ERROR_CODE.runtimeNotReady, message },
      schemaVersion: PUBLIC_CLI_SCHEMA.cliResult,
      status: "failed",
    }));
  } else {
    io.error(message);
  }
  return 1;
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
