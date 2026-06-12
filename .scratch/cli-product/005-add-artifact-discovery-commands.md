# Add Artifact Discovery Commands

Status: done
Category: enhancement

## Parent

.scratch/cli-product/000-prd.md

## What to build

Add commands for discovering and opening local **Digest** artifacts produced by prior
**Ingestions**.

`video-digest list` should show recent local **Digests**. `video-digest list --json`
should expose the same discovery data for agents. `video-digest open latest` and
`video-digest open <video-id>` should locate the relevant Markdown **Digest** artifact
and open it for human use.

## Acceptance criteria

- [ ] `bun run video-digest list` shows recent **Digests** from the configured output
      directory.
- [ ] `bun run video-digest list --json` returns a versioned JSON object with recent
      artifact entries.
- [ ] Each listed entry includes `videoId`, digest path, metadata path when available,
      digest title when available, and updated/created time when discoverable.
- [ ] `bun run video-digest open latest` opens the newest Markdown **Digest** in human
      mode.
- [ ] `bun run video-digest open <video-id>` opens the matching Markdown **Digest** in
      human mode.
- [ ] Agent-safe mode returns paths instead of launching the operating system opener.
- [ ] Missing artifacts produce clear human and JSON errors.
- [ ] Tests use temporary output directories and do not open real user files.

## Blocked by

- .scratch/cli-product/002-add-agent-safe-json-output.md
