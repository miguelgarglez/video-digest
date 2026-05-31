import { parseCliArgs } from "./parse-args";
import { ingestVideo, type IngestVideoInput, type IngestVideoResult } from "../ingestion/ingest-video";
import { OpenCodeSummarizer } from "../summarizer/opencode-summarizer";
import { PythonYoutubeTranscriptSource } from "../transcript/python-youtube-transcript-source";

export type CliIO = {
  error: (message: string) => void;
  log: (message: string) => void;
};

export type CliDependencies = {
  ingestVideo?: (input: IngestVideoInput) => Promise<IngestVideoResult>;
  outputDir?: string;
};

export async function runCli(
  args: string[],
  io: CliIO = console,
  dependencies: CliDependencies = {},
): Promise<number> {
  const result = parseCliArgs(args);

  if (!result.ok) {
    io.error(result.error.message);
    return 1;
  }

  const { emailPreview, video } = result.value;
  const ingest = dependencies.ingestVideo ?? ingestVideo;
  const outputDir = dependencies.outputDir ?? process.env.VIDEO_DIGEST_OUTPUT_DIR ?? "outputs";

  try {
    const ingestion = await ingest({
      emailPreview,
      outputDir,
      summarizer: new OpenCodeSummarizer(),
      transcriptSource: new PythonYoutubeTranscriptSource(),
      video,
    });

    printIngestionResult(video.videoId, ingestion, io);
    return ingestion.exitCode;
  } catch (error) {
    io.error(error instanceof Error ? error.message : "Video ingestion failed");
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await runCli(Bun.argv.slice(2));
  process.exit(exitCode);
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
