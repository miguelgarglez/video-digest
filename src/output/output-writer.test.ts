import { mkdir, mkdtemp, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createDigest } from "../digest/digest";
import type { Transcript } from "../transcript/transcript-source";
import type { TranscriptQuality } from "../transcript/transcript-quality";
import type { YouTubeVideo } from "../video/youtube-url";
import {
  OutputRecoveryError,
  writeIngestionOutputs,
  writeTranscriptOnlyOutputs,
} from "./output-writer";

describe("writeIngestionOutputs", () => {
  test("writes versioned transcript, digest, metadata, and email preview files", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-"));

    const result = await writeIngestionOutputs({
      digest,
      emailPreview: true,
      outputDir,
      transcript,
      transcriptQuality: warningQuality,
      video,
    });

    expect(result).toEqual({
      digestPath: join(outputDir, "digests", "1ZgUcrR0K7I.md"),
      emailPreviewPath: join(outputDir, "emails", "1ZgUcrR0K7I.md"),
      metadataPath: join(outputDir, "metadata", "1ZgUcrR0K7I.json"),
      transcriptJsonPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.json"),
      transcriptMarkdownPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.md"),
      transcriptTextPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.txt"),
    });

    expect(await readFile(result.transcriptJsonPath, "utf8")).toBe(
      `${JSON.stringify(transcript, null, 2)}\n`,
    );
    const transcriptJson = JSON.parse(await readFile(result.transcriptJsonPath, "utf8"));
    expect(transcriptJson.schemaVersion).toBe("transcript.v0");
    expect(await readFile(result.transcriptMarkdownPath, "utf8")).toBe(
      [
        "# Transcript 1ZgUcrR0K7I",
        "",
        `URL: ${video.canonicalUrl}`,
        "Language: en",
        "Source: youtube-transcript-api",
        "Provenance: unknown",
        "",
        "**00:00** Technology can change media businesses.",
        "",
      ].join("\n"),
    );
    expect(await readFile(result.transcriptTextPath, "utf8")).toBe(
      "Technology can change media businesses.\n",
    );

    const metadataJson = JSON.parse(await readFile(result.metadataPath, "utf8"));
    expect(metadataJson).toMatchObject({
      digest: {
        schemaVersion: "digest.v0",
      },
      transcriptQuality: {
        status: "warning",
        warnings: ["low-segment-count"],
      },
      video: {
        channel: null,
        durationSeconds: 5,
        videoId: "1ZgUcrR0K7I",
        videoTitle: null,
      },
    });
    expect(JSON.stringify(metadataJson)).not.toContain("test-secret");

    const markdown = await readFile(result.digestPath, "utf8");
    expect(markdown).toContain("# Generated Digest Title");
    expect(markdown).toContain("## Transcript warnings");
    expect(markdown).toContain("- low-segment-count");

    const email = await readFile(result.emailPreviewPath!, "utf8");
    expect(email).toContain("Subject: Generated Digest Title");
  });

  test("does not write email preview unless requested", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-"));

    const result = await writeIngestionOutputs({
      digest,
      emailPreview: false,
      outputDir,
      transcript,
      transcriptQuality: usableQuality,
      video,
    });

    expect(result.emailPreviewPath).toBeNull();
  });

  test("renames metadata after every other entry file", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-order-"));
    const renamedDestinations: string[] = [];

    await writeIngestionOutputs(
      {
        digest,
        emailPreview: true,
        outputDir,
        transcript,
        transcriptQuality: usableQuality,
        video,
      },
      {
        rename: async (from, to) => {
          renamedDestinations.push(to);
          await rename(from, to);
        },
        unlink,
        writeFile,
      },
    );

    expect(renamedDestinations.at(-1)).toBe(
      join(outputDir, "metadata", "1ZgUcrR0K7I.json"),
    );
  });

  test("commits metadata last and cleans temporary siblings after a write failure", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-failure-"));
    const renamedDestinations: string[] = [];
    const cleanedPaths: string[] = [];

    await expect(
      writeIngestionOutputs(
        {
          digest,
          emailPreview: false,
          outputDir,
          transcript,
          transcriptQuality: usableQuality,
          video,
        },
        {
          rename: async (from, to) => {
            renamedDestinations.push(to);
            await rename(from, to);
          },
          unlink: async (path) => {
            cleanedPaths.push(path);
            await unlink(path).catch(() => undefined);
          },
          writeFile: async (path, contents) => {
            if (path.includes("digests") && path.endsWith(".tmp")) {
              throw new Error("simulated write failure");
            }
            if (path.endsWith(".txt") || path.includes(".txt.")) {
              await Bun.sleep(20);
            }
            await writeFile(path, contents);
          },
        },
      ),
    ).rejects.toThrow("simulated write failure");

    expect(renamedDestinations).not.toContain(join(outputDir, "metadata", "1ZgUcrR0K7I.json"));
    expect(cleanedPaths.length).toBeGreaterThan(0);
    expect(cleanedPaths.every((path) => path.endsWith(".tmp"))).toBe(true);
    await Bun.sleep(30);
    expect((await readdir(outputDir, { recursive: true })).filter((path) => path.endsWith(".tmp")))
      .toEqual([]);
  });

  test("restores every previous artifact when replacement fails after installation starts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-rollback-"));
    const oldArtifacts = artifactContents(outputDir);
    await seedArtifacts(oldArtifacts);
    let installedCount = 0;

    await expect(
      writeIngestionOutputs(
        {
          digest,
          emailPreview: true,
          outputDir,
          transcript,
          transcriptQuality: usableQuality,
          video,
        },
        {
          rename: async (from, to) => {
            if (from.endsWith(".tmp")) {
              installedCount += 1;
              if (installedCount === 2) throw new Error("simulated install failure");
            }
            await rename(from, to);
          },
          unlink,
          writeFile,
        },
      ),
    ).rejects.toThrow("simulated install failure");

    expect(installedCount).toBe(2);
    for (const [path, contents] of oldArtifacts) {
      expect(await readFile(path, "utf8")).toBe(contents);
    }
    expect(
      (await readdir(outputDir, { recursive: true })).filter(
        (path) => path.endsWith(".tmp") || path.endsWith(".backup"),
      ),
    ).toEqual([]);
  });

  test("removes a stale email preview when a later ingest disables it", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-stale-email-"));
    const emailPath = join(outputDir, "emails", `${video.videoId}.md`);

    await writeIngestionOutputs({
      digest,
      emailPreview: true,
      outputDir,
      transcript,
      transcriptQuality: usableQuality,
      video,
    });
    expect(await readFile(emailPath, "utf8")).toContain("Subject:");

    await writeIngestionOutputs({
      digest,
      emailPreview: false,
      outputDir,
      transcript,
      transcriptQuality: usableQuality,
      video,
    });

    await expect(readFile(emailPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("restores a stale email when an ingest without preview rolls back", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-stale-email-rollback-"));
    const emailPath = join(outputDir, "emails", `${video.videoId}.md`);
    await mkdir(dirname(emailPath), { recursive: true });
    await writeFile(emailPath, "previous email\n");
    let installedCount = 0;

    await expect(
      writeIngestionOutputs(
        {
          digest,
          emailPreview: false,
          outputDir,
          transcript,
          transcriptQuality: usableQuality,
          video,
        },
        {
          rename: async (from, to) => {
            if (from.endsWith(".tmp") && ++installedCount === 2) {
              throw new Error("simulated install failure");
            }
            await rename(from, to);
          },
        },
      ),
    ).rejects.toThrow("simulated install failure");

    expect(await readFile(emailPath, "utf8")).toBe("previous email\n");
    expect(
      (await readdir(outputDir, { recursive: true })).filter(
        (path) => path.endsWith(".tmp") || path.endsWith(".backup"),
      ),
    ).toEqual([]);
  });

  test("preserves and reports a backup whose restoration fails", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-recovery-error-"));
    const oldArtifacts = artifactContents(outputDir);
    await seedArtifacts(oldArtifacts);
    let installedCount = 0;
    let unrestoredBackupPath = "";

    const promise = writeIngestionOutputs(
      {
        digest,
        emailPreview: true,
        outputDir,
        transcript,
        transcriptQuality: usableQuality,
        video,
      },
      {
        rename: async (from, to) => {
          if (from.endsWith(".tmp") && ++installedCount === 2) {
            throw new Error("simulated install failure");
          }
          if (from.endsWith(".backup") && to.endsWith(".json") && to.includes("transcripts")) {
            unrestoredBackupPath = from;
            throw new Error("simulated restore failure");
          }
          await rename(from, to);
        },
      },
    );

    const error = await promise.catch((caught) => caught);
    expect(error).toBeInstanceOf(OutputRecoveryError);
    expect(error.preservedBackupPaths).toEqual([unrestoredBackupPath]);
    expect(error.message).toContain("Restore these files manually");
    expect(await readFile(unrestoredBackupPath, "utf8")).toBe("old transcript json\n");
    const leftovers = (await readdir(outputDir, { recursive: true })).filter(
      (path) => path.endsWith(".tmp") || path.endsWith(".backup"),
    );
    expect(leftovers).toEqual([unrestoredBackupPath.slice(outputDir.length + 1)]);
  });
});

