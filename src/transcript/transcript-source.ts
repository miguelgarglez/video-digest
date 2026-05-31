import type { YouTubeVideo } from "../video/youtube-url";

export type TranscriptSegment = {
  duration: number | null;
  start: number;
  text: string;
};

export type Transcript = {
  language: string | null;
  schemaVersion: "transcript.v0";
  segments: TranscriptSegment[];
  source: "youtube-transcript-api";
  videoId: string;
};

export type TranscriptSourceErrorCode =
  | "provider-failed"
  | "transcript-unavailable"
  | "invalid-provider-response";

export class TranscriptSourceError extends Error {
  constructor(
    public readonly code: TranscriptSourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TranscriptSourceError";
  }
}

export type TranscriptSource = {
  fetch(video: YouTubeVideo): Promise<Transcript>;
};
