import { describe, expect, test } from "bun:test";
import { scoreTranscriptQuality } from "./transcript-quality";
import type { Transcript, TranscriptSegment } from "./transcript-source";

describe("scoreTranscriptQuality", () => {
  test("marks a substantial timestamped transcript as usable", () => {
    const transcript = buildTranscript({
      segments: Array.from({ length: 60 }, (_, index) => ({
        duration: 5,
        start: index * 5,
        text: "This segment contains enough words to represent spoken content.",
      })),
    });

    expect(scoreTranscriptQuality(transcript)).toEqual({
      averageCharsPerMinute: 756,
      durationSeconds: 300,
      language: "en",
      qualitySchemaVersion: "transcript-quality.v0",
      segmentCount: 60,
      status: "usable",
      totalTextLength: 3780,
      warnings: [],
    });
  });

  test("marks a transcript with suspiciously few segments as warning", () => {
    const transcript = buildTranscript({
      segments: Array.from({ length: 10 }, (_, index) => ({
        duration: 20,
        start: index * 20,
        text: "This is enough text to avoid being completely unusable.",
      })),
    });

    const quality = scoreTranscriptQuality(transcript);

    expect(quality.status).toBe("warning");
    expect(quality.warnings).toContain("low-segment-count");
  });

  test("marks an empty transcript as unusable", () => {
    const quality = scoreTranscriptQuality(buildTranscript({ segments: [] }));

    expect(quality.status).toBe("unusable");
    expect(quality.warnings).toContain("empty-transcript");
  });

  test("marks a transcript without valid timestamps as unusable", () => {
    const quality = scoreTranscriptQuality(
      buildTranscript({
        segments: [
          {
            duration: null,
            start: Number.NaN,
            text: "This text exists but timestamp data is invalid.",
          },
        ],
      }),
    );

    expect(quality.status).toBe("unusable");
    expect(quality.warnings).toContain("missing-valid-timestamps");
  });
});

function buildTranscript(options: { segments: TranscriptSegment[] }): Transcript {
  return {
    language: "en",
    schemaVersion: "transcript.v0",
    segments: options.segments,
    source: "youtube-transcript-api",
    videoId: "1ZgUcrR0K7I",
  };
}