describe("writeTranscriptOnlyOutputs", () => {
  test("writes transcript and metadata without digest artifacts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-transcript-"));

    const result = await writeTranscriptOnlyOutputs({
      outputDir,
      transcript,
      transcriptQuality: usableQuality,
      video,
    });

    expect(result).toEqual({
      metadataPath: join(outputDir, "metadata", "1ZgUcrR0K7I.json"),
      transcriptJsonPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.json"),
      transcriptMarkdownPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.md"),
      transcriptTextPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.txt"),
    });

    expect(await readFile(result.transcriptJsonPath, "utf8")).toBe(
      `${JSON.stringify(transcript, null, 2)}\n`,
    );
    const transcriptJson = JSON.parse(await readFile(result.transcriptJsonPath, "utf8"));
    expect(transcriptJson.schemaVersion).toBe("transcript.v0");
    expect(await readFile(result.transcriptMarkdownPath, "utf8")).toBe(
      [
        "# Transcript 1ZgUcrR0K7I",
        "",
        `URL: ${video.canonicalUrl}`,
        "Language: en",
        "Source: youtube-transcript-api",
        "Provenance: unknown",
        "",
        "**00:00** Technology can change media businesses.",
        "",
      ].join("\n"),
    );
    expect(await readFile(result.transcriptTextPath, "utf8")).toBe(
      "Technology can change media businesses.\n",
    );

    const metadataJson = JSON.parse(await readFile(result.metadataPath, "utf8"));
    expect(metadataJson).toMatchObject({
      metadataSchemaVersion: "metadata.v0",
      mode: "transcript-only",
      transcriptQuality: {
        status: "usable",
      },
      video: {
        videoId: "1ZgUcrR0K7I",
      },
    });
    await expect(readFile(join(outputDir, "digests", "1ZgUcrR0K7I.md"), "utf8")).rejects.toThrow();
  });
});

