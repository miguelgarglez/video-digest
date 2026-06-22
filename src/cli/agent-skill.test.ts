import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

const SKILL_ROOT = ".agents/skills/video-digest";
const SKILL_PATH = `${SKILL_ROOT}/SKILL.md`;
const CONTRACTS_PATH = `${SKILL_ROOT}/references/contracts.md`;
const OPENAI_METADATA_PATH = `${SKILL_ROOT}/agents/openai.yaml`;

describe("portable Video Digest agent skill", () => {
  test("is portable, review-first, and requires explicit human consent for setup", async () => {
    const [skill, contracts, metadata] = await Promise.all([
      readFile(SKILL_PATH, "utf8"),
      readFile(CONTRACTS_PATH, "utf8"),
      readFile(OPENAI_METADATA_PATH, "utf8"),
    ]);
    const bundle = `${skill}\n${contracts}\n${metadata}`;

    expect(skill).toContain("name: video-digest");
    expect(skill).toMatch(/^description: Use when /m);
    expect(skill).toContain("license: MIT");
    expect(skill).toContain("video-digest doctor --json");
    expect(skill).toContain("human approval");
    expect(skill).toContain("video-digest setup --yes --json");
    expect(skill).toContain("references/contracts.md");
    expect(skill).not.toMatch(/allowed-tools:\s*(shell|bash)/i);
    expect(bundle).not.toMatch(/\/Users\/|\/home\/|personal-video-digest|bun run|src\/cli/);
    expect(bundle).not.toMatch(/video-digest\s+process\b/);
    expect(bundle).not.toMatch(/(?:install|update|upgrade)\s+(?:the\s+)?(?:GitHub CLI|gh\b)/i);
    expect(metadata).toContain('display_name: "Video Digest"');
    expect(metadata).toMatch(/short_description: ".{25,64}"/);
    expect(metadata).toContain("$video-digest");
  });

  test("documents only real commands and command-specific machine contracts", async () => {
    const [skill, contracts] = await Promise.all([
      readFile(SKILL_PATH, "utf8"),
      readFile(CONTRACTS_PATH, "utf8"),
    ]);
    const documentedCommands = new Set(
      [...`${skill}\n${contracts}`.matchAll(/`video-digest\s+([a-z-]+)/g)]
        .map((match) => match[1]),
    );

    expect(documentedCommands).toEqual(new Set([
      "config",
      "doctor",
      "ingest",
      "list",
      "open",
      "setup",
      "transcript",
    ]));
    for (const schema of [
      "cli-result.v0",
      "config-result.v0",
      "config-status.v0",
      "doctor-report.v0",
      "library-list.v0",
      "open-result.v0",
      "setup-result.v0",
    ]) {
      expect(contracts).toContain(`\`${schema}\``);
    }
    expect(contracts).toContain("exit status");
    expect(contracts).toContain("unknown schemaVersion");
    expect(contracts).toContain("Do not parse stderr");
  });

  test("keeps the skill concise and free of duplicate auxiliary documentation", async () => {
    const [skill, entries] = await Promise.all([
      readFile(SKILL_PATH, "utf8"),
      readdir(SKILL_ROOT, { recursive: true }),
    ]);

    expect(skill.trimEnd().split("\n").length).toBeLessThanOrEqual(500);
    expect(entries.filter((entry) => /(^|\/)README\.md$/i.test(entry))).toEqual([]);
  });
});
