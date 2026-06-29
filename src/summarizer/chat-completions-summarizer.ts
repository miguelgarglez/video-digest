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

export class ChatCompletionsSummarizer implements Summarizer {
  constructor(private readonly options: {
    apiKey: string;
    fetch?: FetchLike;
    model: string;
    profile: ProviderProfile;
  }) {
    if (options.profile.protocol !== "chat-completions") {
      throw new Error(`${options.profile.id} does not use the Chat Completions protocol.`);
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
          messages: [
            { content: buildDigestSystemPrompt(), role: "system" },
            { content: buildDigestUserPrompt(input), role: "user" },
          ],
          model,
          response_format: {
            json_schema: { name: "digest_draft", schema: digestJsonSchema(), strict: true },
            type: "json_schema",
          },
        }),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
      const text = extractAssistantText(payload.choices);
      if (!text) throw new Error("missing assistant content");
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
      throw new SummarizerError(
        "invalid-provider-response",
        `${profile.displayName} returned an invalid response.`,
        profile.id,
        model,
      );
    }
  }
}

function extractAssistantText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const choice of value) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const content = choice.message.content;
    if (typeof content === "string" && content.length > 0) return content;
  }
  return null;
}

function normalizeUsage(value: unknown): GenerationUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = numberOrNull(value.prompt_tokens);
  const outputTokens = numberOrNull(value.completion_tokens);
  const totalTokens = numberOrNull(value.total_tokens);
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
  return { inputTokens, outputTokens, totalTokens };
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
