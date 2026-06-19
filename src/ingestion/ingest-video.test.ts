import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { ingestVideo } from "./ingest-video";
import type { Summarizer } from "../summarizer/summarizer";
import type { Transcript, TranscriptSource } from "../transcript/transcript-source";
import type { YouTubeVideo } from "../video/youtube-url";

describe("ingestVideo", () => {
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
      expect(result.paths.emailPreviewPath).toBe(join(outputDir, "emails", "1ZgUcrR0K7I.md"));
      expect(await readFile(result.paths.digestPath, "utf8")).toContain("# Useful Digest");
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
          return fakeDigestDraft();
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
        error: {
          code: "unusable-transcript",
        },
        transcriptQuality: {
          status: "unusable",
        },
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
        video: { channel: "A channel", videoTitle: "A title" },
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
      return fakeDigestDraft();
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
