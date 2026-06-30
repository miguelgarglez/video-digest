# Multi-provider BYOK Digest Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Video Digest 1.0 with officially supported BYOK generation through OpenCode Zen, OpenAI, Anthropic, Google Gemini, and xAI.

**Architecture:** Keep `Summarizer` as the Ingestion port, add a provider registry and configuration resolver, and route requests through three protocol adapters: Responses, Chat Completions, and Anthropic Messages. Normalize every provider response into one `SummarizationResult`, validate it locally, and persist non-secret Generation Provenance in `metadata.v1`.

**Tech Stack:** TypeScript 6, Bun 1.3, native `fetch`, macOS Keychain through `security`, OpenTUI, Bun test runner, Release Please.

---

## Scope and implementation order

This is one cohesive vertical feature. Configuration, credentials, protocol adapters,
Ingestion, CLI, and TUI all depend on the same `DigestProviderId` and
`SummarizationResult`; splitting them into independent plans would create incompatible
intermediate contracts.

No task installs a package. Provider SDKs are deliberately excluded.

## File structure

### New production files

- `src/summarizer/providers.ts` — provider IDs, immutable profiles, defaults, and lookup.
- `src/summarizer/digest-request.ts` — shared prompts and Digest JSON Schema.
- `src/summarizer/http.ts` — fetch type, safe response metadata, and error classification.
- `src/summarizer/responses-summarizer.ts` — OpenAI Responses protocol adapter.
- `src/summarizer/chat-completions-summarizer.ts` — OpenAI-compatible Chat Completions adapter.
- `src/summarizer/anthropic-messages-summarizer.ts` — native Anthropic Messages adapter.
- `src/summarizer/provider-summarizer.ts` — profile-to-adapter factory.
- `src/cli/digest-config.ts` — provider/model precedence and resolved selection.
- `scripts/verify-provider-live.ts` — explicit, developer-only, redacted live conformance check.
- `docs/cli/providers.md` — supported providers and verification methodology.

### New test files

- `src/summarizer/providers.test.ts`
- `src/summarizer/digest-request.test.ts`
- `src/summarizer/responses-summarizer.test.ts`
- `src/summarizer/chat-completions-summarizer.test.ts`
- `src/summarizer/anthropic-messages-summarizer.test.ts`
- `src/summarizer/provider-summarizer.test.ts`
- `src/cli/digest-config.test.ts`

### Deleted files

- `src/summarizer/opencode-summarizer.ts`
- `src/summarizer/opencode-summarizer.test.ts`

### Existing files with substantial changes

- `CONTEXT.md`
- `.env.example`
- `README.md`
- `package.json`
- `src/summarizer/summarizer.ts`
- `src/cli/config-store.ts` and tests
- `src/cli/credentials.ts` and tests
- `src/cli/public-contract.ts`
- `src/cli/parse-args.ts` and tests
- `src/cli/doctor.ts` and tests
- `src/cli/main.ts` and tests
- `src/web/server.ts`
- `src/ingestion/ingest-video.ts` and tests
- `src/output/output-writer.ts` and tests
- `src/cli/artifacts.ts` and Library tests
- `src/tui/model.ts`, `ports.ts`, `update.ts`, `screens.ts`, `controller.ts`,
  `default-ports.ts`, and their tests
- `docs/cli/compatibility.md`, `docs/cli/exit-codes.md`, and
  `docs/cli/json-contracts.md`
- `.agents/skills/video-digest/SKILL.md` and `references/contracts.md`
- `scripts/verify-package.ts` and `scripts/verify-package.test.ts`
- `scripts/smoke-packed-cli.ts` and `scripts/smoke-packed-cli.test.ts`

## Defaults fixed for the implementation

Use these curated defaults so the plan is executable without another product decision:

| Provider | Endpoint | Default model |
| --- | --- | --- |
| OpenCode Zen | `https://opencode.ai/zen/v1/responses` | `gpt-5.4-mini` |
| OpenAI | `https://api.openai.com/v1/responses` | `gpt-5.4-mini` |
| Anthropic | `https://api.anthropic.com/v1/messages` | `claude-sonnet-4-6` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `gemini-3.5-flash` |
| xAI | `https://api.x.ai/v1/responses` | `grok-4.3` |

Re-check these IDs against the already cited official provider pages immediately before
implementation. If an ID has been retired, replace only that profile default and record
the evidence in the task commit; do not redesign the registry.

### Task 1: Define Digest Provider profiles and domain language

**Files:**
- Create: `src/summarizer/providers.ts`
- Create: `src/summarizer/providers.test.ts`
- Modify: `CONTEXT.md`

- [ ] **Step 1: Write the failing provider registry tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  DIGEST_PROVIDER_IDS,
  getProviderProfile,
  isDigestProviderId,
} from "./providers";

