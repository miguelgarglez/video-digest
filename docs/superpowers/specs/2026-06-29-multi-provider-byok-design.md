# Multi-provider BYOK Digest generation

Status: Approved
Date: 2026-06-29
Target release: 1.0.0

## Objective

Allow each Video Digest user to generate a Digest with their preferred direct LLM
provider and API key. The first supported providers are OpenCode Zen, OpenAI,
Anthropic, Google Gemini, and xAI.

This is an intentional breaking change. Version 1.0.0 replaces the OpenCode-specific
configuration and public contracts with a provider-neutral design. It does not retain
`config.v0`, legacy credential commands, or legacy environment overrides.

## Product principles

- BYOK is direct: a user can authenticate with the provider they selected.
- Provider selection never triggers an automatic fallback to another provider.
- The Digest structure, prompt intent, and local validation remain provider-neutral.
- Secrets remain in provider environment variables or macOS Keychain, never config,
  logs, artifacts, command arguments, or machine-readable output.
- Provider differences are represented explicitly instead of hidden behind a claim of
  universal OpenAI compatibility.
- Provider and model provenance is persisted for reproducibility.
- Normal tests and Doctor checks make no billable model requests.

## Terminology

- **Digest Provider**: the remote service selected to generate a Digest.
- **Provider Profile**: declarative configuration for one Digest Provider, including
  protocol, endpoint, credential variable, default model, and capabilities.
- **Protocol Adapter**: code that translates the provider-neutral summarization request
  into a remote API protocol and normalizes its response.
- **Generation Provenance**: non-secret metadata identifying the provider, model,
  request, and reported token usage for a generated Digest.

These terms should be added to `CONTEXT.md` during implementation.

## Supported providers and protocols

| Provider | Provider ID | Protocol adapter | Credential environment variable |
| --- | --- | --- | --- |
| OpenCode Zen | `opencode` | OpenAI Responses | `OPENCODE_API_KEY` |
| OpenAI | `openai` | OpenAI Responses | `OPENAI_API_KEY` |
| Anthropic | `anthropic` | Anthropic Messages | `ANTHROPIC_API_KEY` |
| Google Gemini | `gemini` | OpenAI-compatible Chat Completions | `GEMINI_API_KEY` |
| xAI | `xai` | OpenAI Responses | `XAI_API_KEY` |

OpenCode Zen is a gateway with its own API key, not a generic key accepted by the
underlying model vendors. OpenCode itself supports many providers, but Video Digest
currently calls the Zen API directly and does not use OpenCode as a provider runtime.

Anthropic's OpenAI compatibility layer is not used. Anthropic documents it primarily
for evaluation, and it ignores `response_format`; the native Messages API provides the
structured-output guarantee required by Video Digest.

Gemini uses its documented OpenAI-compatible Chat Completions endpoint. xAI uses its
documented Responses API compatibility. OpenRouter, Mistral, Groq, Together,
Fireworks, DeepSeek, Cohere, Bedrock, Vertex AI, and Azure-hosted variants are outside
the 1.0.0 scope.

The initial set prioritizes direct providers with broad developer relevance while
covering the three protocol families needed for future expansion. OpenAI compatibility
is treated as a family of related interfaces, not a guarantee that Responses, Chat
Completions, authentication, and structured outputs behave identically.

The design is based on the providers' official documentation:

