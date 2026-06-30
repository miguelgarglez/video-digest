import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { ingestVideo } from "./ingest-video";
import type { Summarizer } from "../summarizer/summarizer";
import type { Transcript, TranscriptSource } from "../transcript/transcript-source";
import type { YouTubeVideo } from "../video/youtube-url";
import { VIDEO_DIGEST_VERSION } from "../version";

describe("ingestVideo", () => {
  test("stops before summarization and writes when cancellation reaches metadata enrichment", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-cancel-"));
    const abort = new AbortController();
    let summarizerCalls = 0;
    const pending = ingestVideo({
      emailPreview: false,
      metadataSource: {
        async fetch() {
          abort.abort(new Error("cancelled"));
          throw abort.signal.reason;
        },
      },
      outputDir,
      signal: abort.signal,
      summarizer: {
        async generateDigest() { summarizerCalls += 1; return fakeSummarizationResult(); },
      },
      transcriptSource: fakeTranscriptSource(usableTranscript()),
      video,
    });

    await expect(pending).rejects.toThrow("cancelled");
    expect(summarizerCalls).toBe(0);
  });

  test("writes outputs for usable transcripts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-"));
    const progressStages: string[] = [];

    const result = await ingestVideo({
      emailPreview: true,
      onProgress: (event) => progressStages.push(event.stage),
      outputDir,
      summarizer: fakeSummarizer(),
      transcriptSource: fakeTranscriptSource(usableTranscript()),
      video,
    });

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.generation).toMatchObject({
        provider: "anthropic",
        requestedModel: "claude-sonnet-4-6",
      });
      expect(result.paths.emailPreviewPath).toBe(join(outputDir, "emails", "1ZgUcrR0K7I.md"));
      expect(await readFile(result.paths.digestPath, "utf8")).toContain("# Useful Digest");
      expect(result.cleanText).toBe(await readFile(result.paths.transcriptTextPath, "utf8"));
    }
    expect(progressStages).toEqual([
      "fetching-transcript",
      "scoring-transcript",
      "generating-digest",
      "writing-outputs",
      "completed",
    ]);
  });

  test("writes warning outputs for warning transcripts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-"));

    const result = await ingestVideo({
      emailPreview: false,
      outputDir,
      summarizer: fakeSummarizer(),
      transcriptSource: fakeTranscriptSource(warningTranscript()),
      video,
    });

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(await readFile(result.paths.digestPath, "utf8")).toContain("## Transcript warnings");
    }
  });

  test("does not call summarizer and writes metadata for unusable transcripts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-"));
    let summarizerCalls = 0;

    const result = await ingestVideo({
      emailPreview: true,
      outputDir,
      summarizer: {
        async generateDigest() {
          summarizerCalls += 1;
          return fakeSummarizationResult();
        },
      },
      transcriptSource: fakeTranscriptSource({
        ...usableTranscript(),
        segments: [],
      }),
      video,
    });

    expect(summarizerCalls).toBe(0);
    expect(result).toMatchObject({
      exitCode: 2,
      status: "unusable-transcript",
    });
    if (result.status === "unusable-transcript") {
      const metadata = JSON.parse(await readFile(result.metadataPath, "utf8"));
      expect(metadata).toMatchObject({
        digest: null,
        error: {
          code: "unusable-transcript",
        },
        transcriptQuality: {
          status: "unusable",
        },
        generation: null,
        metadataSchemaVersion: "metadata.v1",
        videoDigestVersion: VIDEO_DIGEST_VERSION,
      });
    }
  });

  test("persists enriched metadata for completed ingestion", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-"));
    let metadataCalls = 0;

    const result = await ingestVideo({
      emailPreview: false,
      metadataSource: {
        async fetch() {
          metadataCalls += 1;
          return { channel: "A channel", title: "A title" };
        },
      },
      outputDir,
      summarizer: fakeSummarizer(),
      transcriptSource: fakeTranscriptSource(usableTranscript()),
      video,
    });

    expect(metadataCalls).toBe(1);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(JSON.parse(await readFile(result.paths.metadataPath, "utf8"))).toMatchObject({
        generation: fakeSummarizationResult().generation,
        metadataSchemaVersion: "metadata.v1",
        video: { channel: "A channel", videoTitle: "A title" },
        videoDigestVersion: VIDEO_DIGEST_VERSION,
      });
      expect(await readFile(result.paths.transcriptMarkdownPath, "utf8")).toContain("# A title");
    }
  });

  test("persists enriched metadata for unusable transcripts without generating a digest", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-"));

    const result = await ingestVideo({
      emailPreview: false,
      metadataSource: {
        async fetch() {
          return { channel: "A channel", title: "A title" };
        },
      },
      outputDir,
      summarizer: fakeSummarizer(),
      transcriptSource: fakeTranscriptSource({ ...usableTranscript(), segments: [] }),
      video,
    });

    expect(result.status).toBe("unusable-transcript");
    if (result.status === "unusable-transcript") {
      expect(JSON.parse(await readFile(result.metadataPath, "utf8"))).toMatchObject({
        video: { channel: "A channel", videoTitle: "A title" },
      });
    }
  });

  test("continues digest creation when metadata lookup fails", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-"));

    const result = await ingestVideo({
      emailPreview: false,
      metadataSource: {
        async fetch() {
          throw new Error("offline");
        },
      },
      outputDir,
      summarizer: fakeSummarizer(),
      transcriptSource: fakeTranscriptSource(usableTranscript()),
      video,
    });

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(JSON.parse(await readFile(result.paths.metadataPath, "utf8"))).toMatchObject({
        video: { channel: null, videoTitle: null },
      });
    }
  });
});

const video: YouTubeVideo = {
  canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
  videoId: "1ZgUcrR0K7I",
};

function fakeTranscriptSource(transcript: Transcript): TranscriptSource {
  return {
    async fetch() {
      return transcript;
    },
  };
}

function fakeSummarizer(): Summarizer {
  return {
    async generateDigest() {
      return fakeSummarizationResult();
    },
  };
}

function fakeSummarizationResult() {
  return {
    draft: fakeDigestDraft(),
    generation: {
      provider: "anthropic" as const,
      requestId: "msg_123",
      requestedModel: "claude-sonnet-4-6",
      responseModel: "claude-sonnet-4-6",
      usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
    },
  };
}

function fakeDigestDraft() {
  return {
    actionableIdeas: ["Apply it."],
    conceptsToInvestigate: ["Concept"],
    connections: ["Connection"],
    digestTitle: "Useful Digest",
    keyIdeas: ["Key idea"],
    relevantTimestamps: [
      {
        note: "Important point",
        timestamp: "0:00",
      },
    ],
    tldr: ["Short summary"],
    verdict: "watch_fragments" as const,
  };
}

function usableTranscript(): Transcript {
  return {
    language: "en",
    provenance: { isAutoGenerated: null },
    schemaVersion: "transcript.v0",
    segments: Array.from({ length: 60 }, (_, index) => ({
      duration: 5,
      start: index * 5,
      text: "This segment contains enough words to represent spoken content.",
    })),
    source: "youtube-transcript-api",
    videoId: "1ZgUcrR0K7I",
  };
}

function warningTranscript(): Transcript {
  return {
    ...usableTranscript(),
    segments: [
      {
        duration: 20,
        start: 0,
        text: "This is enough text to avoid being completely unusable. ".repeat(6),
      },
    ],
  };
}
