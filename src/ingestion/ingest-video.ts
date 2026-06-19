import { createDigest } from "../digest/digest";
import {
  writeFailedIngestionMetadata,
  writeIngestionOutputs,
  type IngestionOutputPaths,
} from "../output/output-writer";
import type { Summarizer } from "../summarizer/summarizer";
import type { TranscriptQuality } from "../transcript/transcript-quality";
import { scoreTranscriptQuality } from "../transcript/transcript-quality";
import type { TranscriptSource } from "../transcript/transcript-source";
import type { YouTubeVideo } from "../video/youtube-url";
import {
  fetchVideoMetadataBestEffort,
  type VideoMetadataSource,
} from "../video/video-metadata-source";

export type IngestVideoInput = {
  emailPreview: boolean;
  metadataSource?: VideoMetadataSource;
  onProgress?: (event: IngestionProgressEvent) => void;
  outputDir: string;
  summarizer: Summarizer;
  transcriptSource: TranscriptSource;
  video: YouTubeVideo;
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
      exitCode: 0;
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
  const transcript = await input.transcriptSource.fetch(input.video);
  const metadata = await fetchVideoMetadataBestEffort(input.metadataSource, input.video);

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
    });

    return {
      exitCode: 2,
      metadataPath,
      status: "unusable-transcript",
      transcriptQuality,
    };
  }

  emitProgress(input, "generating-digest");
  const digest = createDigest(
    await input.summarizer.generateDigest({
      transcript,
      transcriptQuality,
      video: input.video,
    }),
  );

  emitProgress(input, "writing-outputs");
  const paths = await writeIngestionOutputs({
    digest,
    emailPreview: input.emailPreview,
    metadata,
    outputDir: input.outputDir,
    transcript,
    transcriptQuality,
    video: input.video,
  });

  emitProgress(input, "completed");

  return {
    exitCode: 0,
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
