import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "./parse-args";

describe("parseCliArgs", () => {
  test("parses a YouTube URL", () => {
    expect(parseCliArgs(["https://www.youtube.com/watch?v=1ZgUcrR0K7I"])).toEqual({
      ok: true,
      value: {
        command: "ingest",
        emailPreview: false,
        video: {
          canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
          videoId: "1ZgUcrR0K7I",
        },
      },
    });
  });

  test("parses the email preview flag", () => {
    const result = parseCliArgs([
      "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      "--email-preview",
    ]);

    expect(result.ok).toBe(true);
    if (result.ok && result.value.command === "ingest") {
      expect(result.value.emailPreview).toBe(true);
    }
  });

  test("parses the help flag", () => {
    expect(parseCliArgs(["--help"])).toEqual({
      ok: true,
      value: {
        command: "help",
      },
    });
  });

  test("returns usage error when URL is missing", () => {
    expect(parseCliArgs([])).toEqual({
      ok: false,
      error: {
        code: "missing-url",
        message: "Usage: bun run video-digest <youtube-url> [--email-preview]",
      },
    });
  });

  test("returns validation error for unsupported URLs", () => {
    expect(parseCliArgs(["https://example.com"])).toEqual({
      ok: false,
      error: {
        code: "invalid-url",
        message: "Unsupported YouTube URL: https://example.com",
      },
    });
  });
});
