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

export type IngestVideoInput = {
  emailPreview: boolean;
  outputDir: string;
  summarizer: Summarizer;
  transcriptSource: TranscriptSource;
  video: YouTubeVideo;
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
  const transcript = await input.transcriptSource.fetch(input.video);
  const transcriptQuality = scoreTranscriptQuality(transcript);

  if (transcriptQuality.status === "unusable") {
    const metadataPath = await writeFailedIngestionMetadata({
      error: {
        code: "unusable-transcript",
        message: "Transcript quality is unusable; digest generation was skipped.",
      },
      outputDir: input.outputDir,
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

  const digest = createDigest(
    await input.summarizer.generateDigest({
      transcript,
      transcriptQuality,
      video: input.video,
    }),
  );

  return {
    exitCode: 0,
    paths: await writeIngestionOutputs({
      digest,
      emailPreview: input.emailPreview,
      outputDir: input.outputDir,
      transcript,
      transcriptQuality,
      video: input.video,
    }),
    status: "completed",
    transcriptQuality,
  };
}