describe("Digest Provider registry", () => {
  test("contains the five supported providers in stable order", () => {
    expect(DIGEST_PROVIDER_IDS).toEqual([
      "opencode", "openai", "anthropic", "gemini", "xai",
    ]);
  });

  test("maps every provider to its protocol and credential variable", () => {
    expect(getProviderProfile("opencode")).toMatchObject({
      credentialEnv: "OPENCODE_API_KEY",
      protocol: "responses",
    });
    expect(getProviderProfile("openai")).toMatchObject({
      credentialEnv: "OPENAI_API_KEY",
      protocol: "responses",
    });
    expect(getProviderProfile("anthropic")).toMatchObject({
      credentialEnv: "ANTHROPIC_API_KEY",
      protocol: "anthropic-messages",
    });
    expect(getProviderProfile("gemini")).toMatchObject({
      credentialEnv: "GEMINI_API_KEY",
      protocol: "chat-completions",
    });
    expect(getProviderProfile("xai")).toMatchObject({
      credentialEnv: "XAI_API_KEY",
      protocol: "responses",
    });
  });

  test("rejects unknown provider IDs", () => {
    expect(isDigestProviderId("openrouter")).toBe(false);
    expect(() => getProviderProfile("openrouter")).toThrow("Unsupported Digest Provider");
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `bun test src/summarizer/providers.test.ts`

Expected: FAIL because `./providers` does not exist.

- [ ] **Step 3: Implement the immutable registry**

```ts
export const DIGEST_PROVIDER_IDS = [
  "opencode", "openai", "anthropic", "gemini", "xai",
] as const;

export type DigestProviderId = typeof DIGEST_PROVIDER_IDS[number];
export type ProviderProtocol = "responses" | "chat-completions" | "anthropic-messages";

export type ProviderProfile = Readonly<{
  credentialEnv: string;
  defaultModel: string;
  displayName: string;
  endpoint: string;
  id: DigestProviderId;
  protocol: ProviderProtocol;
}>;

export const DEFAULT_DIGEST_PROVIDER: DigestProviderId = "opencode";

const profiles = {
  opencode: { credentialEnv: "OPENCODE_API_KEY", defaultModel: "gpt-5.4-mini", displayName: "OpenCode Zen", endpoint: "https://opencode.ai/zen/v1/responses", id: "opencode", protocol: "responses" },
  openai: { credentialEnv: "OPENAI_API_KEY", defaultModel: "gpt-5.4-mini", displayName: "OpenAI", endpoint: "https://api.openai.com/v1/responses", id: "openai", protocol: "responses" },
  anthropic: { credentialEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-4-6", displayName: "Anthropic", endpoint: "https://api.anthropic.com/v1/messages", id: "anthropic", protocol: "anthropic-messages" },
  gemini: { credentialEnv: "GEMINI_API_KEY", defaultModel: "gemini-3.5-flash", displayName: "Google Gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", id: "gemini", protocol: "chat-completions" },
  xai: { credentialEnv: "XAI_API_KEY", defaultModel: "grok-4.3", displayName: "xAI", endpoint: "https://api.x.ai/v1/responses", id: "xai", protocol: "responses" },
} as const satisfies Record<DigestProviderId, ProviderProfile>;

export function isDigestProviderId(value: string): value is DigestProviderId {
  return (DIGEST_PROVIDER_IDS as readonly string[]).includes(value);
}

export function getProviderProfile(value: string): ProviderProfile {
  if (!isDigestProviderId(value)) throw new Error(`Unsupported Digest Provider: ${value}`);
  return profiles[value];
}

export function listProviderProfiles(): readonly ProviderProfile[] {
  return DIGEST_PROVIDER_IDS.map((id) => profiles[id]);
}
```

- [ ] **Step 4: Add the four approved terms to `CONTEXT.md`**

Add a `Digest generation` table defining **Digest Provider**, **Provider Profile**,
**Protocol Adapter**, and **Generation Provenance** exactly as the approved design does.
Add the relationship: “A Digest has one Generation Provenance when a Digest Provider
successfully generated it.”

- [ ] **Step 5: Run the focused test and typecheck**

Run: `bun test src/summarizer/providers.test.ts && bun run typecheck`

Expected: provider tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit the registry**

```bash
git add CONTEXT.md src/summarizer/providers.ts src/summarizer/providers.test.ts
git commit -m "feat(providers): Add Digest Provider registry"
```

### Task 2: Replace configuration with `config.v1` and deterministic resolution

**Files:**
- Create: `src/cli/digest-config.ts`
- Create: `src/cli/digest-config.test.ts`
- Modify: `src/cli/config-store.ts`
- Modify: `src/cli/config-store.test.ts`

- [ ] **Step 1: Write failing `config.v1` storage tests**

Add tests that save/load this exact value and reject `config.v0`:

```ts
const config = {
  artifactLibrary: "/library",
  digest: {
    defaultProvider: "anthropic" as const,
    models: { anthropic: "claude-sonnet-4-6" },
  },
  schemaVersion: "config.v1" as const,
};

expect(await store.load()).toEqual(config);
await expect(loadRaw({ artifactLibrary: "/old", schemaVersion: "config.v0" }))
  .rejects.toThrow("expected schema config.v1");
```

- [ ] **Step 2: Write failing precedence tests**

```ts
import { resolveDigestSelection } from "./digest-config";

test("resolves flags before environment, config, and defaults", () => {
  expect(resolveDigestSelection({
    cliModel: "gpt-cli",
    cliProvider: "openai",
    config: {
      artifactLibrary: "/library",
      digest: { defaultProvider: "anthropic", models: { openai: "gpt-config" } },
      schemaVersion: "config.v1",
    },
    env: { VIDEO_DIGEST_MODEL: "gpt-env", VIDEO_DIGEST_PROVIDER: "xai" },
  })).toEqual({
    model: { effective: "gpt-cli", source: "flag" },
    provider: { effective: "openai", source: "flag" },
  });
});

test("uses a model override only for the effective provider", () => {
  const result = resolveDigestSelection({
    config: {
      artifactLibrary: "/library",
      digest: {
        defaultProvider: "gemini",
        models: { anthropic: "claude-custom", gemini: "gemini-custom" },
      },
      schemaVersion: "config.v1",
    },
    env: {},
  });
  expect(result.model).toEqual({ effective: "gemini-custom", source: "config" });
});
```

- [ ] **Step 3: Run both files and verify red**

Run: `bun test src/cli/config-store.test.ts src/cli/digest-config.test.ts`

Expected: FAIL on `config.v1` and missing `digest-config.ts`.

- [ ] **Step 4: Implement the strict config type and validator**

Use this public shape in `config-store.ts`:

```ts
import type { DigestProviderId } from "../summarizer/providers";

export type AppConfig = {
  artifactLibrary: string;
  digest: {
    defaultProvider: DigestProviderId;
    models: Partial<Record<DigestProviderId, string>>;
  };
  schemaVersion: "config.v1";
};
```

Validate exact top-level and `digest` keys, validate `defaultProvider` with
`isDigestProviderId`, require every model value to be a non-empty string, and reject
unknown model-map keys. Continue writing parent/file modes `0700`/`0600`.

- [ ] **Step 5: Implement `resolveDigestSelection`**

```ts
import type { AppConfig } from "./config-store";
import {
  DEFAULT_DIGEST_PROVIDER,
  getProviderProfile,
  isDigestProviderId,
  type DigestProviderId,
} from "../summarizer/providers";

export type ResolutionSource = "flag" | "env" | "config" | "default";
export type ResolvedDigestSelection = Readonly<{
  model: { effective: string; source: ResolutionSource };
  provider: { effective: DigestProviderId; source: ResolutionSource };
}>;

export class DigestConfigurationError extends Error {
  constructor(public readonly code: "unsupported-provider" | "invalid-model", message: string) {
    super(message);
    this.name = "DigestConfigurationError";
  }
}

export function resolveDigestSelection(input: {
  cliModel?: string;
  cliProvider?: string;
  config: AppConfig | null;
  env: Record<string, string | undefined>;
}): ResolvedDigestSelection {
  const rawProvider = input.cliProvider?.trim()
    || input.env.VIDEO_DIGEST_PROVIDER?.trim()
    || input.config?.digest.defaultProvider
    || DEFAULT_DIGEST_PROVIDER;
  if (!isDigestProviderId(rawProvider)) {
    throw new DigestConfigurationError("unsupported-provider", `Unsupported Digest Provider: ${rawProvider}`);
  }
  const providerSource: ResolutionSource = input.cliProvider?.trim() ? "flag"
    : input.env.VIDEO_DIGEST_PROVIDER?.trim() ? "env"
    : input.config ? "config" : "default";
  const configuredModel = input.config?.digest.models[rawProvider]?.trim();
  const rawModel = input.cliModel?.trim()
    || input.env.VIDEO_DIGEST_MODEL?.trim()
    || configuredModel
    || getProviderProfile(rawProvider).defaultModel;
  if (!rawModel) throw new DigestConfigurationError("invalid-model", "Digest model cannot be empty.");
  const modelSource: ResolutionSource = input.cliModel?.trim() ? "flag"
    : input.env.VIDEO_DIGEST_MODEL?.trim() ? "env"
    : configuredModel ? "config" : "default";
  return {
    model: { effective: rawModel, source: modelSource },
    provider: { effective: rawProvider, source: providerSource },
  };
}
```

- [ ] **Step 6: Run tests and commit**

Run: `bun test src/cli/config-store.test.ts src/cli/digest-config.test.ts && bun run typecheck`

Expected: PASS, exit 0.

```bash
git add src/cli/config-store.ts src/cli/config-store.test.ts src/cli/digest-config.ts src/cli/digest-config.test.ts
git commit -m "feat(config): Resolve provider and model"
```

### Task 3: Generalize Keychain credentials by provider

**Files:**
- Modify: `src/cli/credentials.ts`
- Modify: `src/cli/credentials.test.ts`

- [ ] **Step 1: Replace OpenCode-only tests with provider-table tests**

```ts
test.each([
  ["opencode", "OPENCODE_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["gemini", "GEMINI_API_KEY"],
  ["xai", "XAI_API_KEY"],
] as const)("resolves %s from %s before Keychain", async (provider, envName) => {
  const result = await resolveProviderApiKey({
    env: { [envName]: "env-key" },
    provider,
    store: fakeStore({ stored: "stored-key" }),
  });
  expect(result).toEqual({ source: "env", value: "env-key" });
});

test("uses a provider-isolated Keychain account", async () => {
  await store.setApiKey("anthropic", "secret");
  expect(calls[0]).toEqual([
    "add-generic-password", "-a", "provider:anthropic:api-key",
    "-s", "video-digest", "-w", "secret", "-U",
  ]);
});
```

- [ ] **Step 2: Run the test and verify the old API fails**

Run: `bun test src/cli/credentials.test.ts`

Expected: FAIL because `resolveProviderApiKey` and generic store methods do not exist.

- [ ] **Step 3: Replace the credential API**

```ts
export type CredentialStore = {
  deleteApiKey(provider: DigestProviderId): Promise<void>;
  getApiKey(provider: DigestProviderId): Promise<string | null>;
  setApiKey(provider: DigestProviderId, value: string): Promise<void>;
};

export type CredentialSource =
  | { source: "env" | "keychain"; value: string }
  | { source: "missing"; value: null };

const accountFor = (provider: DigestProviderId) => `provider:${provider}:api-key`;

export async function resolveProviderApiKey(input: {
  env: Record<string, string | undefined>;
  provider: DigestProviderId;
  store: CredentialStore;
}): Promise<CredentialSource> {
  const profile = getProviderProfile(input.provider);
  const envValue = input.env[profile.credentialEnv]?.trim();
  if (envValue) return { source: "env", value: envValue };
  const storedValue = await input.store.getApiKey(input.provider);
  return storedValue
    ? { source: "keychain", value: storedValue }
    : { source: "missing", value: null };
}
```

Implement `getApiKey`, `setApiKey`, and `deleteApiKey` with the existing safe
`Bun.spawn(["security", ...args])` mechanism. Never place `result.stderr` in an error
that could contain a dynamic secret; use fixed provider-neutral messages.

- [ ] **Step 4: Run focused security tests and commit**

Run: `bun test src/cli/credentials.test.ts && bun run typecheck`

Expected: PASS, including account isolation and secret-redaction assertions.

```bash
git add src/cli/credentials.ts src/cli/credentials.test.ts
git commit -m "feat(credentials): Isolate provider API keys"
```

### Task 4: Extract the common Digest request and normalized result

**Files:**
- Create: `src/summarizer/digest-request.ts`
- Create: `src/summarizer/digest-request.test.ts`
- Modify: `src/summarizer/summarizer.ts`
- Modify: `src/summarizer/opencode-summarizer.ts`
- Modify: `src/summarizer/opencode-summarizer.test.ts`

- [ ] **Step 1: Write failing shared-request tests**

Move the current prompt/schema expectations into `digest-request.test.ts` and assert:

```ts
expect(buildDigestSystemPrompt()).toContain("structured personal knowledge digests");
expect(buildDigestUserPrompt(input)).toContain("00:00");
expect(digestJsonSchema()).toMatchObject({
  additionalProperties: false,
  required: [
    "digestTitle", "tldr", "keyIdeas", "relevantTimestamps",
    "actionableIdeas", "conceptsToInvestigate", "connections", "verdict",
  ],
  type: "object",
});
expect(parseDigestDraft(JSON.stringify(validDraft))).toEqual(validDraft);
expect(() => parseDigestDraft("{}"))
  .toThrow("Provider output did not match digest.v0 draft");
```

- [ ] **Step 2: Run the test and verify missing exports**

Run: `bun test src/summarizer/digest-request.test.ts`

Expected: FAIL because the shared module does not exist.

- [ ] **Step 3: Define the normalized result and expanded errors**

Replace the relevant declarations in `summarizer.ts` with:

```ts
export type GenerationUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

export type GenerationProvenance = Readonly<{
  provider: DigestProviderId;
  requestedModel: string;
  responseModel: string | null;
  requestId: string | null;
  usage: GenerationUsage | null;
}>;

export type SummarizationResult = Readonly<{
  draft: DigestDraft;
  generation: GenerationProvenance;
}>;

export type Summarizer = {
  generateDigest(input: SummarizerInput): Promise<SummarizationResult>;
};

export type SummarizerErrorCode =
  | "missing-api-key" | "invalid-model" | "authentication-failed"
  | "rate-limited" | "quota-exceeded" | "context-limit-exceeded"
  | "provider-unavailable" | "provider-failed" | "invalid-provider-response";

export class SummarizerError extends Error {
  constructor(
    public readonly code: SummarizerErrorCode,
    message: string,
    public readonly provider: DigestProviderId,
    public readonly model: string | null,
  ) {
    super(message);
    this.name = "SummarizerError";
  }
}
```

- [ ] **Step 4: Extract prompts, schema, parser, and validator unchanged in meaning**

Export `buildDigestSystemPrompt`, `buildDigestUserPrompt`, `digestJsonSchema`, and
`parseDigestDraft` from `digest-request.ts`. Move the existing implementations from
`opencode-summarizer.ts`; keep timestamps, Spanish output instruction, strict required
fields, verdict enum, and local runtime validation identical.

- [ ] **Step 5: Make the old adapter compile temporarily**

Wrap the existing parsed draft in `opencode-summarizer.ts` so it satisfies the new port
until Task 5 deletes the adapter:

```ts
const draft = parseDigestDraft(await response.json());
return {
  draft,
  generation: {
    provider: "opencode",
    requestedModel: this.model,
    requestId: null,
    responseModel: null,
    usage: null,
  },
};
```

This temporary edit is deleted in Task 5; it keeps the branch type-safe between commits.

- [ ] **Step 6: Run tests and commit**

Update the test to assert `result.draft` and `result.generation`. Then run:

`bun test src/summarizer/digest-request.test.ts src/summarizer/opencode-summarizer.test.ts && bun run typecheck`

Expected: PASS, exit 0.

```bash
git add src/summarizer/digest-request.ts src/summarizer/digest-request.test.ts src/summarizer/summarizer.ts src/summarizer/opencode-summarizer.ts src/summarizer/opencode-summarizer.test.ts
git commit -m "refactor(summarizer): Normalize generation results"
```

### Task 5: Implement the Responses adapter for OpenCode, OpenAI, and xAI

**Files:**
- Create: `src/summarizer/http.ts`
- Create: `src/summarizer/responses-summarizer.ts`
- Create: `src/summarizer/responses-summarizer.test.ts`
- Delete: `src/summarizer/opencode-summarizer.ts`
- Delete: `src/summarizer/opencode-summarizer.test.ts`

- [ ] **Step 1: Write table-driven failing adapter tests**

For each of `opencode`, `openai`, and `xai`, construct the adapter with fake `fetch` and
assert the exact URL, Bearer header, model, `input`, and `text.format`:

```ts
expect(JSON.parse(request.init.body as string)).toMatchObject({
  input: [
    { role: "system" },
    { role: "user" },
  ],
  model: profile.defaultModel,
  text: {
    format: {
      name: "digest_draft",
      strict: true,
      type: "json_schema",
    },
  },
});
expect(request.init.headers).toMatchObject({
  Authorization: "Bearer test-key",
  "Content-Type": "application/json",
});
```

Also test `output_text`, nested `output[].content[].text`, response model/request ID,
token usage, AbortSignal forwarding, reflected-secret redaction, and every error mapping.

- [ ] **Step 2: Run the new test and verify red**

Run: `bun test src/summarizer/responses-summarizer.test.ts`

Expected: FAIL because `ResponsesSummarizer` does not exist.

- [ ] **Step 3: Implement safe HTTP classification**

In `http.ts`, export `FetchLike`, `classifyProviderFailure`, and allowlisted response
metadata extraction. Map documented status/code combinations to the new error taxonomy.
Use fixed messages such as `${displayName} authentication failed.` and never append the
remote response body. Map network exceptions other than AbortError to
`provider-unavailable`; rethrow cancellation unchanged.

- [ ] **Step 4: Implement `ResponsesSummarizer`**

```ts
export class ResponsesSummarizer implements Summarizer {
  constructor(private readonly options: {
    apiKey: string;
    fetch?: FetchLike;
    model: string;
    profile: ProviderProfile;
  }) {}

  async generateDigest(input: SummarizerInput): Promise<SummarizationResult> {
    const { apiKey, model, profile } = this.options;
    if (!apiKey) throw new SummarizerError("missing-api-key", `${profile.displayName} API key is missing.`, profile.id, model);
    const response = await (this.options.fetch ?? fetch)(profile.endpoint, {
      body: JSON.stringify({
        input: [
          { content: buildDigestSystemPrompt(), role: "system" },
          { content: buildDigestUserPrompt(input), role: "user" },
        ],
        model,
        text: { format: { name: "digest_draft", schema: digestJsonSchema(), strict: true, type: "json_schema" } },
      }),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      method: "POST",
      signal: input.signal,
    });
    if (!response.ok) throw await classifyProviderFailure(response, profile, model);
    const payload = await response.json();
    return normalizeResponsesPayload(payload, profile.id, model);
  }
}
```

`normalizeResponsesPayload` must call `parseDigestDraft` and only read allowlisted
`id`, `model`, and usage counters.

- [ ] **Step 5: Delete the OpenCode-only adapter and run tests**

Run: `bun test src/summarizer/responses-summarizer.test.ts src/summarizer/digest-request.test.ts && bun run typecheck`

Expected: PASS after updating imports that directly referenced the deleted class; no
`OpenCodeSummarizer` symbol remains.

- [ ] **Step 6: Commit**

```bash
git add src/summarizer
git commit -m "feat(summarizer): Add Responses adapter"
```

### Task 6: Implement Gemini Chat Completions

**Files:**
- Create: `src/summarizer/chat-completions-summarizer.ts`
- Create: `src/summarizer/chat-completions-summarizer.test.ts`

- [ ] **Step 1: Write failing Gemini protocol tests**

Assert the request uses `messages`, Bearer authentication, and Chat Completions schema:

```ts
expect(body).toMatchObject({
  messages: [
    { role: "system", content: expect.any(String) },
    { role: "user", content: expect.any(String) },
  ],
  model: "gemini-3.5-flash",
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "digest_draft",
      strict: true,
      schema: digestJsonSchema(),
    },
  },
});
```

Test extraction from `choices[0].message.content`, `usage.prompt_tokens`,
`usage.completion_tokens`, `usage.total_tokens`, response model, and request ID.

- [ ] **Step 2: Run and verify red**

Run: `bun test src/summarizer/chat-completions-summarizer.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement `ChatCompletionsSummarizer`**

Use the same constructor contract as `ResponsesSummarizer`. Require
`profile.protocol === "chat-completions"`, send the payload above, reuse
`classifyProviderFailure`, parse only the first non-empty assistant content string, and
return the normalized provenance. Missing/array content that cannot yield text becomes
`invalid-provider-response`.

- [ ] **Step 4: Run tests and commit**

Run: `bun test src/summarizer/chat-completions-summarizer.test.ts && bun run typecheck`

Expected: PASS, exit 0.

```bash
git add src/summarizer/chat-completions-summarizer.ts src/summarizer/chat-completions-summarizer.test.ts
git commit -m "feat(summarizer): Add Chat Completions adapter"
```

### Task 7: Implement native Anthropic Messages and the provider factory

**Files:**
- Create: `src/summarizer/anthropic-messages-summarizer.ts`
- Create: `src/summarizer/anthropic-messages-summarizer.test.ts`
- Create: `src/summarizer/provider-summarizer.ts`
- Create: `src/summarizer/provider-summarizer.test.ts`

- [ ] **Step 1: Write failing Anthropic request tests**

```ts
expect(request.url).toBe("https://api.anthropic.com/v1/messages");
expect(request.init.headers).toEqual({
  "anthropic-version": "2023-06-01",
  "Content-Type": "application/json",
  "x-api-key": "test-key",
});
expect(body).toMatchObject({
  max_tokens: 4096,
  messages: [{ role: "user", content: expect.any(String) }],
  model: "claude-sonnet-4-6",
  output_config: {
    format: { type: "json_schema", schema: digestJsonSchema() },
  },
  system: expect.any(String),
});
```

Test extraction from the first `{type:"text", text}` block, `id`, `model`,
`usage.input_tokens`, and `usage.output_tokens`. Assert `totalTokens` is their sum only
when both are numeric.

- [ ] **Step 2: Write failing factory dispatch tests**

```ts
expect(createProviderSummarizer(selection("openai"), "key")).toBeInstanceOf(ResponsesSummarizer);
expect(createProviderSummarizer(selection("xai"), "key")).toBeInstanceOf(ResponsesSummarizer);
expect(createProviderSummarizer(selection("gemini"), "key")).toBeInstanceOf(ChatCompletionsSummarizer);
expect(createProviderSummarizer(selection("anthropic"), "key")).toBeInstanceOf(AnthropicMessagesSummarizer);
```

- [ ] **Step 3: Run both files and verify red**

Run: `bun test src/summarizer/anthropic-messages-summarizer.test.ts src/summarizer/provider-summarizer.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement Anthropic Messages**

Implement the exact request above, reuse safe HTTP classification, and normalize the
response. Do not use Anthropic's OpenAI compatibility endpoint. Do not send
`response_format`; use `output_config.format`.

- [ ] **Step 5: Implement the exhaustive factory**

```ts
export function createProviderSummarizer(
  selection: ResolvedDigestSelection,
  apiKey: string,
  fetch?: FetchLike,
): Summarizer {
  const profile = getProviderProfile(selection.provider.effective);
  const options = { apiKey, fetch, model: selection.model.effective, profile };
  switch (profile.protocol) {
    case "responses": return new ResponsesSummarizer(options);
    case "chat-completions": return new ChatCompletionsSummarizer(options);
    case "anthropic-messages": return new AnthropicMessagesSummarizer(options);
  }
}
```

- [ ] **Step 6: Run the complete summarizer suite and commit**

Run: `bun test src/summarizer && bun run typecheck`

Expected: all summarizer tests PASS.

```bash
git add src/summarizer
git commit -m "feat(summarizer): Add Anthropic Messages"
```

### Task 8: Persist Generation Provenance in `metadata.v1`

**Files:**
- Modify: `src/ingestion/ingest-video.ts`
- Modify: `src/ingestion/ingest-video.test.ts`
- Modify: `src/ingestion/ingestion-service.ts`
- Modify: `src/ingestion/ingestion-service.test.ts`
- Modify: `src/output/output-writer.ts`
- Modify: `src/output/output-writer.test.ts`
- Modify: `src/cli/artifacts.ts`
- Modify: `src/cli/library.test.ts`

- [ ] **Step 1: Write a failing Ingestion provenance test**

Make the fake Summarizer return `{draft, generation}` and assert completed Ingestion
returns the same provenance and passes it to output writing:

```ts
expect(result).toMatchObject({
  generation: {
    provider: "anthropic",
    requestedModel: "claude-sonnet-4-6",
  },
  status: "completed",
});
```

- [ ] **Step 2: Write failing `metadata.v1` tests**

```ts
expect(metadata).toMatchObject({
  generation: {
    provider: "anthropic",
    requestId: "msg_123",
    requestedModel: "claude-sonnet-4-6",
    responseModel: "claude-sonnet-4-6",
    usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
  },
  metadataSchemaVersion: "metadata.v1",
  videoDigestVersion: expect.any(String),
});
```

Also assert Transcript-only and unusable-Transcript metadata use `metadata.v1` with
`generation: null`.

- [ ] **Step 3: Run focused tests and verify red**

Run: `bun test src/ingestion/ingest-video.test.ts src/output/output-writer.test.ts src/cli/library.test.ts`

Expected: FAIL because generation is discarded and metadata remains v0.

- [ ] **Step 4: Thread provenance through Ingestion and output writing**

Change:

```ts
const { draft, generation } = await input.summarizer.generateDigest(...);
const digest = createDigest(draft);
```

Add `generation: GenerationProvenance` to `IngestionOutputInput` and completed
`IngestVideoResult`. Add `videoDigestVersion` from package metadata at the composition
root and pass it into the writer rather than reading package files inside domain code.

- [ ] **Step 5: Write and parse `metadata.v1`**

Make every metadata builder emit:

```ts
{
  digest: completed ? input.digest : null,
  generation: completed ? input.generation : null,
  metadataSchemaVersion: "metadata.v1",
  processedAt: new Date().toISOString(),
  transcriptQuality: input.transcriptQuality,
  video: buildVideoMetadata(...),
  videoDigestVersion: input.videoDigestVersion,
}
```

Update `parseMetadata` in `artifacts.ts` to require `metadata.v1`, safely validate the
new fields, and continue deriving Library Entry title/channel/status. Do not expose
request IDs in normal Library listings.

- [ ] **Step 6: Run output, Ingestion, and Library tests**

Run: `bun test src/ingestion src/output/output-writer.test.ts src/cli/library.test.ts && bun run typecheck`

Expected: PASS with no `metadata.v0` references outside historical docs/specs.

- [ ] **Step 7: Commit**

```bash
git add src/ingestion src/output/output-writer.ts src/output/output-writer.test.ts src/cli/artifacts.ts src/cli/library.test.ts
git commit -m "feat(metadata): Record generation provenance"
```

### Task 9: Replace the public CLI configuration, Doctor, and JSON contracts

**Files:**
- Modify: `src/cli/public-contract.ts`
- Modify: `src/cli/public-contract.test.ts`
- Modify: `src/cli/parse-args.ts`
- Modify: `src/cli/parse-args.test.ts`
- Modify: `src/cli/doctor.ts`
- Modify: `src/cli/doctor.test.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/main.test.ts`
- Modify: `src/cli/documented-contracts.test.ts`
- Modify: `src/web/server.ts`

- [ ] **Step 1: Write failing parser tests for every new command shape**

```ts
expect(parseCliArgs(["ingest", URL, "--provider", "openai", "--model", "gpt-custom"]))
  .toMatchObject({ ok: true, value: { command: "ingest", model: "gpt-custom", provider: "openai" } });
expect(parseCliArgs(["config", "set", "provider", "anthropic"]))
  .toEqual({ ok: true, value: { command: "config", json: false, key: "provider", subcommand: "set", value: "anthropic" } });
expect(parseCliArgs(["config", "set", "model", "claude-custom", "--provider", "anthropic"]))
  .toMatchObject({ ok: true, value: { key: "model", provider: "anthropic", value: "claude-custom" } });
expect(parseCliArgs(["config", "set", "api-key", "--provider", "anthropic"]))
  .toMatchObject({ ok: true, value: { key: "api-key", provider: "anthropic" } });
expect(parseCliArgs(["config", "set", "opencode-api-key"]).ok).toBe(false);
```

Test missing values, duplicate flags, unsupported providers, `--model` without Ingest,
and secret-looking positional values after `api-key`.

- [ ] **Step 2: Write failing CLI behavior and JSON tests**

Cover:

- flag/env/config/default selection precedence;
- selected-provider-only credential resolution;
- interactive set/unset key and `interactive-required` in JSON mode;
- `config-status.v1` exact shape;
- successful `cli-result.v1` generation block;
- provider/model on allowlisted error output;
- missing key offering Transcript-only;
- no provider fallback;
- old config/credential command rejection.

Use injected factories and fake stores; no network or real Keychain.

- [ ] **Step 3: Write failing Doctor tests**

Expect one `digest-provider` check containing effective provider/model and only that
provider's credential status. A missing key fails Digest capability but leaves
Transcript checks unchanged. Doctor must not call a Summarizer.

- [ ] **Step 4: Run the CLI slice and verify red**

Run: `bun test src/cli/parse-args.test.ts src/cli/main.test.ts src/cli/doctor.test.ts`

Expected: FAIL on old options, old contracts, and OpenCode-only resolution.

- [ ] **Step 5: Implement parser and public contract v1**

Set:

```ts
export const PUBLIC_CLI_SCHEMA = {
  cliResult: "cli-result.v1",
  configResult: "config-result.v1",
  configStatus: "config-status.v1",
  doctorReport: "doctor-report.v1",
  libraryList: "library-list.v0",
  openResult: "open-result.v0",
  setupResult: "setup-result.v0",
} as const;
```

Add the approved provider error codes and replace `opencode-api-key` Doctor ID with
`digest-provider`. Parse `--provider` and `--model` as value options before filtering
positionals, just as `--output-dir` is handled.

- [ ] **Step 6: Recompose `runCli` around the resolved selection**

Before Ingestion:

```ts
const selection = resolveDigestSelection({
  cliModel: result.value.model,
  cliProvider: result.value.provider,
  config,
  env,
});
const credential = await resolveProviderApiKey({
  env,
  provider: selection.provider.effective,
  store: credentialStore,
});
const summarizer = createProviderSummarizer(selection, credential.value ?? "");
```

Make dependency injection accept `(selection, apiKey) => Summarizer`. Rewrite config
set/get to preserve the entire `config.v1` value on every update. Prompt and errors use
the selected profile display name. Never accept a key as an argv value.

When a config mutation starts without a saved file, use the effective Artifact Library,
the `opencode` default, and an empty model map to construct the first complete
`config.v1`; never write a partial config.

- [ ] **Step 7: Implement provider-neutral Doctor**

Pass `ResolvedDigestSelection`, environment, and credential store into Doctor. Report
credential presence/source and configured model without model calls. Keep runtime and
Artifact Library checks unchanged.

Update `src/web/server.ts` to resolve provider/model from `VIDEO_DIGEST_PROVIDER` and
`VIDEO_DIGEST_MODEL`, resolve the selected standard credential from environment, and
create the same provider Summarizer. The web composition root must fail at startup with
a fixed missing-credential message rather than importing the deleted OpenCode class.

- [ ] **Step 8: Run CLI tests and verify the breaking contract**

Run: `bun test src/cli && bun run typecheck`

Expected: all CLI tests PASS and documented contract fixtures use v1.

- [ ] **Step 9: Commit the intentional breaking interface**

```bash
git add src/cli
git commit -m "feat(cli)!: Add provider-neutral BYOK" -m "Replace OpenCode-only configuration and machine contracts with provider and model selection." -m "BREAKING CHANGE: config.v0, opencode-api-key commands, metadata.v0, and affected v0 JSON contracts are removed."
```

This is the commit that makes Release Please propose 1.0.0. Do not edit
`package.json` or the Release Please manifest manually.

### Task 10: Add provider and model settings to the TUI

**Files:**
- Modify: `src/tui/model.ts`
- Modify: `src/tui/ports.ts`
- Modify: `src/tui/update.ts`
- Modify: `src/tui/screens.ts`
- Modify: `src/tui/controller.ts`
- Modify: `src/tui/default-ports.ts`
- Modify: all corresponding `src/tui/*.test.ts` files

- [ ] **Step 1: Write failing model/update tests**

Extend initial state expectations to:

```ts
expect(model.config).toMatchObject({
  digest: { model: "gpt-5.4-mini", provider: "opencode" },
});
expect(model.credentials).toEqual({
  anthropic: false, gemini: false, opencode: true, openai: false, xai: false,
});
```

Add transitions for `open-provider-settings`, `select-provider`, `provider-saved`,
`open-model-settings`, `save-model`, and provider-aware credential save. Assert Digest
creation gates on `credentials[config.digest.provider]`.

- [ ] **Step 2: Write failing screen tests**

Assert Settings shows effective provider/model, provider choices use profile display
names, model input starts with the selected provider's effective model, and credential
copy names the selected provider rather than OpenCode.

- [ ] **Step 3: Write failing default-port/controller tests**

Assert saving provider/model persists `config.v1`, credential effects pass the selected
provider to `setApiKey`, and Ingestion creates the factory with the same resolved
selection shown in the TUI.

- [ ] **Step 4: Run the TUI suite and verify red**

Run: `bun test src/tui`

Expected: FAIL because the model and ports remain OpenCode-specific.

- [ ] **Step 5: Extend the TUI state machine**

Add screens `provider-settings` and `model-settings`; pending kinds `save-provider` and
`save-model`; provider-aware credential effects; and config ports:

```ts
config: {
  saveArtifactLibrary(path: string): Promise<string>;
  saveModel(provider: DigestProviderId, model: string): Promise<void>;
  saveProvider(provider: DigestProviderId): Promise<void>;
};
credential: {
  deleteApiKey(provider: DigestProviderId): Promise<void>;
  saveApiKey(provider: DigestProviderId, value: string): Promise<void>;
};
```

Keep each `update` transition pure. Effects own persistence; success events update the
model only after persistence succeeds.

- [ ] **Step 6: Recompose default TUI ports**

Maintain an in-session `AppConfig`, resolve provider/model through
`resolveDigestSelection`, and update it atomically after successful saves. Resolve only
the effective provider credential before Ingestion and instantiate through
`createProviderSummarizer`.

- [ ] **Step 7: Run all TUI tests and commit**

Run: `bun test src/tui && bun run typecheck`

Expected: all TUI tests PASS, including cancellation and secret-editor hardening.

```bash
git add src/tui
git commit -m "feat(tui): Configure Digest Providers"
```

### Task 11: Update public docs, agent contracts, package verification, and live harness

**Files:**
- Create: `docs/cli/providers.md`
- Create: `scripts/verify-provider-live.ts`
- Create: `scripts/verify-provider-live.test.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `docs/cli/compatibility.md`
- Modify: `docs/cli/exit-codes.md`
- Modify: `docs/cli/json-contracts.md`
- Modify: `.agents/skills/video-digest/SKILL.md`
- Modify: `.agents/skills/video-digest/references/contracts.md`
- Modify: `src/cli/agent-skill.test.ts`
- Modify: `scripts/verify-package.ts`
- Modify: `scripts/verify-package.test.ts`
- Modify: `scripts/smoke-packed-cli.ts`
- Modify: `scripts/smoke-packed-cli.test.ts`

- [ ] **Step 1: Write failing documentation/package contract tests**

Extend documented-contract tests to require all five provider IDs, v1 schemas, new
commands, new error codes, no `config set opencode-api-key`, and packaged inclusion of
all new production adapters and `docs/cli/providers.md`.

- [ ] **Step 2: Write failing live-harness safety tests**

Test argument parsing and safety without network:

```ts
expect(parseLiveArgs(["--provider", "openai"])).toEqual({
  ok: false,
  message: "Live verification requires --yes after reviewing its request scope.",
});
expect(parseLiveArgs(["--provider", "openai", "--yes"])).toEqual({
  ok: true,
  provider: "openai",
  zenProtocol: null,
});
expect(redactLiveReport({ provider: "openai", model: "gpt", requestId: "secret-id" }))
  .not.toHaveProperty("requestId");
```

- [ ] **Step 3: Run contract tests and verify red**

Run: `bun test src/cli/documented-contracts.test.ts src/cli/agent-skill.test.ts scripts/verify-package.test.ts scripts/verify-provider-live.test.ts`

Expected: FAIL on stale OpenCode-only docs and missing harness.

- [ ] **Step 4: Implement the developer-only live harness**

Add package script:

```json
"verify:provider-live": "bun --silent run scripts/verify-provider-live.ts"
```

The script accepts `--provider <id> --yes` and the optional
`--zen-protocol <responses|anthropic-messages|chat-completions>` only when provider is
`opencode`. It prints provider, endpoint, model, and that one small synthetic request
will be sent; reads only the selected profile's standard environment variable; invokes
the corresponding adapter; and prints only:

```json
{
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "status": "passed",
  "timestamp": "ISO-8601",
  "videoDigestVersion": "0.2.0"
}
```

Read `videoDigestVersion` from `package.json`; `0.2.0` is the expected branch value
before Release Please creates the 1.0.0 release commit. On failure print
error code/provider/model only. Never print body, headers, content, request ID, or usage.

The Zen protocol targets use the documented endpoint/model pairs:

```ts
const zenTargets = {
  responses: { endpoint: "https://opencode.ai/zen/v1/responses", model: "gpt-5.4-mini" },
  "anthropic-messages": { endpoint: "https://opencode.ai/zen/v1/messages", model: "claude-haiku-4-5" },
  "chat-completions": { endpoint: "https://opencode.ai/zen/v1/chat/completions", model: "deepseek-v4-flash" },
} as const;
```

Each transient target still reports provider `opencode`; it exists only to exercise the
three protocol adapters with the user's private Zen key.

- [ ] **Step 5: Rewrite docs and skill contracts**

State prominently:

> Supported providers: OpenCode Zen, OpenAI, Anthropic, Google Gemini, and xAI.

Explain provider/model precedence, Keychain commands, standard environment variables,
no fallback, provenance, breaking migration, and conformance methodology. Update the
agent skill so credential commands remain user-only and require a provider argument.
Agents may inspect presence/source but never values.

Replace `.env.example` with this provider-neutral template:

```dotenv
VIDEO_DIGEST_PROVIDER=opencode
VIDEO_DIGEST_MODEL=
OPENCODE_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
XAI_API_KEY=
VIDEO_DIGEST_OUTPUT_DIR="/absolute/path/to/Video Digest"
```

- [ ] **Step 6: Update package verification and run focused tests**

Run: `bun test src/cli/documented-contracts.test.ts src/cli/agent-skill.test.ts scripts/verify-package.test.ts scripts/verify-provider-live.test.ts && bun run verify:package`

Expected: PASS and packed file manifest includes every runtime adapter.

- [ ] **Step 7: Commit**

```bash
git add .env.example README.md package.json docs/cli .agents/skills/video-digest scripts src/cli/agent-skill.test.ts src/cli/documented-contracts.test.ts
git commit -m "docs(providers): Document BYOK support"
```

### Task 12: Perform migration rehearsal and release-readiness verification

**Files:**
- Modify only if verification exposes a defect; otherwise no source changes
- Read: `docs/runbooks/npm-release.md`

- [ ] **Step 1: Confirm the old interfaces are absent**

Run:

```bash
if rg -n "config\.v0|metadata\.v0|opencode-api-key|OpenCodeSummarizer" src README.md docs/cli .agents/skills/video-digest scripts; then
  echo "legacy public interface remains"
  exit 1
fi
```

Expected: no matches. Historical specs and `CHANGELOG.md` are intentionally excluded.

- [ ] **Step 2: Run the complete local quality suite**

Run exactly as required by the release runbook:

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun run verify:package
bun run smoke:package
```

Expected: every command exits 0. `bun install --frozen-lockfile` uses the existing lock
file and installs no new dependency; if the environment lacks current dependencies,
ask the user before running it because project instructions require confirmation before
any installation.

- [ ] **Step 3: Inspect secret-safety and public contracts**

Run:

```bash
rg -n "API key|apiKey|Authorization|x-api-key" src/cli src/summarizer src/output src/tui
bun test src/cli/credentials.test.ts src/summarizer src/tui/controller-hardening.test.ts
```

Expected: every secret-bearing location is an allowlisted private boundary and all
redaction/hardening tests PASS.

- [ ] **Step 4: Rehearse local `config.v1` migration without reading secrets**

Record only the current Artifact Library path. Move the old non-secret config aside,
run the candidate, and create `config.v1` with provider `opencode`. Ask the user to run:

```bash
video-digest config set api-key --provider opencode
video-digest doctor
```

The agent must not execute credential mutation, observe entry, retrieve the legacy
Keychain item, or accept the key in chat.

- [ ] **Step 5: Run the OpenCode live check with explicit user control**

Ask the user to place `OPENCODE_API_KEY` in their private terminal environment and run:

```bash
bun run verify:provider-live -- --provider opencode --yes
bun run verify:provider-live -- --provider opencode --zen-protocol anthropic-messages --yes
bun run verify:provider-live -- --provider opencode --zen-protocol chat-completions --yes
```

Expected: three redacted `status: "passed"` reports. Do not ask the user to paste the
key or the remote responses.

- [ ] **Step 6: Verify Release Please will see a major change**

Run:

```bash
git log main..HEAD --format='%s%n%b' | rg -n "feat\(cli\)!|BREAKING CHANGE:"
```

Expected: both the breaking subject marker and footer are present. Do not change
`package.json`, `.release-please-manifest.json`, tags, or npm state; Release Please owns
the version bump after merge.

- [ ] **Step 7: Commit only verification fixes, if any**

If verification required source changes, rerun the full failing gate and then commit
the smallest coherent fix using the appropriate `fix(scope): ...` message. If no files
changed, do not create an empty commit.

## Final review checklist

- [ ] Every approved provider has a maintained profile and exact credential boundary.
- [ ] All three protocol adapters pass the shared conformance expectations.
- [ ] Provider/model resolution is identical in CLI and TUI.
- [ ] No code path falls back to a different provider.
- [ ] Every completed Digest records `metadata.v1` Generation Provenance.
- [ ] Transcript-only processing remains credential-free.
- [ ] Public JSON schemas and Doctor IDs are versioned consistently.
- [ ] The packaged skill documents provider-aware private credential commands.
- [ ] Normal tests perform no provider network request.
- [ ] The user, not the agent, controls live credentials and billable verification.
- [ ] The breaking commit is present and Release Please remains the version owner.
