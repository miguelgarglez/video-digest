import { readFile } from "node:fs/promises";
import type { IngestionRepository } from "../storage/ingestion-repository";
import type { IngestionRecord } from "../storage/ingestion-record";
import type { Summarizer } from "../summarizer/summarizer";
import { TranscriptSourceError } from "../transcript/transcript-source";
import type { TranscriptSource } from "../transcript/transcript-source";
import { parseYouTubeVideoUrl } from "../video/youtube-url";
import { ingestVideo } from "./ingest-video";

export type IngestionServiceDependencies = {
  ingestVideoFn?: typeof ingestVideo;
  logger?: IngestionLogger;
  outputDir: string;
  repository: IngestionRepository;
  summarizer: Summarizer;
  transcriptSource: TranscriptSource;
};

export type IngestionLogger = {
  info: (event: Record<string, unknown>) => void;
};

export type RunIngestionResult =
  | { ok: true; record: IngestionRecord }
  | { ok: false; code: "invalid-url"; message: string };

export async function runIngestionFromUrl(
  url: string,
  dependencies: IngestionServiceDependencies,
): Promise<RunIngestionResult> {
  let video;

  try {
    video = parseYouTubeVideoUrl(url);
  } catch (error) {
    return {
      ok: false,
      code: "invalid-url",
      message: error instanceof Error ? error.message : "Unsupported YouTube URL",
    };
  }

  const ingest = dependencies.ingestVideoFn ?? ingestVideo;

  try {
    const result = await ingest({
      emailPreview: false,
      onProgress: (event) => {
        dependencies.repository.updateProgressStage(video.videoId, event.stage);
      },
      outputDir: dependencies.outputDir,
      summarizer: dependencies.summarizer,
      transcriptSource: dependencies.transcriptSource,
      video,
    });

    if (result.status === "completed") {
      const metadata = JSON.parse(await readFile(result.paths.metadataPath, "utf8")) as {
        digest?: { digestTitle?: string };
      };

      const record = dependencies.repository.save({
        canonicalUrl: video.canonicalUrl,
        digestPath: result.paths.digestPath,
        digestTitle: metadata.digest?.digestTitle ?? null,
        metadataPath: result.paths.metadataPath,
        status: "completed",
        transcriptPath: result.paths.transcriptPath,
        transcriptQualityStatus: result.transcriptQuality.status,
        videoId: video.videoId,
        warnings: result.transcriptQuality.warnings,
      });

      return { ok: true, record };
    }

    const record = dependencies.repository.save({
      canonicalUrl: video.canonicalUrl,
      errorCode: "unusable-transcript",
      errorMessage: "Transcript quality is unusable; digest generation was skipped.",
      metadataPath: result.metadataPath,
      status: "unusable-transcript",
      transcriptQualityStatus: result.transcriptQuality.status,
      videoId: video.videoId,
      warnings: result.transcriptQuality.warnings,
    });

    return { ok: true, record };
  } catch (error) {
    if (error instanceof TranscriptSourceError && error.code === "transcript-unavailable") {
      dependencies.logger?.info({
        event: "ingestion.transcript_unavailable",
        providerMessage: error.message,
        videoId: video.videoId,
      });

      const record = dependencies.repository.save({
        canonicalUrl: video.canonicalUrl,
        errorCode: "transcript-unavailable",
        errorMessage: formatTranscriptUnavailableMessage(error.message),
        status: "transcript-unavailable",
        videoId: video.videoId,
      });

      return { ok: true, record };
    }

    const record = dependencies.repository.save({
      canonicalUrl: video.canonicalUrl,
      errorCode: error instanceof TranscriptSourceError ? error.code : "ingestion-failed",
      errorMessage: error instanceof Error ? error.message : "Video ingestion failed",
      status: "failed",
      videoId: video.videoId,
    });

    return { ok: true, record };
  }
}

function formatTranscriptUnavailableMessage(providerMessage: string): string {
  const providerReason = extractProviderReason(providerMessage);
  const lines = [
    "No transcript is available for this video.",
    providerReason ? `Provider reason: ${providerReason}` : null,
    "Digest generation was skipped.",
  ];

  return lines.filter((line): line is string => line !== null).join("\n");
}

function extractProviderReason(message: string): string | null {
  const lines = message.split("\n").map((line) => line.trim());
  const causeIndex = lines.findIndex((line) => line.includes("This is most likely caused by:"));

  if (causeIndex === -1) {
    return null;
  }

  return lines.slice(causeIndex + 1).find((line) => line.length > 0) ?? null;
}
