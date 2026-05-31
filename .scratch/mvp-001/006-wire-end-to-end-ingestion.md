# Wire End-to-End Ingestion

Status: implemented-pending-provider-smoke  
Category: enhancement

## What to build

Connect CLI parsing, **Transcript Source**, **Transcript Quality**, `Summarizer`, and output writers into one end-to-end **Ingestion** flow for a single **Video** URL.

## Acceptance criteria

- [x] `bun run video-digest <youtube-url>` runs the full single-video path.
- [x] `usable` transcripts generate transcript, digest, and metadata outputs.
- [x] `warning` transcripts generate outputs with visible warnings.
- [x] `unusable` transcripts do not call the `Summarizer`, write structured metadata, and exit with code 2.
- [x] The command prints concise paths to created outputs.
- [ ] A smoke run with `1ZgUcrR0K7I` can be executed manually when OpenCode credentials are configured.
- [x] Tests cover the end-to-end path with fake adapters.

## Verification notes

- `bun run test` passes.
- `bun run video-digest 'https://www.youtube.com/watch?v=1ZgUcrR0K7I' --email-preview` reaches OpenCode configuration and fails clearly with `Missing OPENCODE_API_KEY`.
- Full provider smoke is pending local `.env` configuration.

## Blocked by

- `.scratch/mvp-001/005-write-versioned-output-artifacts.md`
