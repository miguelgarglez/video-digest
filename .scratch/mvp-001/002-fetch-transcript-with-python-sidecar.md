# Fetch Transcript with Python Sidecar

Status: ready-for-agent  
Category: enhancement

## What to build

Implement a **Transcript Source** adapter that calls the `uv`-managed Python sidecar using `youtube-transcript-api` and returns a normalized **Transcript** for one **Video**.

## Acceptance criteria

- [ ] The core depends on a `TranscriptSource` interface, not Python directly.
- [ ] The adapter invokes a Python script through `uv run`.
- [ ] The Python script returns transcript JSON on stdout.
- [ ] Transcript segments include start time, duration where available, and text.
- [ ] Provider failures are mapped to structured errors.
- [ ] Tests cover adapter error mapping without requiring a live YouTube call.
- [ ] A manual smoke command can fetch a transcript for `1ZgUcrR0K7I`.

## Blocked by

- `.scratch/mvp-001/001-parse-video-url-and-cli-shell.md`
