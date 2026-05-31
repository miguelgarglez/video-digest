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

## Usage

Run a single-video digest:

```sh
bun run video-digest 'https://www.youtube.com/watch?v=1ZgUcrR0K7I'
```

Generate an email preview too:

```sh
bun run video-digest 'https://www.youtube.com/watch?v=1ZgUcrR0K7I' --email-preview
```

Quote YouTube URLs in the shell because `?` and `&` can be interpreted by zsh.
