import type { DigestDraft } from "../digest/digest";
import type { PublicCliErrorCode } from "../cli/public-contract";
import type { Transcript } from "../transcript/transcript-source";
import type { TranscriptQuality } from "../transcript/transcript-quality";
import type { YouTubeVideo } from "../video/youtube-url";
import type { DigestProviderId } from "./providers";

export type SummarizerInput = {
  signal?: AbortSignal;
  transcript: Transcript;
  transcriptQuality: TranscriptQuality;
  video: YouTubeVideo;
};

export type Summarizer = {
  generateDigest(input: SummarizerInput): Promise<DigestDraft | SummarizationResult>;
};

export type GenerationUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

export type GenerationProvenance = Readonly<{
  provider: DigestProviderId;
  requestedModel: string;
  responseModel: string | null;
  requestId: string | null;
  usage: GenerationUsage | null;
}>;

export type SummarizationResult = Readonly<{
  draft: DigestDraft;
  generation: GenerationProvenance;
}>;

export type SummarizerErrorCode =
  | Extract<PublicCliErrorCode, "missing-api-key" | "provider-failed" | "invalid-provider-response">
  | "invalid-model"
  | "authentication-failed"
  | "rate-limited"
  | "quota-exceeded"
  | "context-limit-exceeded"
  | "provider-unavailable";

export class SummarizerError extends Error {
  constructor(
    public readonly code: SummarizerErrorCode,
    message: string,
    public readonly provider: DigestProviderId = "opencode",
    public readonly model: string | null = null,
  ) {
    super(message);
    this.name = "SummarizerError";
  }
}