- [OpenCode Zen endpoints](https://opencode.ai/docs/zen)
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic OpenAI SDK compatibility](https://platform.claude.com/docs/en/api/openai-sdk)
- [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [Gemini Structured Outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- [xAI Structured Outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)

## Architecture

The domain-facing `Summarizer` remains the stable port used by Ingestion. Provider and
protocol details stay behind that boundary.

```text
CLI / TUI
  -> Digest configuration resolver
  -> Provider registry
  -> Protocol adapter
       - OpenAI Responses
       - OpenAI-compatible Chat Completions
       - Anthropic Messages
  -> common DigestDraft validation
  -> Ingestion and atomic artifact writing
```

### Provider registry

The registry contains one immutable profile per supported provider. Each profile owns:

- provider ID and display name;
- protocol adapter ID;
- fixed default endpoint;
- credential environment variable;
- curated default model;
- structured-output capability metadata.

Version 1.0.0 does not expose arbitrary base URLs or a custom-provider profile. This
keeps the support claim testable and prevents an unbounded compatibility surface.

### Protocol adapters

Adapters use the platform `fetch` implementation; no provider SDK or new dependency is
required.

Each adapter must:

1. construct the provider-specific request from the common prompt and JSON Schema;
2. set the correct authentication and version headers;
3. forward cancellation through `AbortSignal`;
4. classify transport and provider failures without exposing the response body;
5. extract output text and optional provenance fields;
6. return a normalized result for local validation.

Prompt construction, the Digest JSON Schema, `DigestDraft` validation, and semantic
creation of a `Digest` remain shared code.

## Configuration

### Persistent format

Only `config.v1` is accepted:

```json
{
  "schemaVersion": "config.v1",
  "artifactLibrary": "/Users/example/Video Digest",
  "digest": {
    "defaultProvider": "anthropic",
    "models": {
      "anthropic": "provider-model-id",
      "openai": "provider-model-id"
    }
  }
}
```

Model overrides are stored per provider so switching providers cannot pair a provider
with another provider's model ID. Missing overrides use the selected provider's
curated default.

The default provider for a new installation is OpenCode Zen. It preserves the current
product's simplest onboarding path without retaining the legacy configuration schema.

### Commands

```text
video-digest config set provider <provider>
video-digest config set model <model> [--provider <provider>]
video-digest config set api-key --provider <provider>
video-digest config unset api-key --provider <provider>
video-digest config get [--json]

video-digest ingest <url> [--provider <provider>] [--model <model>]
```

`config set model` without `--provider` updates the effective provider. Provider and
model flags on `ingest` affect one execution and do not mutate persistent config.

API keys are never accepted as option values. Credential mutation remains interactive;
`--json` returns `interactive-required` instead of prompting.

### Resolution precedence

Provider:

1. `--provider`;
2. `VIDEO_DIGEST_PROVIDER`;
3. `digest.defaultProvider`;
4. the `opencode` product default.

Model, after resolving the provider:

1. `--model`;
2. `VIDEO_DIGEST_MODEL`;
3. `digest.models[provider]`;
4. the selected Provider Profile default.

Credential, after resolving the provider:

1. the selected profile's standard environment variable;
2. the selected provider's macOS Keychain entry;
3. missing.

Environment variables or stored keys for unselected providers do not influence an
execution.

### Credential storage

The Keychain service remains `video-digest`. New accounts use a uniform internal name
derived from the provider ID, for example `provider:anthropic:api-key`. The store API is
provider-neutral:

```ts
getApiKey(provider): Promise<string | null>
setApiKey(provider, value): Promise<void>
deleteApiKey(provider): Promise<void>
```

The implementation must pass values as distinct process arguments and must never
include them in thrown errors. The legacy `opencode-api-key` entry is not read or
automatically migrated.

### Configuration status

`config get` reports effective provider/model values and sources, plus credential
presence for every supported provider. It never reports secret values.

The new machine contract is `config-status.v1`. Its conceptual shape is:

```json
{
  "schemaVersion": "config-status.v1",
  "artifactLibrary": {
    "configured": "/configured/path",
    "effective": "/effective/path",
    "source": "config"
  },
  "digest": {
    "provider": { "effective": "anthropic", "source": "config" },
    "model": { "effective": "provider-model-id", "source": "config" }
  },
  "credentials": {
    "anthropic": { "configured": true, "source": "keychain" },
    "gemini": { "configured": false, "source": "missing" },
    "opencode": { "configured": false, "source": "missing" },
    "openai": { "configured": false, "source": "missing" },
    "xai": { "configured": false, "source": "missing" }
  }
}
```

The exact source enum is `flag | env | config | default` for provider and model, and
`env | keychain | missing` for credentials.

## TUI experience

Settings adds provider selection, model configuration, and credential status. A user
can configure or remove the selected provider's credential without displaying it.

When Ingestion needs a missing credential, the prompt names the effective provider and
offers these outcomes:

- configure that provider's key;
- create only a Transcript;
- cancel.

The TUI never suggests that one provider's key can authenticate with another provider.

## Ingestion data flow

1. Resolve effective provider and model.
2. Resolve the selected provider's credential.
3. Select its profile and protocol adapter.
4. Build the shared prompt and Digest JSON Schema.
5. issue exactly one generation request;
6. normalize response text and Generation Provenance;
7. parse and validate `DigestDraft` locally;
8. create the domain `Digest`;
9. atomically write artifacts and `metadata.v1`.

There is no automatic provider fallback or ambiguous automatic retry. A lost response
may already have incurred a provider charge. A future explicit retry policy may handle
requests known to have been rejected before processing, such as a documented `429`
with `Retry-After`, but that is outside this release.

Transcript-only behavior remains independent of Digest configuration and credentials.

## Generation result and provenance

`Summarizer.generateDigest` returns a normalized result instead of only `DigestDraft`:

```ts
type SummarizationResult = {
  draft: DigestDraft;
  generation: {
    provider: DigestProviderId;
    requestedModel: string;
    responseModel: string | null;
    requestId: string | null;
    usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
    } | null;
  };
};
```

`metadata.v1` persists Generation Provenance and the Video Digest package version for a
completed Digest. Nullable fields account for providers that do not expose the same
metadata. The metadata does not estimate monetary cost because prices change outside
the application's release cycle.

Human and JSON success output identifies the provider and requested model. Transcript-
only and unusable-Transcript metadata has no Generation Provenance.

## Default model policy

Each Provider Profile contains a curated, balanced model default. A default must:

- support the selected protocol and schema-constrained output;
- have enough context for the product's expected long transcripts;
- provide an appropriate quality, latency, and cost balance;
- pass the provider conformance suite before release.

Defaults use explicit provider model IDs or provider-maintained stable aliases. Video
Digest does not automatically select a newly released model or fetch a model catalog on
each run. Updating a default is an intentional release change with tests and release
notes.

A custom model ID is allowed. Doctor validates its syntax and local configuration but
does not make a billable request. Remote incompatibility is reported during an explicit
Ingestion.

## Error contract

The 1.0 public error taxonomy adds or preserves these Digest-provider failures:

| Code | Meaning |
| --- | --- |
| `missing-api-key` | No credential exists for the effective provider. |
| `unsupported-provider` | The provider ID is not in the registry. |
| `invalid-model` | The model ID is invalid or rejected as unavailable/incompatible. |
| `authentication-failed` | The provider rejects the credential. |
| `rate-limited` | The provider rejects the request due to a request/token rate limit. |
| `quota-exceeded` | The account has insufficient quota, credit, or billing capacity. |
| `context-limit-exceeded` | The transcript request exceeds the model context limit. |
| `provider-unavailable` | A network failure or retryable provider outage prevents a response. |
| `provider-failed` | A provider failure does not match a safer specific category. |
| `invalid-provider-response` | The response cannot produce a valid `DigestDraft`. |

Public errors include `provider` and, when safe and known, `model`. Remote bodies,
headers, request payloads, API keys, and reflected secrets are never included. Status
alone is insufficient where providers overload HTTP codes; adapters may use documented
remote error codes internally, then discard the body.

Doctor uses a new generic Digest-provider check in `doctor-report.v1`. It checks only
the effective provider, model configuration, and credential presence. It does not
require all five credentials and does not call a model.

## Security and privacy

- Every dynamic credential is passed as a distinct process argument to Keychain tools.
- Provider HTTP response bodies are treated as untrusted and secret-bearing data.
- Tests cover providers reflecting authorization values in error responses.
- Logs and JSON contracts contain only allowlisted error fields.
- No telemetry, automatic model discovery, or background provider request is added.
- Network activity remains tied to explicit Video processing or a developer explicitly
  running the live provider verification script.
- Artifact content and provider output remain untrusted data under the agent skill's
  existing boundary.

## Testing strategy

### Normal automated suite

Normal tests make no real provider calls. They cover:

- every Provider Profile and registry invariant;
- table-driven provider, model, and credential precedence;
- provider-isolated Keychain behavior;
- exact request headers and payloads for all three protocol adapters;
- structured-output schema translation;
- cancellation forwarding;
- normalized response and provenance extraction;
- all error categories and secret redaction;
- CLI parsing, human output, JSON contracts, and TUI transitions;
- `config.v1`, `metadata.v1`, and atomic artifact behavior;
- Transcript-only operation without provider configuration;
- typechecking, package verification, and packed CLI smoke tests.

A shared adapter conformance suite requires every supported provider to produce the
same `SummarizationResult` contract from provider-specific response fixtures derived
from official API documentation.

### Live verification

All five providers are officially supported. Support means a maintained profile,
documented configuration, conformance tests, structured-output handling, normalized
errors, and a commitment to fix incompatibilities.

OpenCode Zen is the reference provider with end-to-end release verification. The
available OpenCode key can exercise the Responses, Messages, and Chat Completions
protocol families through Zen without revealing the key to the agent.

Direct-provider live checks are optional and not run in normal CI because they require
third-party credentials and may incur charges. They use a small synthetic input and
produce a redacted report covering authentication, structured output, validation, and
provenance. Direct profiles are conformance-tested against their official API contracts
even when a direct-provider live credential is unavailable.

Implementation adds a developer-only `verify:provider-live` script. It requires an
explicit provider argument, reads only that provider's standard environment variable,
prints an estimated request scope before execution, and refuses to run without explicit
confirmation. It never writes a Digest artifact or prints response bodies. This script
is not an end-user command and is not part of normal tests.

The user runs the OpenCode verification privately. The agent neither reads the API key
nor observes credential entry. A release report records only provider, model, pass/fail,
timestamp, and Video Digest version.

Primary product documentation states:

> Supported providers: OpenCode Zen, OpenAI, Anthropic, Google Gemini, and xAI.

Technical compatibility documentation explains the verification methodology without
labeling direct providers experimental or implying vendor certification.

## Breaking release and local migration

The feature targets 1.0.0. The implementation commit or release PR must contain a
Conventional Commit breaking marker such as `feat(providers)!` and a `BREAKING CHANGE:`
footer so Release Please proposes the major release. The npm release runbook must be
read before changing release automation, bumping versions, or publishing.

There is no automatic `config.v0` or Keychain migration. The local migration is:

1. record the current Artifact Library path without recording any secret;
2. install or run the 1.0.0 candidate;
3. create `config.v1` with the prior Artifact Library and `opencode` as provider;
4. have the user run `video-digest config set api-key --provider opencode` privately;
5. run Doctor;
6. run one real OpenCode Digest and inspect its Generation Provenance.

The agent must not retrieve, copy, print, or migrate the previous Keychain secret.

## Documentation changes

Implementation updates:

- `CONTEXT.md` with the new domain terms;
- README setup, configuration, privacy, troubleshooting, and supported providers;
- `.env.example` with provider-neutral selection and standard credential variables;
- CLI compatibility, JSON contract, and exit-code references;
- the packaged Video Digest agent skill and machine contracts;
- release notes describing the 1.0.0 migration.

## Acceptance criteria

- A user can persist or temporarily select any of the five providers and a model.
- Each provider uses only its own environment or Keychain credential.
- OpenAI, xAI, and OpenCode reuse the Responses adapter without provider-specific logic
  leaking into Ingestion.
- Anthropic uses native Messages structured output.
- Gemini uses its documented OpenAI-compatible Chat Completions structured output.
- Every successful Digest is locally validated before any artifact replacement.
- Completed Digest metadata records non-secret Generation Provenance.
- Human and JSON failures distinguish configuration, authentication, capacity,
  availability, context, and invalid-response failures.
- Transcript-only behavior requires no Digest Provider.
- No secret appears in config, logs, JSON, artifacts, tests, or thrown public errors.
- All normal automated quality gates pass without network credentials.
- OpenCode Zen passes the end-to-end release check before 1.0.0 is published.
- Release Please proposes 1.0.0 from an explicit breaking Conventional Commit.
