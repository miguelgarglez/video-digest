# Parse Video URL and Provide CLI Shell

Status: ready-for-agent  
Category: enhancement

## What to build

Build the first vertical CLI path for `video-digest <youtube-url> [--email-preview]`. It should parse a YouTube URL into a canonical **Video** identity and report intended output behavior without calling transcript or LLM providers yet.

## Acceptance criteria

- [ ] `bun run video-digest <youtube-url>` invokes a TypeScript CLI entrypoint.
- [ ] Common YouTube URL formats produce the same `videoId`.
- [ ] Missing URL exits non-zero with a clear usage message.
- [ ] Unsupported URL exits non-zero with a clear validation error.
- [ ] `--email-preview` is parsed and represented in command options.
- [ ] Tests cover URL parsing and CLI argument behavior.

## Blocked by

None - can start immediately.
