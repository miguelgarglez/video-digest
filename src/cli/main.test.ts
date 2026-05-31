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
});
