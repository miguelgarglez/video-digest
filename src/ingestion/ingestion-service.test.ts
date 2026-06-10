import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { runIngestionFromUrl } from "./ingestion-service";
import { IngestionRepository } from "../storage/ingestion-repository";
import type { Summarizer } from "../summarizer/summarizer";
import { TranscriptSourceError, type Transcript, type TranscriptSource } from "../transcript/transcript-source";
import type { YouTubeVideo } from "../video/youtube-url";
import type { IngestVideoResult } from "./ingest-video";

describe("runIngestionFromUrl", () => {
  let tempDir = "";
  let repository: IngestionRepository | null = null;

  afterEach(async () => {
    repository?.close();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns invalid-url for unsupported URLs", async () => {
    ({ repository, tempDir } = await createRepository());

    const result = await runIngestionFromUrl("not-a-url", {
      outputDir: join(tempDir, "outputs"),
      repository,
      summarizer: fakeSummarizer(),
      transcriptSource: fakeTranscriptSource(usableTranscript()),
    });

    expect(result).toEqual({
      ok: false,
      code: "invalid-url",
      message: "Unsupported YouTube URL: not-a-url",
    });
  });

  test("persists completed ingestions", async () => {
    ({ repository, tempDir } = await createRepository());
    const outputDir = join(tempDir, "outputs");

    const result = await runIngestionFromUrl("https://youtu.be/1ZgUcrR0K7I", {
      ingestVideoFn: async () => completedResult(outputDir),
      outputDir,
      repository,
      summarizer: fakeSummarizer(),
      transcriptSource: fakeTranscriptSource(usableTranscript()),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.status).toBe("completed");
      expect(result.record.digestTitle).toBe("Useful Digest");
      expect(repository.findByVideoId("1ZgUcrR0K7I")?.status).toBe("completed");
    }
  });

  test("persists progress events while ingestion runs", async () => {
    ({ repository, tempDir } = await createRepository());
    const outputDir = join(tempDir, "outputs");
    const persistedStages: string[] = [];
    const originalUpdateProgressStage = repository.updateProgressStage.bind(repository);
    repository.updateProgressStage = (videoId, progressStage) => {
      persistedStages.push(progressStage);
      return originalUpdateProgressStage(videoId, progressStage);
    };

    await runIngestionFromUrl("https://youtu.be/1ZgUcrR0K7I", {
      ingestVideoFn: async (input) => {
        input.onProgress?.({ stage: "fetching-transcript", videoId: input.video.videoId });
        input.onProgress?.({ stage: "generating-digest", videoId: input.video.videoId });
        return completedResult(outputDir);
      },
      outputDir,
      repository,
      summarizer: fakeSummarizer(),
      transcriptSource: fakeTranscriptSource(usableTranscript()),
    });

    expect(persistedStages).toEqual(["fetching-transcript", "generating-digest"]);
    expect(repository.findByVideoId("1ZgUcrR0K7I")?.progressStage).toBe(null);
  });

  test("persists transcript-unavailable ingestions", async () => {
    ({ repository, tempDir } = await createRepository());

    const result = await runIngestionFromUrl("https://youtu.be/1ZgUcrR0K7I", {
      outputDir: join(tempDir, "outputs"),
      repository,
      summarizer: fakeSummarizer(),
      transcriptSource: {
        async fetch() {
          throw new TranscriptSourceError("transcript-unavailable", "No transcript found");
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.status).toBe("transcript-unavailable");
      expect(result.record.errorCode).toBe("transcript-unavailable");
    }
  });

  test("preserves provider reason for transcript-unavailable ingestions", async () => {
    ({ repository, tempDir } = await createRepository());

    const result = await runIngestionFromUrl("https://youtu.be/1ZgUcrR0K7I", {
      outputDir: join(tempDir, "outputs"),
      repository,
      summarizer: fakeSummarizer(),
      transcriptSource: {
        async fetch() {
          throw new TranscriptSourceError(
            "transcript-unavailable",
            [
              "Could not retrieve a transcript for the video https://www.youtube.com/watch?v=1ZgUcrR0K7I! This is most likely caused by:",
              "",
              "YouTube is blocking requests from your IP.",
              "There are two things you can do to work around this:",
            ].join("\n"),
          );
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.errorMessage).toContain("Provider reason: YouTube is blocking requests from your IP.");
    }
  });

  test("logs transcript-unavailable ingestions", async () => {
    ({ repository, tempDir } = await createRepository());
    const logs: unknown[] = [];

    await runIngestionFromUrl("https://youtu.be/1ZgUcrR0K7I", {
      logger: { info: (event) => logs.push(event) },
      outputDir: join(tempDir, "outputs"),
      repository,
      summarizer: fakeSummarizer(),
      transcriptSource: {
        async fetch() {
          throw new TranscriptSourceError("transcript-unavailable", "No transcript found");
        },
      },
    });

    expect(logs).toContainEqual({
      event: "ingestion.transcript_unavailable",
      providerMessage: "No transcript found",
      videoId: "1ZgUcrR0K7I",
    });
  });
});

async function createRepository() {
  const tempDir = await mkdtemp(join(tmpdir(), "video-digest-service-"));
  const repository = new IngestionRepository({ dbPath: join(tempDir, "ingestions.sqlite") });
  return { repository, tempDir };
}

async function completedResult(outputDir: string): Promise<IngestVideoResult> {
  const metadataPath = join(outputDir, "metadata", "1ZgUcrR0K7I.json");
  await mkdir(join(outputDir, "metadata"), { recursive: true });
  await writeFile(
    metadataPath,
    `${JSON.stringify({
      digest: { digestTitle: "Useful Digest" },
      metadataSchemaVersion: "metadata.v0",
    })}\n`,
    { flag: "w" },
  );

  return {
    exitCode: 0,
    paths: {
      digestPath: join(outputDir, "digests", "1ZgUcrR0K7I.md"),
      emailPreviewPath: null,
      metadataPath,
      transcriptPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.json"),
    },
    status: "completed",
    transcriptQuality: {
      averageCharsPerMinute: 720,
      durationSeconds: 300,
      language: "en",
      qualitySchemaVersion: "transcript-quality.v0",
      segmentCount: 60,
      status: "usable",
      totalTextLength: 3600,
      warnings: [],
    },
  };
}

function fakeTranscriptSource(transcript: Transcript): TranscriptSource {
  return {
    async fetch(video: YouTubeVideo) {
      return { ...transcript, videoId: video.videoId };
    },
  };
}

function fakeSummarizer(): Summarizer {
  return {
    async generateDigest() {
      return {
        actionableIdeas: ["Apply it."],
        conceptsToInvestigate: ["Concept"],
        connections: ["Connection"],
        digestTitle: "Useful Digest",
        keyIdeas: ["Key idea"],
        relevantTimestamps: [{ note: "Important point", timestamp: "0:00" }],
        tldr: ["Short summary"],
        verdict: "watch_fragments",
      };
    },
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
