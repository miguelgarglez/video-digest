import { describe, expect, test } from "bun:test";
import { runCli } from "./main";

describe("runCli", () => {
  test("runs ingestion and prints output paths", async () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(
      ["https://youtu.be/1ZgUcrR0K7I", "--email-preview"],
      {
        error: (message) => errors.push(message),
        log: (message) => logs.push(message),
      },
      {
        ingestVideo: async ({ emailPreview, video }) => ({
          exitCode: 0,
          paths: {
            digestPath: "outputs/digests/1ZgUcrR0K7I.md",
            emailPreviewPath: emailPreview ? "outputs/emails/1ZgUcrR0K7I.md" : null,
            metadataPath: "outputs/metadata/1ZgUcrR0K7I.json",
            transcriptPath: "outputs/transcripts/1ZgUcrR0K7I.json",
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
        }),
        outputDir: "outputs",
      },
    );

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toEqual([
      "Ingested video 1ZgUcrR0K7I",
      "Transcript quality: usable",
      "Transcript artifact: outputs/transcripts/1ZgUcrR0K7I.json",
      "Digest: outputs/digests/1ZgUcrR0K7I.md",
      "Metadata: outputs/metadata/1ZgUcrR0K7I.json",
      "Email preview: outputs/emails/1ZgUcrR0K7I.md",
    ]);
  });

  test("prints ingestion progress events", async () => {
    const logs: string[] = [];

    await runCli(
      ["https://youtu.be/1ZgUcrR0K7I"],
      {
        error: () => {},
        log: (message) => logs.push(message),
      },
      {
        ingestVideo: async (input) => {
          input.onProgress?.({ stage: "fetching-transcript", videoId: input.video.videoId });
          input.onProgress?.({ stage: "scoring-transcript", videoId: input.video.videoId });
          input.onProgress?.({ stage: "generating-digest", videoId: input.video.videoId });
          input.onProgress?.({ stage: "writing-outputs", videoId: input.video.videoId });
          input.onProgress?.({ stage: "completed", videoId: input.video.videoId });

          return {
            exitCode: 0,
            paths: {
              digestPath: "outputs/digests/1ZgUcrR0K7I.md",
              emailPreviewPath: null,
              metadataPath: "outputs/metadata/1ZgUcrR0K7I.json",
              transcriptPath: "outputs/transcripts/1ZgUcrR0K7I.json",
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
        },
      },
    );

    expect(logs.slice(0, 5)).toEqual([
      "[1/5] Fetching transcript for 1ZgUcrR0K7I",
      "[2/5] Scoring transcript quality",
      "[3/5] Generating digest",
      "[4/5] Writing output artifacts",
      "[5/5] Completed ingestion",
    ]);
  });

  test("prints usage errors and exits non-zero", async () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli([], {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    });

    expect(exitCode).toBe(1);
    expect(logs).toEqual([]);
    expect(errors).toEqual(["Usage: bun run video-digest <youtube-url> [--email-preview]"]);
  });

  test("prompts for URL and email preview when run interactively", async () => {
    const prompts: string[] = [];
    const logs: string[] = [];
    const answers = [
      "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      "y",
    ];

    const exitCode = await runCli(
      [],
      {
        error: () => {},
        log: (message) => logs.push(message),
        prompt: async (question) => {
          prompts.push(question);
          return answers.shift() ?? "";
        },
      },
      {
        ingestVideo: async ({ emailPreview }) => ({
          exitCode: 0,
          paths: {
            digestPath: "outputs/digests/1ZgUcrR0K7I.md",
            emailPreviewPath: emailPreview ? "outputs/emails/1ZgUcrR0K7I.md" : null,
            metadataPath: "outputs/metadata/1ZgUcrR0K7I.json",
            transcriptPath: "outputs/transcripts/1ZgUcrR0K7I.json",
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
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual(["YouTube URL: ", "Create email preview? [y/N]: "]);
    expect(logs).toContain("Email preview: outputs/emails/1ZgUcrR0K7I.md");
  });
});
