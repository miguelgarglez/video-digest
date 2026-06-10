import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { IngestionRepository } from "./ingestion-repository";

describe("IngestionRepository", () => {
  let tempDir = "";
  let repository: IngestionRepository | null = null;

  afterEach(async () => {
    repository?.close();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("saves and retrieves ingestion records", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "video-digest-db-"));
    repository = new IngestionRepository({ dbPath: join(tempDir, "ingestions.sqlite") });

    const saved = repository.save({
      canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      digestPath: "outputs/digests/1ZgUcrR0K7I.md",
      digestTitle: "Useful Digest",
      metadataPath: "outputs/metadata/1ZgUcrR0K7I.json",
      status: "completed",
      transcriptPath: "outputs/transcripts/1ZgUcrR0K7I.json",
      transcriptQualityStatus: "usable",
      videoId: "1ZgUcrR0K7I",
      warnings: [],
    });

    expect(repository.findByVideoId("1ZgUcrR0K7I")).toEqual(saved);
    expect(repository.listRecent()).toHaveLength(1);
  });

  test("upserts records for the same video id", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "video-digest-db-"));
    repository = new IngestionRepository({ dbPath: join(tempDir, "ingestions.sqlite") });

    repository.save({
      canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      digestTitle: "First title",
      status: "completed",
      videoId: "1ZgUcrR0K7I",
    });

    const updated = repository.save({
      canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      digestTitle: "Updated title",
      errorCode: "transcript-unavailable",
      errorMessage: "No transcript",
      status: "transcript-unavailable",
      videoId: "1ZgUcrR0K7I",
    });

    expect(repository.listRecent()).toHaveLength(1);
    expect(updated.digestTitle).toBe("Updated title");
    expect(updated.status).toBe("transcript-unavailable");
  });

  test("persists processing records and updates progress stage", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "video-digest-db-"));
    repository = new IngestionRepository({ dbPath: join(tempDir, "ingestions.sqlite") });

    repository.saveProcessing({
      canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      progressStage: "queued",
      videoId: "1ZgUcrR0K7I",
    });

    const updated = repository.updateProgressStage("1ZgUcrR0K7I", "generating-digest");

    expect(updated?.status).toBe("processing");
    expect(updated?.progressStage).toBe("generating-digest");
    expect(repository.findByVideoId("1ZgUcrR0K7I")?.progressStage).toBe("generating-digest");
  });

  test("marks processing records as failed after restart", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "video-digest-db-"));
    repository = new IngestionRepository({ dbPath: join(tempDir, "ingestions.sqlite") });

    repository.saveProcessing({
      canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      progressStage: "generating-digest",
      videoId: "1ZgUcrR0K7I",
    });
    repository.save({
      canonicalUrl: "https://www.youtube.com/watch?v=completedVideo",
      status: "completed",
      videoId: "completedVideo",
    });

    const failedCount = repository.failProcessingRecords({
      errorCode: "interrupted-ingestion",
      errorMessage: "The server restarted before this ingestion completed.",
    });

    expect(failedCount).toBe(1);
    expect(repository.findByVideoId("1ZgUcrR0K7I")).toMatchObject({
      errorCode: "interrupted-ingestion",
      errorMessage: "The server restarted before this ingestion completed.",
      progressStage: null,
      status: "failed",
    });
    expect(repository.findByVideoId("completedVideo")?.status).toBe("completed");
  });
});
