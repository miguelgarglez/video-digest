import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  listLibraryEntries,
  resolveLibraryEntry,
} from "./artifacts";

const VIDEO_ID = "1ZgUcrR0K7I";

describe("Artifact Library", () => {
  test("lists a transcript-only entry from metadata with only available artifact paths", async () => {
    const outputDir = await createLibrary();
    await seedMetadata(outputDir, VIDEO_ID, {
      channel: "Example Channel",
      processedAt: "2026-06-18T12:00:00.000Z",
      title: "Example Video",
    });
    await writeArtifact(outputDir, "transcripts", `${VIDEO_ID}.json`, "{}\n");
    await writeArtifact(outputDir, "transcripts", `${VIDEO_ID}.md`, "# Transcript\n");
    await writeArtifact(outputDir, "transcripts", `${VIDEO_ID}.txt`, "Transcript\n");

    expect(await listLibraryEntries(outputDir)).toEqual([
      {
        channel: "Example Channel",
        paths: {
          digestPath: null,
          emailPreviewPath: null,
          metadataPath: join(outputDir, "metadata", `${VIDEO_ID}.json`),
          transcriptJsonPath: join(outputDir, "transcripts", `${VIDEO_ID}.json`),
          transcriptMarkdownPath: join(outputDir, "transcripts", `${VIDEO_ID}.md`),
          transcriptTextPath: join(outputDir, "transcripts", `${VIDEO_ID}.txt`),
        },
        title: "Example Video",
        updatedAt: "2026-06-18T12:00:00.000Z",
        videoId: VIDEO_ID,
      },
    ]);
  });

  test("sorts by processedAt descending with a deterministic video ID tie-break", async () => {
    const outputDir = await createLibrary();
    for (const [videoId, processedAt] of [
      ["BBBBBBBBBBB", "2026-06-18T12:00:00.000Z"],
      ["AAAAAAAAAAA", "2026-06-18T12:00:00.000Z"],
      ["CCCCCCCCCCC", "2026-06-19T12:00:00.000Z"],
    ] as const) {
      await seedMetadata(outputDir, videoId, { processedAt });
      await writeArtifact(outputDir, "transcripts", `${videoId}.md`, "# Transcript\n");
    }

    expect((await listLibraryEntries(outputDir)).map((entry) => entry.videoId)).toEqual([
      "CCCCCCCCCCC",
      "AAAAAAAAAAA",
      "BBBBBBBBBBB",
    ]);
  });

  test("opens a digest before transcript Markdown and falls back to transcript Markdown", async () => {
    const outputDir = await createLibrary();
    await seedMetadata(outputDir, VIDEO_ID, { processedAt: "2026-06-18T12:00:00.000Z" });
    await writeArtifact(outputDir, "digests", `${VIDEO_ID}.md`, "# Digest\n");
    await writeArtifact(outputDir, "transcripts", `${VIDEO_ID}.md`, "# Transcript\n");

    const digestResult = await resolveLibraryEntry(outputDir, "latest");
    expect(digestResult).toMatchObject({
      ok: true,
      openPath: join(outputDir, "digests", `${VIDEO_ID}.md`),
    });

    const transcriptOnlyDir = await createLibrary();
    await seedMetadata(transcriptOnlyDir, VIDEO_ID, { processedAt: "2026-06-18T12:00:00.000Z" });
    await writeArtifact(transcriptOnlyDir, "transcripts", `${VIDEO_ID}.md`, "# Transcript\n");

    expect(await resolveLibraryEntry(transcriptOnlyDir, VIDEO_ID)).toMatchObject({
      ok: true,
      openPath: join(transcriptOnlyDir, "transcripts", `${VIDEO_ID}.md`),
    });
  });

  test("skips malformed, mismatched, and symlinked metadata without following external files", async () => {
    const outputDir = await createLibrary();
    const externalDir = await mkdtemp(join(tmpdir(), "video-digest-external-"));
    const externalMetadata = join(externalDir, `${VIDEO_ID}.json`);
    await writeFile(externalMetadata, JSON.stringify(metadata(VIDEO_ID, { processedAt: "2026-06-18T12:00:00.000Z" })));
    await writeFile(join(outputDir, "metadata", "AAAAAAAAAAA.json"), "not-json");
    await writeFile(
      join(outputDir, "metadata", "BBBBBBBBBBB.json"),
      JSON.stringify(metadata("CCCCCCCCCCC", { processedAt: "2026-06-18T12:00:00.000Z" })),
    );
    await symlink(externalMetadata, join(outputDir, "metadata", `${VIDEO_ID}.json`));
    await writeArtifact(outputDir, "transcripts", `${VIDEO_ID}.md`, "# External transcript candidate\n");

    expect(await listLibraryEntries(outputDir)).toEqual([]);
  });
});

async function createLibrary(): Promise<string> {
  const outputDir = await mkdtemp(join(tmpdir(), "video-digest-library-"));
  await mkdir(join(outputDir, "metadata"), { recursive: true });
  return outputDir;
}

async function seedMetadata(
  outputDir: string,
  videoId: string,
  input: { channel?: string | null; processedAt: string; title?: string | null },
): Promise<void> {
  await writeFile(
    join(outputDir, "metadata", `${videoId}.json`),
    `${JSON.stringify(metadata(videoId, input), null, 2)}\n`,
  );
}

function metadata(
  videoId: string,
  input: { channel?: string | null; processedAt: string; title?: string | null },
) {
  return {
    metadataSchemaVersion: "metadata.v0",
    mode: "transcript-only",
    processedAt: input.processedAt,
    transcriptQuality: {},
    video: {
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      channel: input.channel ?? null,
      durationSeconds: 60,
      videoId,
      videoTitle: input.title ?? null,
    },
  };
}

async function writeArtifact(outputDir: string, directory: string, name: string, contents: string): Promise<void> {
  await mkdir(join(outputDir, directory), { recursive: true });
  await writeFile(join(outputDir, directory, name), contents);
}
