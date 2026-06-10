import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { IngestionRepository } from "../storage/ingestion-repository";
import { recoverInterruptedIngestions } from "./startup";

describe("recoverInterruptedIngestions", () => {
  let tempDir = "";
  let repository: IngestionRepository | null = null;

  afterEach(async () => {
    repository?.close();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("marks existing processing records as failed", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "video-digest-startup-"));
    repository = new IngestionRepository({ dbPath: join(tempDir, "ingestions.sqlite") });
    repository.saveProcessing({
      canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      progressStage: "fetching-transcript",
      videoId: "1ZgUcrR0K7I",
    });

    const failedCount = recoverInterruptedIngestions(repository);

    expect(failedCount).toBe(1);
    expect(repository.findByVideoId("1ZgUcrR0K7I")).toMatchObject({
      errorCode: "interrupted-ingestion",
      status: "failed",
    });
  });
});
