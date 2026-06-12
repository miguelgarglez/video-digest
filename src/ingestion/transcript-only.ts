import {
  writeTranscriptOnlyOutputs,
  type TranscriptOnlyOutputPaths,
} from "../output/output-writer";
import type { TranscriptQuality } from "../transcript/transcript-quality";
import { scoreTranscriptQuality } from "../transcript/transcript-quality";
import type { TranscriptSource } from "../transcript/transcript-source";
import type { YouTubeVideo } from "../video/youtube-url";
import type { IngestionProgressEvent } from "./ingest-video";

export type FetchTranscriptOnlyInput = {
  onProgress?: (event: IngestionProgressEvent) => void;
  outputDir: string;
  transcriptSource: TranscriptSource;
  video: YouTubeVideo;
};

export type FetchTranscriptOnlyResult = {
  exitCode: 0;
  paths: TranscriptOnlyOutputPaths;
  status: "completed";
  transcriptQuality: TranscriptQuality;
};

export async function fetchTranscriptOnly(
  input: FetchTranscriptOnlyInput,
): Promise<FetchTranscriptOnlyResult> {
  emitProgress(input, "fetching-transcript");
  const transcript = await input.transcriptSource.fetch(input.video);

  emitProgress(input, "scoring-transcript");
  const transcriptQuality = scoreTranscriptQuality(transcript);

  emitProgress(input, "writing-outputs");
  const paths = await writeTranscriptOnlyOutputs({
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

function emitProgress(input: FetchTranscriptOnlyInput, stage: IngestionProgressEvent["stage"]): void {
  input.onProgress?.({
    stage,
    videoId: input.video.videoId,
  });
}
