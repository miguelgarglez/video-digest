import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { TranscriptSourceError } from "../transcript/transcript-source";
import { runCli } from "./main";

const JSON_CONTRACTS = "docs/cli/json-contracts.md";
const EXIT_CODES = "docs/cli/exit-codes.md";
const COMPATIBILITY = "docs/cli/compatibility.md";

const STDOUT_SCHEMAS = [
  "cli-result.v0",
  "doctor-report.v0",
  "library-list.v0",
  "open-result.v0",
  "config-status.v0",
  "config-result.v0",
  "setup-result.v0",
] as const;

const JSON_COMMANDS = ["ingest", "transcript", "setup", "config", "doctor", "list", "open"] as const;

const PUBLIC_ERROR_CODES = [
  "already-running",
  "conflicting-options",
  "consent-required",
  "copy-failed",
  "duplicate-option",
  "interactive-required",
  "invalid-provider-response",
  "invalid-url",
  "library-entry-not-found",
  "library-entry-not-openable",
  "missing-api-key",
  "missing-option-value",
  "missing-url",
  "open-failed",
  "provider-failed",
  "recovery-required",
  "reveal-failed",
  "runtime-not-ready",
  "setup-failed",
  "transcript-unavailable",
  "unexpected-error",
  "unsupported-command",
  "unsupported-option",
] as const;

function quotedValues(source: string): string[] {
  return [...source.matchAll(/"([a-z][a-z0-9-]+)"/g)].map((match) => match[1]!);
}

function declaration(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern)?.[1];
  if (!match) throw new Error(`Could not inspect ${label}`);
  return match;
}

describe("public CLI documentation contracts", () => {
  test("documents every stdout schema and JSON command with success and failure examples", async () => {
    const docs = await readFile(JSON_CONTRACTS, "utf8");

    for (const schema of STDOUT_SCHEMAS) expect(docs).toContain(`\`${schema}\``);
    for (const command of JSON_COMMANDS) {
      expect(docs).toContain(`## \`video-digest ${command}`);
      expect(docs).toContain(`<!-- ${command}:success -->`);
      expect(docs).toContain(`<!-- ${command}:failure -->`);
    }

    expect(docs).toContain("exactly one JSON object to stdout");
    expect(docs).toContain("Diagnostics, when present, are written to stderr");
  });

  test("keeps every documented JSON example parseable, public, and secret-free", async () => {
    const docs = await readFile(JSON_CONTRACTS, "utf8");
    const examples = [...docs.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]!);

    expect(examples.length).toBeGreaterThanOrEqual(JSON_COMMANDS.length * 2);
    for (const example of examples) {
      expect(() => JSON.parse(example)).not.toThrow();
      expect(example).not.toMatch(/\/Users\/|\/home\/|OPENCODE_API_KEY\s*[=:]/);
      expect(example.toLowerCase()).not.toContain("secret");
    }
  });

  test("documents every public error code and exact process exit status", async () => {
    const docs = await readFile(EXIT_CODES, "utf8");

    for (const exitCode of [0, 1, 2]) expect(docs).toContain(`| ${exitCode} |`);
    for (const errorCode of PUBLIC_ERROR_CODES) expect(docs).toContain(`\`${errorCode}\``);
    expect(docs).not.toMatch(/^\| [3-9]\d* \|/m);
  });

  test("derives the documented schemas and error codes from their implementation declarations", async () => {
    const [main, parser, runtime, actions, transcript, summarizer, artifacts] = await Promise.all([
      readFile("src/cli/main.ts", "utf8"),
      readFile("src/cli/parse-args.ts", "utf8"),
      readFile("src/cli/runtime-manager.ts", "utf8"),
      readFile("src/cli/system-actions.ts", "utf8"),
      readFile("src/transcript/transcript-source.ts", "utf8"),
      readFile("src/summarizer/summarizer.ts", "utf8"),
      readFile("src/cli/artifacts.ts", "utf8"),
    ]);

    const schemasInCli = new Set(
      [...main.matchAll(/schemaVersion: "([a-z-]+\.v\d+)"/g)].map((match) => match[1]!),
    );
    // config.v0 is written to the private config file; every other schema literal
    // in the CLI serializer is a public stdout schema.
    schemasInCli.delete("config.v0");
    expect([...schemasInCli].sort()).toEqual([...STDOUT_SCHEMAS].sort());

    const implementedCodes = new Set([
      ...quotedValues(declaration(parser, /export type CliError = \{[\s\S]*?code: ([^;]+);/, "CLI parser errors")),
      ...quotedValues(declaration(runtime, /constructor\(public readonly code: ([^,]+),/, "runtime setup errors")),
      ...quotedValues(declaration(actions, /constructor\(public readonly code: ([^,]+),/, "system action errors")),
      ...quotedValues(declaration(transcript, /export type TranscriptSourceErrorCode =([\s\S]*?);/, "Transcript errors")),
      ...quotedValues(declaration(summarizer, /export type SummarizerErrorCode =([^;]+);/, "Digest errors")),
      ...quotedValues(declaration(artifacts, /export type LibraryEntryErrorCode =([^;]+);/, "Library errors")),
      ...[...main.matchAll(/code: "([a-z][a-z0-9-]+)"/g)].map((match) => match[1]!),
      "setup-failed",
    ]);
    expect([...implementedCodes].sort()).toEqual([...PUBLIC_ERROR_CODES].sort());
  });

  test("matches the documented exit statuses against real CLI results", async () => {
    const quiet = { error: () => {}, log: () => {} };
    expect(await runCli(["--help"], quiet)).toBe(0);
    expect(await runCli(["ingest", "--json"], quiet)).toBe(1);
    expect(await runCli(
      ["transcript", "https://youtu.be/1ZgUcrR0K7I", "--json"],
      quiet,
      {
        configStore: { load: async () => null, save: async () => {} },
        fetchTranscriptOnly: async () => {
          throw new TranscriptSourceError("transcript-unavailable", "Subtitles are disabled");
        },
        runtimeManager: { inspect: async () => ({ status: "ready" }), prepare: async () => {} },
      },
    )).toBe(2);
  });

  test("documents the experimental compatibility and schema evolution policy", async () => {
    const docs = await readFile(COMPATIBILITY, "utf8");

    expect(docs).toContain("macOS on Apple Silicon (`darwin`/`arm64`)");
    expect(docs).toContain("Bun");
    expect(docs).toContain("Python 3.12");
    expect(docs).toContain("`uv`");
    expect(docs).toContain("does not install or modify system Python");
    expect(docs).toContain("increment the affected `schemaVersion`");
    expect(docs).toContain("0.x");
  });

  test("cross-references all public contract pages", async () => {
    const [jsonDocs, exitDocs, compatibilityDocs] = await Promise.all([
      readFile(JSON_CONTRACTS, "utf8"),
      readFile(EXIT_CODES, "utf8"),
      readFile(COMPATIBILITY, "utf8"),
    ]);

    expect(jsonDocs).toContain("[Exit codes](./exit-codes.md)");
    expect(exitDocs).toContain("[JSON contracts](./json-contracts.md)");
    expect(compatibilityDocs).toContain("[JSON contracts](./json-contracts.md)");
    expect(compatibilityDocs).toContain("[Exit codes](./exit-codes.md)");
  });
});
