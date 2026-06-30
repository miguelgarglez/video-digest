import { createDigest } from "../digest/digest";
import {
  writeFailedIngestionMetadata,
  writeIngestionOutputs,
  type IngestionOutputPaths,
} from "../output/output-writer";
import type { GenerationProvenance, Summarizer } from "../summarizer/summarizer";
import type { TranscriptQuality } from "../transcript/transcript-quality";
import { scoreTranscriptQuality } from "../transcript/transcript-quality";
import type { TranscriptSource } from "../transcript/transcript-source";
import type { YouTubeVideo } from "../video/youtube-url";
import {
  fetchVideoMetadataBestEffort,
  type VideoMetadataSource,
} from "../video/video-metadata-source";
import { renderTranscriptText } from "../output/transcript-renderer";
import { VIDEO_DIGEST_VERSION } from "../version";

export type IngestVideoInput = {
  emailPreview: boolean;
  metadataSource?: VideoMetadataSource;
  onProgress?: (event: IngestionProgressEvent) => void;
  outputDir: string;
  signal?: AbortSignal;
  summarizer: Summarizer;
  transcriptSource: TranscriptSource;
  video: YouTubeVideo;
  videoDigestVersion?: string;
};

export type IngestionProgressStage =
  | "fetching-transcript"
  | "scoring-transcript"
  | "generating-digest"
  | "writing-outputs"
  | "completed"
  | "unusable-transcript";

export type IngestionProgressEvent = {
  stage: IngestionProgressStage;
  videoId: string;
};

export type IngestVideoResult =
  | {
      cleanText: string;
      exitCode: 0;
      generation: GenerationProvenance;
      paths: IngestionOutputPaths;
      status: "completed";
      transcriptQuality: TranscriptQuality;
    }
  | {
      exitCode: 2;
      metadataPath: string;
      status: "unusable-transcript";
      transcriptQuality: TranscriptQuality;
    };

export async function ingestVideo(input: IngestVideoInput): Promise<IngestVideoResult> {
  emitProgress(input, "fetching-transcript");
  const transcript = await input.transcriptSource.fetch(input.video, { signal: input.signal });
  const metadata = await fetchVideoMetadataBestEffort(input.metadataSource, input.video, { signal: input.signal });
  input.signal?.throwIfAborted();

  emitProgress(input, "scoring-transcript");
  const transcriptQuality = scoreTranscriptQuality(transcript);

  if (transcriptQuality.status === "unusable") {
    emitProgress(input, "unusable-transcript");
    const metadataPath = await writeFailedIngestionMetadata({
      error: {
        code: "unusable-transcript",
        message: "Transcript quality is unusable; digest generation was skipped.",
      },
      outputDir: input.outputDir,
      metadata,
      transcriptQuality,
      video: input.video,
      videoDigestVersion: input.videoDigestVersion ?? VIDEO_DIGEST_VERSION,
    });

    return {
      exitCode: 2,
      metadataPath,
      status: "unusable-transcript",
      transcriptQuality,
    };
  }

  emitProgress(input, "generating-digest");
  const { draft, generation } = await input.summarizer.generateDigest({
    signal: input.signal,
    transcript,
    transcriptQuality,
    video: input.video,
  });
  input.signal?.throwIfAborted();
  const digest = createDigest(draft);

  emitProgress(input, "writing-outputs");
  const cleanText = renderTranscriptText(transcript);
  const paths = await writeIngestionOutputs({
    digest,
    emailPreview: input.emailPreview,
    generation,
    metadata,
    outputDir: input.outputDir,
    transcript,
    transcriptQuality,
    video: input.video,
    videoDigestVersion: input.videoDigestVersion ?? VIDEO_DIGEST_VERSION,
  });

  emitProgress(input, "completed");

  return {
    cleanText,
    exitCode: 0,
    generation,
    paths,
    status: "completed",
    transcriptQuality,
  };
}

function emitProgress(input: IngestVideoInput, stage: IngestionProgressStage): void {
  input.onProgress?.({
    stage,
    videoId: input.video.videoId,
  });
}
