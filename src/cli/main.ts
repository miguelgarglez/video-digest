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
    io.error(error instanceof Error ? error.message : "Video ingestion failed");
    return 1;
  }
}

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
