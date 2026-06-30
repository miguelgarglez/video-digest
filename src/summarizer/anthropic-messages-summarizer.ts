import {
  buildDigestSystemPrompt,
  buildDigestUserPrompt,
  digestJsonSchema,
  parseDigestDraft,
} from "./digest-request";
import {
  classifyProviderFailure,
  isAbortError,
  unavailableError,
  type FetchLike,
} from "./http";
import type { ProviderProfile } from "./providers";
import {
  SummarizerError,
  type GenerationUsage,
  type SummarizationResult,
  type Summarizer,
  type SummarizerInput,
} from "./summarizer";

export class AnthropicMessagesSummarizer implements Summarizer {
  constructor(private readonly options: {
    apiKey: string;
    fetch?: FetchLike;
    model: string;
    profile: ProviderProfile;
  }) {
    if (options.profile.protocol !== "anthropic-messages") {
      throw new Error(`${options.profile.id} does not use Anthropic Messages.`);
    }
  }

  async generateDigest(input: SummarizerInput): Promise<SummarizationResult> {
    const { apiKey, model, profile } = this.options;
    if (!apiKey) {
      throw new SummarizerError("missing-api-key", `${profile.displayName} API key is missing.`, profile.id, model);
    }

    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(profile.endpoint, {
        body: JSON.stringify({
          max_tokens: 4096,
          messages: [{ content: buildDigestUserPrompt(input), role: "user" }],
          model,
          output_config: { format: { schema: digestJsonSchema(), type: "json_schema" } },
          system: buildDigestSystemPrompt(),
        }),
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
        },
        method: "POST",
        signal: input.signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw unavailableError(profile, model);
    }
    if (!response.ok) throw classifyProviderFailure(response, profile, model);

    try {
      const payload: unknown = await response.json();
      if (!isRecord(payload)) throw new Error("invalid payload");
      const text = extractText(payload.content);
      if (!text) throw new Error("missing text");
      return {
        draft: parseDigestDraft(text),
        generation: {
          provider: profile.id,
          requestId: stringOrNull(payload.id),
          requestedModel: model,
          responseModel: stringOrNull(payload.model),
          usage: normalizeUsage(payload.usage),
        },
      };
    } catch (error) {
      if (error instanceof SummarizerError) throw error;
      throw new SummarizerError("invalid-provider-response", `${profile.displayName} returned an invalid response.`, profile.id, model);
    }
  }
}

function extractText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const block of value) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      return block.text;
    }
  }
  return null;
}

function normalizeUsage(value: unknown): GenerationUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = numberOrNull(value.input_tokens);
  const outputTokens = numberOrNull(value.output_tokens);
  if (inputTokens === null && outputTokens === null) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
