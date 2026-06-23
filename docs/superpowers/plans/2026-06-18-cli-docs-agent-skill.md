# Public Documentation and Agent Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give people an adoption-focused English README and agents a safe portable skill backed by explicit machine contracts.

**Architecture:** Keep onboarding in `README.md`, stable automation contracts in `docs/cli/`, and procedural agent guidance in one canonical `.agents/skills/video-digest` directory. Generate no duplicate platform-specific skill copies.

**Tech Stack:** Markdown, Agent Skills `SKILL.md`, GitHub CLI skill validation when available.

---

### Task 1: Public machine-contract reference

**Files:**
- Create: `docs/cli/json-contracts.md`
- Create: `docs/cli/exit-codes.md`
- Create: `docs/cli/compatibility.md`
- Create: `src/cli/documented-contracts.test.ts`

- [x] **Step 1: Write a failing documentation-contract test**

```ts
test("documents every emitted schema version and exit code", async () => {
  const jsonDocs = await readFile("docs/cli/json-contracts.md", "utf8");
  for (const schema of ["cli-result.v0", "doctor-report.v0", "library-list.v0", "open-result.v0", "config-status.v0", "config-result.v0", "setup-result.v0"]) {
    expect(jsonDocs).toContain(`\`${schema}\``);
  }
  const exitDocs = await readFile("docs/cli/exit-codes.md", "utf8");
  for (const code of [0, 1, 2]) expect(exitDocs).toContain(`| ${code} |`);
});
```

- [x] **Step 2: Verify the test fails**

Run: `bun test src/cli/documented-contracts.test.ts`  
Expected: FAIL because the public contract documents are missing.

- [x] **Step 3: Write exact contracts with real examples**

Document one complete success and failure JSON object per command, the rule that JSON
mode writes one value to stdout, diagnostic stderr behavior, exact numeric exit codes,
and the rule that breaking machine changes increment `schemaVersion` during `0.x`.

```json
{"schemaVersion":"cli-result.v0","status":"completed","videoId":"1ZgUcrR0K7I","paths":{"transcriptJsonPath":"...","transcriptMarkdownPath":"...","transcriptTextPath":"..."}}
```

- [x] **Step 4: Run the contract test**

Run: `bun test src/cli/documented-contracts.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add docs/cli src/cli/documented-contracts.test.ts
git commit -m "docs(cli): define public contracts"
```

### Task 2: Adoption-focused README and license

**Files:**
- Rewrite: `README.md`
- Create: `LICENSE`
- Modify: `.env.example`

- [x] **Step 1: Write the README outline with runnable commands**

Use these exact top-level sections:

```markdown
# Video Digest
## What it creates
## Status and support
## Prerequisites
## Install
## First run
## Direct commands
## Artifact Library
## Use with agents
## Privacy and security
## Troubleshooting
## Development
## License
```

- [x] **Step 2: Fill the quickstart and operational details**

Document `bun add --global video-digest`, the npm alternative, progressive TUI
onboarding, `video-digest setup`, Keychain configuration, Transcript output flags,
Artifact Library precedence, `doctor`, no telemetry, macOS ARM support, and the
experimental compatibility policy. Use public examples and never include a real key.

- [x] **Step 3: Add the MIT license and safe environment example**

Use the standard MIT text with copyright `2026 Miguel Garglez`. Keep `.env.example`
limited to documented non-secret placeholders and supported environment variables.

- [x] **Step 4: Verify commands and links referenced by the README**

Run: `bun run video-digest --help && bun run video-digest --version && rtk rg -n 'docs/cli|SKILL.md|video-digest setup' README.md`  
Expected: commands exit 0 and all referenced local paths exist.

- [x] **Step 5: Commit**

```bash
git add README.md LICENSE .env.example
git commit -m "docs: add public CLI onboarding"
```

### Task 3: Portable review-first agent skill

**Files:**
- Create: `.agents/skills/video-digest/SKILL.md`
- Create: `.agents/skills/video-digest/references/contracts.md`
- Create: `src/cli/agent-skill.test.ts`

- [x] **Step 1: Write a failing skill safety test**

```ts
test("skill is portable and requires consent for setup", async () => {
  const skill = await readFile(".agents/skills/video-digest/SKILL.md", "utf8");
  expect(skill).toContain("name: video-digest");
  expect(skill).toContain("video-digest doctor --json");
  expect(skill).toContain("human approval");
  expect(skill).not.toMatch(/allowed-tools:\s*(shell|bash)/);
});
```

- [x] **Step 2: Verify the test fails**

Run: `bun test src/cli/agent-skill.test.ts`  
Expected: FAIL because the skill is missing.

- [x] **Step 3: Write the canonical skill**

```markdown
---
name: video-digest
description: Use the Video Digest CLI to create Digests or retrieve Transcripts from explicitly supplied YouTube Videos. Use when a user asks to process a YouTube URL with video-digest.
license: MIT
---

1. Run `video-digest doctor --json`.
2. If runtime setup is required, explain the mutation and obtain human approval; never run setup autonomously.
3. Choose `transcript` or `ingest` from the user's intent and always pass `--json`.
4. Parse `schemaVersion`, `status`, and returned paths. Never scrape human output.
5. Never read, print, or request a stored credential.
```

Put payload and exit-code details in `references/contracts.md` so the main skill uses
progressive disclosure.

- [x] **Step 4: Validate and test the skill**

Run: `bun test src/cli/agent-skill.test.ts`  
Expected: PASS.

If installed GitHub CLI supports it, additionally run:

```bash
gh skill publish --dry-run
```

Expected: validation passes without publishing. If the command is unavailable, record
that fact; do not update or install GitHub CLI without user approval.

- [x] **Step 5: Commit**

```bash
git add .agents/skills/video-digest src/cli/agent-skill.test.ts
git commit -m "docs(skill): teach agent CLI usage"
```

### Task 4: TUI skill-discovery content

**Files:**
- Modify: `src/tui/screens.ts`
- Modify: `src/tui/screens.test.ts`
- Modify: `README.md`

- [x] **Step 1: Write a failing Agent Skill screen test**

```ts
test("agent skill screen is review-first", () => {
  const view = buildScreenView({ ...baseModel, screen: "agent-skill" });
  expect(view.body).toContain("gh skill preview miguelgarglez/personal-video-digest video-digest --allow-hidden-dirs");
  expect(view.body).toContain("gh skill install miguelgarglez/personal-video-digest video-digest --allow-hidden-dirs");
  expect(view.options).not.toContain("Install automatically");
});
```

- [x] **Step 2: Verify the test fails**

Run: `bun test src/tui/screens.test.ts`  
Expected: FAIL until the approved copy is present.

- [x] **Step 3: Add review, install, and source-link instructions**

Render the two copyable commands and an OSC 8 link to the repository's canonical
`SKILL.md`; never invoke `gh skill` from the TUI.

- [x] **Step 4: Run documentation and TUI tests**

Run: `bun test src/cli/documented-contracts.test.ts src/cli/agent-skill.test.ts src/tui/screens.test.ts && bun run typecheck`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/tui/screens.ts src/tui/screens.test.ts README.md
git commit -m "feat(tui): explain agent skill setup"
```
