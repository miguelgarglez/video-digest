import {
  writeTranscriptOnlyOutputs,
  type TranscriptOnlyOutputPaths,
} from "../output/output-writer";
import type { TranscriptQuality } from "../transcript/transcript-quality";
import { scoreTranscriptQuality } from "../transcript/transcript-quality";
import type { TranscriptSource } from "../transcript/transcript-source";
import type { YouTubeVideo } from "../video/youtube-url";
import {
  fetchVideoMetadataBestEffort,
  type VideoMetadataSource,
} from "../video/video-metadata-source";
import type { IngestionProgressEvent } from "./ingest-video";
import { renderTranscriptText } from "../output/transcript-renderer";

export type FetchTranscriptOnlyInput = {
  metadataSource?: VideoMetadataSource;
  onProgress?: (event: IngestionProgressEvent) => void;
  outputDir: string;
  signal?: AbortSignal;
  transcriptSource: TranscriptSource;
  video: YouTubeVideo;
};

export type FetchTranscriptOnlyResult = {
  cleanText: string;
  exitCode: 0;
  paths: TranscriptOnlyOutputPaths;
  status: "completed";
  transcriptQuality: TranscriptQuality;
};

export async function fetchTranscriptOnly(
  input: FetchTranscriptOnlyInput,
): Promise<FetchTranscriptOnlyResult> {
  emitProgress(input, "fetching-transcript");
  const transcript = await input.transcriptSource.fetch(input.video, { signal: input.signal });
  const metadata = await fetchVideoMetadataBestEffort(input.metadataSource, input.video, { signal: input.signal });
  input.signal?.throwIfAborted();

  emitProgress(input, "scoring-transcript");
  const transcriptQuality = scoreTranscriptQuality(transcript);
  const cleanText = renderTranscriptText(transcript);

  emitProgress(input, "writing-outputs");
  const paths = await writeTranscriptOnlyOutputs({
    cleanText,
    metadata,
    outputDir: input.outputDir,
    transcript,
    transcriptQuality,
    video: input.video,
  });

  emitProgress(input, "completed");

  return {
    cleanText,
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
