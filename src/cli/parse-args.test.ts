import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "./parse-args";

describe("parseCliArgs", () => {
  test("parses a legacy YouTube URL as an ingest command", () => {
    expect(parseCliArgs(["https://www.youtube.com/watch?v=1ZgUcrR0K7I"])).toEqual({
      ok: true,
      value: {
        command: "ingest",
        emailPreview: false,
        json: false,
        video: {
          canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
          videoId: "1ZgUcrR0K7I",
        },
      },
    });
  });

  test("parses an explicit ingest command", () => {
    expect(parseCliArgs(["ingest", "https://www.youtube.com/watch?v=1ZgUcrR0K7I"])).toEqual({
      ok: true,
      value: {
        command: "ingest",
        emailPreview: false,
        json: false,
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

  test("parses the json flag for ingest", () => {
    const result = parseCliArgs([
      "ingest",
      "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      "--json",
    ]);

    expect(result.ok).toBe(true);
    if (result.ok && result.value.command === "ingest") {
      expect(result.value.json).toBe(true);
    }
  });

  test("parses transcript command", () => {
    expect(parseCliArgs(["transcript", "https://www.youtube.com/watch?v=1ZgUcrR0K7I", "--json"])).toEqual({
      ok: true,
      value: {
        command: "transcript",
        json: true,
        video: {
          canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
          videoId: "1ZgUcrR0K7I",
        },
      },
    });
  });

  test("returns transcript usage when transcript URL is missing", () => {
    expect(parseCliArgs(["transcript"])).toEqual({
      ok: false,
      error: {
        code: "missing-url",
        message: "Usage: video-digest transcript <youtube-url> [--json]",
      },
    });
  });

  test("parses doctor command", () => {
    expect(parseCliArgs(["doctor", "--json"])).toEqual({
      ok: true,
      value: {
        command: "doctor",
        json: true,
      },
    });
  });

  test("parses list command", () => {
    expect(parseCliArgs(["list", "--json"])).toEqual({
      ok: true,
      value: {
        command: "list",
        json: true,
      },
    });
  });

  test("parses open command", () => {
    expect(parseCliArgs(["open", "latest", "--json"])).toEqual({
      ok: true,
      value: {
        command: "open",
        json: true,
        target: "latest",
      },
    });
  });

  test("parses config commands", () => {
    expect(parseCliArgs(["config", "get", "--json"])).toEqual({
      ok: true,
      value: {
        command: "config",
        json: true,
        subcommand: "get",
      },
    });
    expect(parseCliArgs(["config", "set", "opencode-api-key"])).toEqual({
      ok: true,
      value: {
        command: "config",
        json: false,
        key: "opencode-api-key",
        subcommand: "set",
      },
    });
    expect(parseCliArgs(["config", "unset", "opencode-api-key"])).toEqual({
      ok: true,
      value: {
        command: "config",
        json: false,
        key: "opencode-api-key",
        subcommand: "unset",
      },
    });
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

  test("returns usage error for unsupported commands", () => {
    expect(parseCliArgs(["wat"])).toEqual({
      ok: false,
      error: {
        code: "unsupported-command",
        message: "Unsupported command: wat\n\nUsage: video-digest <command> [options]",
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
