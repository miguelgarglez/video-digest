import { mkdtemp, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createDigest } from "../digest/digest";
import type { Transcript } from "../transcript/transcript-source";
import type { TranscriptQuality } from "../transcript/transcript-quality";
import type { YouTubeVideo } from "../video/youtube-url";
import { writeIngestionOutputs, writeTranscriptOnlyOutputs } from "./output-writer";

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