const video: YouTubeVideo = {
  canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
  videoId: "1ZgUcrR0K7I",
};

const transcript: Transcript = {
  language: "en",
  provenance: { isAutoGenerated: null },
  schemaVersion: "transcript.v0",
  segments: [
    {
      duration: 5,
      start: 0,
      text: "Technology can change media businesses.",
    },
  ],
  source: "youtube-transcript-api",
  videoId: "1ZgUcrR0K7I",
};

const warningQuality: TranscriptQuality = {
  averageCharsPerMinute: 720,
  durationSeconds: 5,
  language: "en",
  qualitySchemaVersion: "transcript-quality.v0",
  segmentCount: 1,
  status: "warning",
  totalTextLength: 39,
  warnings: ["low-segment-count"],
};

const usableQuality: TranscriptQuality = {
  ...warningQuality,
  status: "usable",
  warnings: [],
};

const digest = createDigest({
  actionableIdeas: ["Study technology shifts in older industries."],
  conceptsToInvestigate: ["media economics"],
  connections: ["Connects to knowledge ingestion."],
  digestTitle: "Generated Digest Title",
  keyIdeas: ["Technology changes media economics."],
  relevantTimestamps: [
    {
      note: "Technology and media thesis.",
      timestamp: "0:00",
    },
  ],
  tldr: ["A concise digest."],
  verdict: "watch_fragments",
});

function artifactContents(outputDir: string): Map<string, string> {
  return new Map([
    [join(outputDir, "transcripts", `${video.videoId}.json`), "old transcript json\n"],
    [join(outputDir, "transcripts", `${video.videoId}.md`), "old transcript markdown\n"],
    [join(outputDir, "transcripts", `${video.videoId}.txt`), "old transcript text\n"],
    [join(outputDir, "digests", `${video.videoId}.md`), "old digest\n"],
    [join(outputDir, "metadata", `${video.videoId}.json`), "old metadata\n"],
    [join(outputDir, "emails", `${video.videoId}.md`), "old email\n"],
  ]);
}

async function seedArtifacts(artifacts: Map<string, string>): Promise<void> {
  await Promise.all(
    [...artifacts].map(async ([path, contents]) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    }),
  );
}
