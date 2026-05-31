# Parse Video URL and Provide CLI Shell

Status: done  
Category: enhancement

## What to build

Build the first vertical CLI path for `video-digest <youtube-url> [--email-preview]`. It should parse a YouTube URL into a canonical **Video** identity and report intended output behavior without calling transcript or LLM providers yet.

## Acceptance criteria

- [x] `bun run video-digest <youtube-url>` invokes a TypeScript CLI entrypoint.
- [x] Common YouTube URL formats produce the same `videoId`.
- [x] Missing URL exits non-zero with a clear usage message.
- [x] Unsupported URL exits non-zero with a clear validation error.
- [x] `--email-preview` is parsed and represented in command options.
- [x] Tests cover URL parsing and CLI argument behavior.

## Blocked by

None - can start immediately.
