import { describe, expect, test } from "bun:test";
import { OpenCodeSummarizer, type FetchLike } from "./opencode-summarizer";
import { SummarizerError } from "./summarizer";
import type { Transcript } from "../transcript/transcript-source";
import type { TranscriptQuality } from "../transcript/transcript-quality";
import type { YouTubeVideo } from "../video/youtube-url";

describe("OpenCodeSummarizer", () => {
  test("fails before provider call when API key is missing", async () => {
    let called = false;
    const fetch: FetchLike = async () => {
      called = true;
      return new Response("{}");
    };
    const summarizer = new OpenCodeSummarizer({ apiKey: "", fetch });

    await expect(summarizer.generateDigest(input())).rejects.toMatchObject({
      code: "missing-api-key",
      message: "Missing OPENCODE_API_KEY",
    } satisfies Partial<SummarizerError>);
    expect(called).toBe(false);
  });

  test("uses OpenCode config and parses structured digest output", async () => {
    const requests: Array<{ body: unknown; url: string }> = [];
    const fetch: FetchLike = async (url, init) => {
      requests.push({
        body: JSON.parse(String(init?.body)),
        url: String(url),
      });

      return Response.json({
        output_text: JSON.stringify(digestDraft()),
      });
    };
    const summarizer = new OpenCodeSummarizer({
      apiKey: "test-key",
      baseUrl: "https://opencode.test/responses",
      fetch,
      model: "gpt-test",
    });

    await expect(summarizer.generateDigest(input())).resolves.toEqual(digestDraft());
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      body: {
        model: "gpt-test",
      },
      url: "https://opencode.test/responses",
    });
  });

  test("maps provider errors to structured errors", async () => {
    const fetch: FetchLike = async () => new Response("bad request", { status: 400 });
    const summarizer = new OpenCodeSummarizer({ apiKey: "test-key", fetch });

    await expect(summarizer.generateDigest(input())).rejects.toMatchObject({
      code: "provider-failed",
      message: "OpenCode request failed with status 400: bad request",
    } satisfies Partial<SummarizerError>);
  });
});

function input(): {
  transcript: Transcript;
  transcriptQuality: TranscriptQuality;
  video: YouTubeVideo;
} {
  return {
    transcript: {
      language: "en",
      schemaVersion: "transcript.v0",
      segments: [
        {
          duration: 5,
          start: 0,
          text: "A founder explains how technology changes old media businesses.",
        },
      ],
      source: "youtube-transcript-api",
      videoId: "1ZgUcrR0K7I",
    },
    transcriptQuality: {
      averageCharsPerMinute: 720,
      durationSeconds: 5,
      language: "en",
      qualitySchemaVersion: "transcript-quality.v0",
      segmentCount: 1,
      status: "warning",
      totalTextLength: 64,
      warnings: ["low-segment-count"],
    },
    video: {
      canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      videoId: "1ZgUcrR0K7I",
    },
  };
}

function digestDraft() {
  return {
    actionableIdeas: ["Look for old industries being changed by new technology."],
    conceptsToInvestigate: ["media and technology intersection"],
    connections: ["Relates to personal knowledge ingestion."],
    digestTitle: "Technology as a Force Multiplier in Entertainment",
    keyIdeas: ["Technology can create and destroy media value."],
    relevantTimestamps: [
      {
        note: "Technology supercharges media.",
        timestamp: "0:00",
      },
    ],
    tldr: ["The video explains a business thesis around technology and media."],
    verdict: "watch_fragments" as const,
  };
}
