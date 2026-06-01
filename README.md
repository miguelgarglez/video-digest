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
bun run video-digest 'https://www.youtube.com/watch?v=1ZgUcrR0K7I'
```

In an interactive terminal, the CLI shows a small ASCII banner and animated spinner while it fetches the transcript, scores quality, generates the digest, and writes output artifacts. In non-TTY environments, it falls back to plain progress logs.

Transcript lookup currently tries English first and Spanish second. Spanish auto-generated transcripts are accepted and then scored by the transcript-quality heuristic before digest generation.

Generate an email preview too:

```sh
bun run video-digest 'https://www.youtube.com/watch?v=1ZgUcrR0K7I' --email-preview
```

Run without arguments to enter interactive mode:

```sh
bun run video-digest
```

Quote YouTube URLs in the shell because `?` and `&` can be interpreted by zsh.
