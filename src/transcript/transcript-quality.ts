import type { Transcript } from "./transcript-source";

export type TranscriptQualityStatus = "usable" | "warning" | "unusable";

export type TranscriptQualityWarning =
  | "empty-transcript"
  | "low-average-chars-per-minute"
  | "low-segment-count"
  | "missing-valid-timestamps"
  | "very-short-transcript";

export type TranscriptQuality = {
  averageCharsPerMinute: number | null;
  durationSeconds: number | null;
  language: string | null;
  qualitySchemaVersion: "transcript-quality.v0";
  segmentCount: number;
  status: TranscriptQualityStatus;
  totalTextLength: number;
  warnings: TranscriptQualityWarning[];
};

const MIN_USABLE_SEGMENT_COUNT = 20;
const MIN_USABLE_TEXT_LENGTH = 1_000;
const MIN_WARNING_TEXT_LENGTH = 250;
const MIN_AVERAGE_CHARS_PER_MINUTE = 250;

export function scoreTranscriptQuality(transcript: Transcript): TranscriptQuality {
  const segmentCount = transcript.segments.length;
  const totalTextLength = transcript.segments.reduce(
    (total, segment) => total + segment.text.trim().length,
    0,
  );
  const durationSeconds = calculateDurationSeconds(transcript);
  const averageCharsPerMinute =
    durationSeconds && durationSeconds > 0
      ? Math.round(totalTextLength / (durationSeconds / 60))
      : null;
  const warnings: TranscriptQualityWarning[] = [];

  if (segmentCount === 0) {
    warnings.push("empty-transcript");
  }

  if (durationSeconds === null) {
    warnings.push("missing-valid-timestamps");
  }

  if (totalTextLength < MIN_WARNING_TEXT_LENGTH) {
    warnings.push("very-short-transcript");
  }

  if (segmentCount > 0 && segmentCount < MIN_USABLE_SEGMENT_COUNT) {
    warnings.push("low-segment-count");
  }

  if (
    averageCharsPerMinute !== null &&
    totalTextLength >= MIN_WARNING_TEXT_LENGTH &&
    averageCharsPerMinute < MIN_AVERAGE_CHARS_PER_MINUTE
  ) {
    warnings.push("low-average-chars-per-minute");
  }

  return {
    averageCharsPerMinute,
    durationSeconds,
    language: transcript.language,
    qualitySchemaVersion: "transcript-quality.v0",
    segmentCount,
    status: qualityStatus({ durationSeconds, segmentCount, totalTextLength, warnings }),
    totalTextLength,
    warnings,
  };
}

function qualityStatus(input: {
  durationSeconds: number | null;
  segmentCount: number;
  totalTextLength: number;
  warnings: TranscriptQualityWarning[];
}): TranscriptQualityStatus {
  if (
    input.segmentCount === 0 ||
    input.durationSeconds === null ||
    input.totalTextLength < MIN_WARNING_TEXT_LENGTH
  ) {
    return "unusable";
  }

  if (input.warnings.length > 0 || input.totalTextLength < MIN_USABLE_TEXT_LENGTH) {
    return "warning";
  }

  return "usable";
}

function calculateDurationSeconds(transcript: Transcript): number | null {
  const ends = transcript.segments
    .map((segment) => {
      if (!Number.isFinite(segment.start)) {
        return null;
      }

      return segment.start + (segment.duration ?? 0);
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));

  if (ends.length === 0) {
    return null;
  }

  return Math.max(...ends);
}
