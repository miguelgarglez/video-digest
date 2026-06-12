# Add Transcript-Only Command

Status: done
Category: enhancement

## Parent

.scratch/cli-config-transcript/000-prd.md

## What to build

Add `video-digest transcript <youtube-url> [--json]` as a token-free CLI path that
fetches a **Transcript**, scores **Transcript Quality**, and writes transcript +
metadata artifacts without generating a **Digest**.

## Acceptance criteria

- [ ] `video-digest transcript <youtube-url>` runs without `OPENCODE_API_KEY`.
- [ ] Transcript-only mode writes transcript and metadata artifacts.
- [ ] Transcript-only mode does not write digest or email artifacts.
- [ ] `--json` returns one parseable JSON object with `schemaVersion`, `status`,
      `videoId`, `canonicalUrl`, paths, and transcript quality.
- [ ] Human output includes transcript quality, transcript path, and metadata path.
- [ ] Tests cover parser, orchestration, output writing, and CLI behavior with fakes.

## Blocked by

None - can start immediately.
