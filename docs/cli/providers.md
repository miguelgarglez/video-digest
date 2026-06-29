# Digest Providers and BYOK

Supported providers: OpenCode Zen, OpenAI, Anthropic, Google Gemini, and xAI.

Video Digest uses bring-your-own-key credentials. Keys are isolated by provider in
macOS Keychain and are never stored in `config.json`, metadata, logs, or normal JSON
output. There is no automatic provider fallback: a run uses exactly the selected
provider, model, endpoint, and credential.

| Provider ID | Protocol | Environment variable | Default model | Conformance |
| --- | --- | --- | --- | --- |
| `opencode` | Responses | `OPENCODE_API_KEY` | `gpt-5.4-mini` | Live-tested reference path |
| `openai` | Responses | `OPENAI_API_KEY` | `gpt-5.4-mini` | Contract-tested against the published API |
| `anthropic` | Messages | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | Contract-tested against the published API |
| `gemini` | OpenAI-compatible Chat Completions | `GEMINI_API_KEY` | `gemini-3.5-flash` | Contract-tested against the published API |
| `xai` | Responses | `XAI_API_KEY` | `grok-4.3` | Contract-tested against the published API |

“Contract-tested” is supported status: adapters have deterministic request, response,
error, and provenance tests. It also states honestly that the maintainer's private
live verification currently uses OpenCode Zen. Developers with another provider key
can run the explicit, redacted live harness described below.

## Selection and configuration

Provider precedence is `--provider`, `VIDEO_DIGEST_PROVIDER`, saved config, then
`opencode`. Model precedence is `--model`, `VIDEO_DIGEST_MODEL`, the selected
provider's saved override, then its product default.

```sh
video-digest config set provider anthropic
video-digest config set model claude-sonnet-4-6 --provider anthropic
video-digest config set api-key --provider anthropic
video-digest config unset api-key --provider anthropic
video-digest ingest '<youtube-url>' --provider anthropic --model claude-sonnet-4-6
```

Credential commands prompt interactively and never accept the secret as an argv
value. `video-digest config get` and `doctor` expose only presence and source.

Completed `metadata.v1` and `cli-result.v1` records include provider/model provenance,
nullable response model, request ID, and token usage. Library listings deliberately
do not expose request IDs.

## Conformance harness

After reviewing its one-request scope, a developer can opt in with:

```sh
bun run verify:provider-live --provider openai --yes
```

The harness reads only that provider's standard environment variable. Reports omit
content, headers, request IDs, and usage. OpenCode maintainers can additionally exercise
all three protocol adapters with `--zen-protocol responses`, `anthropic-messages`, or
`chat-completions`.

## Breaking migration to 1.0

Use the provider-neutral `config set api-key --provider opencode` command. Legacy
configuration, metadata, and affected machine contracts are intentionally not read.
Re-save configuration and reprocess old Library Entries when needed.
