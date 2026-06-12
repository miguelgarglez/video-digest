# Personal Video Digest

A personal knowledge-ingestion system for turning selected YouTube videos into structured digests, emails, and future knowledge-base entries.

Current direction:

```text
YouTube playlist "Resumir"
-> transcript service
-> digest generation
-> email delivery
-> markdown/knowledge-base storage
```

See:

- `CONTEXT.md` for domain language.
- `docs/adr/` for architectural decisions.
- `docs/agents/` for agent skill configuration.

## Local prerequisites

- Bun 1.3.14
- Python 3
- uv 0.11.17

If `uv` is installed but not visible in the current shell, load its environment:

```sh
source "$HOME/.local/bin/env"
```

## Local setup

Install Bun dependencies:

```sh
bun install
```

Install Python sidecar dependencies:

```sh
cd python
uv sync
```

Create local environment config:

```sh
cp .env.example .env
```

Then set `OPENCODE_API_KEY` in `.env`.

The default model in `.env.example` is `gpt-5.4-nano`, which is available through OpenCode Zen.

## Usage

Run a single-video digest:

```sh
bun run video-digest ingest 'https://www.youtube.com/watch?v=1ZgUcrR0K7I'
```

In an interactive terminal, the CLI shows a small ASCII banner and animated spinner while it fetches the transcript, scores quality, generates the digest, and writes output artifacts. In non-TTY environments, it falls back to plain progress logs.

Transcript lookup currently tries English first and Spanish second. Spanish auto-generated transcripts are accepted and then scored by the transcript-quality heuristic before digest generation.

Generate an email preview too:

```sh
bun run video-digest ingest 'https://www.youtube.com/watch?v=1ZgUcrR0K7I' --email-preview
```

Use agent-safe JSON output:

```sh
bun --silent run video-digest ingest 'https://www.youtube.com/watch?v=1ZgUcrR0K7I' --json
```

Fetch only a transcript without requiring `OPENCODE_API_KEY`:

```sh
bun run video-digest transcript 'https://www.youtube.com/watch?v=1ZgUcrR0K7I'
bun --silent run video-digest transcript 'https://www.youtube.com/watch?v=1ZgUcrR0K7I' --json
```

Check local readiness:

```sh
bun run video-digest doctor
```

Manage the OpenCode token securely:

```sh
bun run video-digest config get
bun run video-digest config set opencode-api-key
bun run video-digest config unset opencode-api-key
```

List and open local digests:

```sh
bun run video-digest list
bun run video-digest open latest
```

Run without arguments to enter interactive mode:

```sh
bun run video-digest
```

Interactive mode asks whether to create a full digest or transcript-only artifacts. If
you choose a digest and no OpenCode token is configured, the CLI shows the OpenCode
setup link, lets you paste a token, offers to save it in macOS Keychain, and continues
the digest in the same run. If you skip token setup, it offers transcript-only mode
instead.

Show CLI help:

```sh
bun run video-digest --help
```

Quote YouTube URLs in the shell because `?` and `&` can be interpreted by zsh.

## Local CLI install

Expose the `video-digest` command globally on your Mac:

```sh
bun link
```

Then run it from any directory:

```sh
video-digest doctor
video-digest config get
video-digest config set opencode-api-key
video-digest ingest 'https://www.youtube.com/watch?v=1ZgUcrR0K7I'
video-digest ingest 'https://www.youtube.com/watch?v=1ZgUcrR0K7I' --json
video-digest transcript 'https://www.youtube.com/watch?v=1ZgUcrR0K7I' --json
```

Remove the global link:

```sh
bun unlink personal-video-digest
```

Public npm publishing is intentionally out of scope for now.

For global `video-digest ingest`, the recommended local setup is macOS Keychain:

```sh
video-digest config set opencode-api-key
```

The CLI resolves credentials in this order:

```text
1. OPENCODE_API_KEY from the shell environment
2. macOS Keychain
3. Not configured
```

You can still expose the token in your shell environment if you prefer:

```sh
export OPENCODE_API_KEY="..."
```

Without that token, use `video-digest transcript <youtube-url>` to fetch transcript
artifacts only. Transcript mode does not call OpenCode.

The CLI never prints stored token values. `config get` only reports where the token is
configured.
