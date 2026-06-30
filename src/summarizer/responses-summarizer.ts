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

export type ResponsesSummarizerOptions = {
  apiKey: string;
  fetch?: FetchLike;
  model: string;
  profile: ProviderProfile;
};

export class ResponsesSummarizer implements Summarizer {
  constructor(private readonly options: ResponsesSummarizerOptions) {
    if (options.profile.protocol !== "responses") {
      throw new Error(`${options.profile.id} does not use the Responses protocol.`);
    }
  }

  async generateDigest(input: SummarizerInput): Promise<SummarizationResult> {
    const { apiKey, model, profile } = this.options;
    if (!apiKey) {
      throw new SummarizerError(
        "missing-api-key",
        `${profile.displayName} API key is missing.`,
        profile.id,
        model,
      );
    }

    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(profile.endpoint, {
        body: JSON.stringify({
          input: [
            { content: buildDigestSystemPrompt(), role: "system" },
            { content: buildDigestUserPrompt(input), role: "user" },
          ],
          model,
          text: {
            format: {
              name: "digest_draft",
              schema: digestJsonSchema(),
              strict: true,
              type: "json_schema",
            },
          },
        }),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
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
      return normalizeResponsesPayload(await response.json(), profile, model);
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

function normalizeResponsesPayload(
  payload: unknown,
  profile: ProviderProfile,
  requestedModel: string,
): SummarizationResult {
  if (!isRecord(payload)) throw new Error("invalid payload");
  const text = extractOutputText(payload);
  if (!text) throw new Error("missing output text");

  return {
    draft: parseDigestDraft(text),
    generation: {
      provider: profile.id,
      requestId: stringOrNull(payload.id),
      requestedModel,
      responseModel: stringOrNull(payload.model),
      usage: normalizeUsage(payload.usage),
    },
  };
}

function extractOutputText(payload: Record<string, unknown>): string | null {
  if (typeof payload.output_text === "string" && payload.output_text.length > 0) {
    return payload.output_text;
  }
  if (!Array.isArray(payload.output)) return null;
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string" && content.text.length > 0) {
        return content.text;
      }
    }
  }
  return null;
}

function normalizeUsage(value: unknown): GenerationUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = numberOrNull(value.input_tokens);
  const outputTokens = numberOrNull(value.output_tokens);
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
