# Wire End-to-End Ingestion

Status: ready-for-agent  
Category: enhancement

## What to build

Connect CLI parsing, **Transcript Source**, **Transcript Quality**, `Summarizer`, and output writers into one end-to-end **Ingestion** flow for a single **Video** URL.

## Acceptance criteria

- [ ] `bun run video-digest <youtube-url>` runs the full single-video path.
- [ ] `usable` transcripts generate transcript, digest, and metadata outputs.
- [ ] `warning` transcripts generate outputs with visible warnings.
- [ ] `unusable` transcripts do not call the `Summarizer`, write structured metadata, and exit with code 2.
- [ ] The command prints concise paths to created outputs.
- [ ] A smoke run with `1ZgUcrR0K7I` can be executed manually when OpenCode credentials are configured.
- [ ] Tests cover the end-to-end path with fake adapters.

## Blocked by

- `.scratch/mvp-001/005-write-versioned-output-artifacts.md`
