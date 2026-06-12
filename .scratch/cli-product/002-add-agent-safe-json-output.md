# Add Agent-Safe JSON Output

Status: done
Category: enhancement

## Parent

.scratch/cli-product/000-prd.md

## What to build

Add an agent-safe output mode for **Ingestion** commands.

`video-digest ingest <youtube-url> --json` should produce one JSON object on stdout
with a versioned shape, stable status values, relevant artifact paths, and structured
error details. JSON mode should disable interactive prompts and spinner output so that
Codex and future automations can parse results reliably.

The human CLI output should keep working unchanged unless `--json` is requested.

## Acceptance criteria

- [ ] `bun run video-digest ingest <youtube-url> --json` writes exactly one JSON object
      to stdout on success.
- [ ] The success JSON includes `schemaVersion`, `status`, `videoId`,
      `canonicalUrl`, transcript path, digest path, metadata path, and optional email
      preview path.
- [ ] Failure JSON includes `schemaVersion`, `status`, `error.code`, and
      `error.message`.
- [ ] JSON mode never prompts for missing input.
- [ ] JSON mode never writes spinner frames or human progress lines to stdout.
- [ ] Exit codes are documented in code-level tests for success, invalid URL,
      transcript unavailable, unusable transcript, and unexpected failure.
- [ ] Tests use fake ingestion dependencies and do not call YouTube or OpenCode.

## Blocked by

- .scratch/cli-product/001-define-explicit-cli-commands.md
