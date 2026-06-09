import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseCliArgs } from "./parse-args";
import { createProgressRenderer } from "./progress-renderer";
import {
  ingestVideo,
  type IngestVideoInput,
  type IngestVideoResult,
} from "../ingestion/ingest-video";
import { OpenCodeSummarizer } from "../summarizer/opencode-summarizer";
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
  ingestVideo?: (input: IngestVideoInput) => Promise<IngestVideoResult>;
  outputDir?: string;
  spinnerIntervalMs?: number;
};

export async function runCli(
  args: string[],
  io: CliIO = defaultCliIO,
  dependencies: CliDependencies = {},
): Promise<number> {
  try {
    const result = await resolveCliOptions(args, io);

    if (!result.ok) {
      io.error(result.error.message);
      return 1;
    }

    if (result.value.command === "help") {
      printHelp(io);
      return 0;
    }

    const { emailPreview, video } = result.value;
    const ingest = dependencies.ingestVideo ?? ingestVideo;
    const outputDir = dependencies.outputDir ?? process.env.VIDEO_DIGEST_OUTPUT_DIR ?? "outputs";
    const progress = createProgressRenderer(io, {
      intervalMs: dependencies.spinnerIntervalMs,
    });

    const ingestion = await ingest({
      emailPreview,
      onProgress: progress.handle,
      outputDir,
      summarizer: new OpenCodeSummarizer(),
      transcriptSource: new PythonYoutubeTranscriptSource(),
      video,
    }).finally(progress.stop);

    printIngestionResult(video.videoId, ingestion, io);
    return ingestion.exitCode;
  } catch (error) {
    const cliError = formatCliError(error);
    io.error(cliError.message);
    return cliError.exitCode;
  }
}

function formatCliError(error: unknown): { exitCode: number; message: string } {
  if (error instanceof TranscriptSourceError && error.code === "transcript-unavailable") {
    const providerReason = extractProviderReason(error.message);
    const lines = [
      "No transcript is available for this video.",
      providerReason ? `Provider reason: ${providerReason}` : null,
      "Digest generation was skipped. Try another video or a future transcript fallback.",
    ];

    return {
      exitCode: 2,
      message: lines.filter((line): line is string => line !== null).join("\n"),
    };
  }

  if (error instanceof TranscriptSourceError) {
    return {
      exitCode: 1,
      message: `Transcript provider failed: ${error.message}`,
    };
  }

  if (error instanceof Error) {
    return {
      exitCode: 1,
      message: error.message,
    };
  }

  return {
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
  "  bun run video-digest <youtube-url> [--email-preview]",
  "  bun run video-digest",
  "  bun run video-digest --help",
  "",
  "Options:",
  "  --email-preview  Also write a Markdown email preview under outputs/emails/.",
  "  --help, -h       Show this help message.",
  "",
  "Interactive mode:",
  "  Run without arguments to be prompted for the YouTube URL and email preview option.",
  "",
  "Environment:",
  "  OPENCODE_API_KEY      Required for digest generation.",
  "  OPENCODE_MODEL        Defaults to gpt-5.4-nano via .env.example.",
  "  VIDEO_DIGEST_OUTPUT_DIR  Defaults to outputs.",
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

  if (parsed.ok || parsed.error.code !== "missing-url" || !io.prompt) {
    return parsed;
  }

  const url = (await io.prompt("YouTube URL: ")).trim();
  const emailPreview =
    args.includes("--email-preview") || isAffirmative(await io.prompt("Create email preview? [y/N]: "));

  return parseCliArgs([url, ...(emailPreview ? ["--email-preview"] : [])]);
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

function printHelp(io: CliIO): void {
  for (const line of HELP_TEXT.split("\n")) {
    io.log(line);
  }
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
