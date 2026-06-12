# Clarify Configuration Readiness

Status: done
Category: enhancement

## Parent

.scratch/cli-config-transcript/000-prd.md

## What to build

Improve configuration feedback now that the CLI has both token-free transcript mode
and token-required digest mode.

## Acceptance criteria

- [ ] Missing `OPENCODE_API_KEY` during `ingest` explains that digest generation
      requires the token.
- [ ] The missing-token message suggests `video-digest transcript <youtube-url>`.
- [ ] JSON mode returns a structured `missing-api-key` error.
- [ ] `doctor` distinguishes transcript readiness from digest readiness.
- [ ] README documents shell environment configuration and transcript-only fallback.

## Blocked by

- .scratch/cli-config-transcript/001-add-transcript-only-command.md
