import type { DigestDraft } from "../digest/digest";
import type { PublicCliErrorCode } from "../cli/public-contract";
import type { Transcript } from "../transcript/transcript-source";
import type { TranscriptQuality } from "../transcript/transcript-quality";
import type { YouTubeVideo } from "../video/youtube-url";

export type SummarizerInput = {
  signal?: AbortSignal;
  transcript: Transcript;
  transcriptQuality: TranscriptQuality;
  video: YouTubeVideo;
};

export type Summarizer = {
  generateDigest(input: SummarizerInput): Promise<DigestDraft>;
};

export type SummarizerErrorCode = Extract<PublicCliErrorCode,
  "missing-api-key" | "provider-failed" | "invalid-provider-response">;

export class SummarizerError extends Error {
  constructor(
    public readonly code: SummarizerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SummarizerError";
  }
}
