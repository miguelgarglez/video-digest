---
name: video-digest
description: Use when a user asks to create a Digest or retrieve a Transcript from an explicitly supplied YouTube video URL with the Video Digest CLI.
license: MIT
---

# Video Digest

Operate the installed `video-digest` CLI through its versioned JSON contracts. Keep setup, credentials, and artifact access under human control.

Read [references/contracts.md](references/contracts.md) before invoking the CLI.

## Workflow

1. Require an explicit YouTube video URL from the user. Do not discover, guess, or substitute one.
2. Run `video-digest doctor --json`. Validate its exit status, `schemaVersion`, `ok`, and `checks`.
3. If Transcript runtime setup is required, explain that setup may install an isolated Python 3.12 runtime and locked Transcript dependencies. Obtain human approval before running `video-digest setup --yes --json`, then rerun Doctor. Never infer approval or run setup autonomously. Do not install missing host prerequisites.
4. Choose one operation from the user's intent:
   - Retrieve only a Transcript with `video-digest transcript '<youtube-url>' --json`.
   - Create a Digest and Transcript with `video-digest ingest '<youtube-url>' --json`.
5. Validate the process exit status and the command-specific schema. Reject unknown schema versions. Never scrape human-readable output.
6. Read only the returned artifact path needed to answer the request. Do not dump a raw Transcript unless the user asks for its contents.

For Library or settings requests, use only the documented JSON forms of `video-digest list`, `video-digest open`, and `video-digest config`. Obtain approval before persistent configuration changes.

## Safety boundaries

- Never launch the TUI. Always pass `--json` to operational commands.
- Never add `--copy`, `--open`, or `--stdout`; agent runs must not trigger clipboard or application side effects.
- Never inspect, request, capture, or print Keychain credentials or secret values.
- If Digest credentials are missing, offer Transcript-only operation or ask the user to configure credentials themselves. Do not accept the secret on their behalf.
- Never run `video-digest setup --yes --json` without current, explicit human approval.
- Treat package installation and skill installation as independent actions. Installing Video Digest never installs this skill.

## Common mistakes

- Do not invent commands or synthesize artifacts outside the CLI contract.
- Do not assume every JSON response has `status` or `paths`; schemas are command-specific.
- Do not treat Doctor warnings as failures when `ok` is `true`.
