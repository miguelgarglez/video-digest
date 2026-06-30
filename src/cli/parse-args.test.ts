import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "./parse-args";

describe("parseCliArgs", () => {
  test("parses provider and model overrides for ingest", () => {
    expect(parseCliArgs(["ingest", "https://youtu.be/1ZgUcrR0K7I", "--provider", "openai", "--model", "gpt-custom"]))
      .toMatchObject({ ok: true, value: { command: "ingest", model: "gpt-custom", provider: "openai" } });
  });

  test("parses provider-neutral config mutations", () => {
    expect(parseCliArgs(["config", "set", "provider", "anthropic"]))
      .toEqual({ ok: true, value: { command: "config", json: false, key: "provider", subcommand: "set", value: "anthropic" } });
    expect(parseCliArgs(["config", "set", "model", "claude-custom", "--provider", "anthropic"]))
      .toMatchObject({ ok: true, value: { key: "model", provider: "anthropic", value: "claude-custom" } });
    expect(parseCliArgs(["config", "set", "api-key", "--provider", "anthropic"]))
      .toMatchObject({ ok: true, value: { key: "api-key", provider: "anthropic" } });
    expect(parseCliArgs(["config", "set", "opencode-api-key"]).ok).toBe(false);
  });

  test.each([
    [["ingest", "https://youtu.be/1ZgUcrR0K7I", "--provider"]],
    [["ingest", "https://youtu.be/1ZgUcrR0K7I", "--model"]],
    [["ingest", "https://youtu.be/1ZgUcrR0K7I", "--provider", "wat"]],
    [["transcript", "https://youtu.be/1ZgUcrR0K7I", "--model", "x"]],
    [["config", "set", "api-key", "secret-looking-value", "--provider", "openai"]],
  ])("rejects invalid provider option shape: %j", (args) => {
    expect(parseCliArgs(args).ok).toBe(false);
  });
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
        copy: false,
        json: true,
        open: false,
        stdout: false,
        video: {
          canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
          videoId: "1ZgUcrR0K7I",
        },
      },
    });
  });

  test("parses transcript presentation actions", () => {
    expect(parseCliArgs(["transcript", "https://youtu.be/1ZgUcrR0K7I", "--copy", "--open", "--stdout"])).toMatchObject({
      ok: true,
      value: { command: "transcript", copy: true, open: true, stdout: true },
    });
  });

  test("rejects stdout with json", () => {
    expect(parseCliArgs(["transcript", "https://youtu.be/1ZgUcrR0K7I", "--json", "--stdout"])).toMatchObject({
      ok: false,
      error: { code: "conflicting-options" },
    });
  });

  test.each(["--copy", "--open", "--stdout"])("rejects transcript action %s on ingest", (flag) => {
    expect(parseCliArgs(["ingest", "https://youtu.be/1ZgUcrR0K7I", flag])).toMatchObject({
      ok: false,
      error: { code: "unsupported-option" },
    });
  });

  test("rejects duplicate options", () => {
    expect(parseCliArgs(["transcript", "https://youtu.be/1ZgUcrR0K7I", "--copy", "--copy"])).toMatchObject({
      ok: false,
      error: { code: "duplicate-option" },
    });
  });

  test.each([
    [["doctor", "--bogus"]],
    [["list", "--copy"]],
    [["transcript", "https://youtu.be/1ZgUcrR0K7I", "--email-preview"]],
  ])("rejects unsupported command flags: %j", (args) => {
    expect(parseCliArgs(args)).toMatchObject({ ok: false, error: { code: "unsupported-option" } });
  });

  test.each([
    [["doctor", "extra"]],
    [["list", "extra"]],
    [["open", "latest", "extra"]],
    [["transcript", "https://youtu.be/1ZgUcrR0K7I", "extra"]],
    [["config", "get", "extra"]],
  ])("rejects extra command arguments: %j", (args) => {
    expect(parseCliArgs(args)).toMatchObject({ ok: false, error: { code: "unsupported-command" } });
  });

  test("parses command-scoped help and version", () => {
    expect(parseCliArgs(["transcript", "--help"])).toEqual({ ok: true, value: { command: "help", topic: "transcript" } });
    expect(parseCliArgs(["--version"])).toEqual({ ok: true, value: { command: "version" } });
  });

  test.each([
    [["ingest", "--output-dir", "/library", "https://youtu.be/1ZgUcrR0K7I"], "ingest"],
    [["transcript", "https://youtu.be/1ZgUcrR0K7I", "--output-dir", "/library"], "transcript"],
    [["list", "--output-dir", "/library", "--json"], "list"],
    [["open", "--json", "--output-dir", "/library", "latest"], "open"],
  ])("parses --output-dir without treating its value as positional: %j", (args, command) => {
    const result = parseCliArgs(args);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.command).toBe(command as typeof result.value.command);
      expect("outputDir" in result.value ? result.value.outputDir : undefined).toBe("/library");
    }
  });

  test.each([
    [["doctor", "--output-dir", "/library"]],
    [["doctor", "--output-dir"]],
    [["config", "get", "--output-dir", "/library"]],
    [["config", "get", "--output-dir"]],
    [["wat", "--output-dir", "/library"]],
    [["wat", "--output-dir"]],
  ])("rejects --output-dir for unsupported commands: %j", (args) => {
    expect(parseCliArgs(args)).toEqual({
      ok: false,
      error: {
        code: "unsupported-option",
        message: "--output-dir is only supported for ingest, transcript, list, and open.\n\nUsage: video-digest <command> [options]",
      },
    });
  });

  test.each([
    ["ingest"], ["transcript"], ["list"], ["open"],
  ])("returns actionable usage when --output-dir has no value for %s", (command) => {
    expect(parseCliArgs([command, "--output-dir"])).toEqual({
      ok: false,
      error: {
        code: "missing-option-value",
        message: "--output-dir requires a non-empty path.\n\nUsage: video-digest <command> [options] [--output-dir <path>]",
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

  test("parses setup consent and json flags", () => {
    expect(parseCliArgs(["setup", "--yes", "--json"])).toEqual({
      ok: true,
      value: { command: "setup", json: true, yes: true },
    });
    expect(parseCliArgs(["setup"])).toEqual({
      ok: true,
      value: { command: "setup", json: false, yes: false },
    });
  });

  test("rejects output-dir for setup", () => {
    expect(parseCliArgs(["setup", "--output-dir", "/library"])).toMatchObject({
      ok: false,
      error: { code: "unsupported-option" },
    });
  });

  test("rejects extra setup positional arguments", () => {
    expect(parseCliArgs(["setup", "unexpected"])).toEqual({
      ok: false,
      error: {
        code: "unsupported-command",
        message: "Unexpected setup argument: unexpected\n\nUsage: video-digest setup [--yes] [--json]",
      },
    });
  });

  test("rejects unknown setup options", () => {
    expect(parseCliArgs(["setup", "--bogus"])).toEqual({
      ok: false,
      error: {
        code: "unsupported-option",
        message: "Unsupported setup option: --bogus\n\nUsage: video-digest setup [--yes] [--json]",
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
    expect(parseCliArgs(["config", "set", "api-key", "--provider", "opencode"])).toEqual({
      ok: true,
      value: {
        command: "config",
        json: false,
        key: "api-key",
        provider: "opencode",
        subcommand: "set",
      },
    });
    expect(parseCliArgs(["config", "unset", "api-key", "--provider", "opencode"])).toEqual({
      ok: true,
      value: {
        command: "config",
        json: false,
        key: "api-key",
        provider: "opencode",
        subcommand: "unset",
      },
    });
    expect(parseCliArgs(["config", "set", "output-dir", "/library"])).toEqual({
      ok: true,
      value: {
        command: "config",
        json: false,
        key: "output-dir",
        subcommand: "set",
        value: "/library",
      },
    });
  });

  test.each([
    [["config", "set", "output-dir"]],
    [["config", "set", "output-dir", ""]],
  ])("returns output-dir usage when config value is missing: %j", (args) => {
    expect(parseCliArgs(args)).toEqual({
      ok: false,
      error: {
        code: "missing-option-value",
        message: "output-dir requires a non-empty path.\n\nUsage: video-digest config set output-dir <path> [--json]",
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
