import type { DigestDraft, DigestVerdict, RelevantTimestamp } from "../digest/digest";
import type { TranscriptSegment } from "../transcript/transcript-source";
import { SummarizerError, type Summarizer, type SummarizerInput } from "./summarizer";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type OpenCodeSummarizerOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  model?: string;
};

const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1/responses";
const DEFAULT_MODEL = "gpt-5.4-nano";

export class OpenCodeSummarizer implements Summarizer {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly model: string;

  constructor(options: OpenCodeSummarizerOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENCODE_API_KEY ?? "";
    this.baseUrl = options.baseUrl ?? process.env.OPENCODE_BASE_URL ?? DEFAULT_BASE_URL;
    this.fetch = options.fetch ?? fetch;
    this.model = options.model ?? process.env.OPENCODE_MODEL ?? DEFAULT_MODEL;
  }

  async generateDigest(input: SummarizerInput): Promise<DigestDraft> {
    if (!this.apiKey) {
      throw new SummarizerError("missing-api-key", "Missing OPENCODE_API_KEY");
    }

    const response = await this.fetch(this.baseUrl, {
      body: JSON.stringify({
        input: [
          {
            content: buildSystemPrompt(),
            role: "system",
          },
          {
            content: buildUserPrompt(input),
            role: "user",
          },
        ],
        model: this.model,
        text: {
          format: digestJsonSchemaFormat(),
        },
      }),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: input.signal,
    });

    if (!response.ok) {
      throw new SummarizerError(
        "provider-failed",
        `OpenCode request failed with status ${response.status}: ${await response.text()}`,
      );
    }

    return parseDigestDraft(await response.json());
  }
}

function buildSystemPrompt(): string {
  return [
    "You generate structured personal knowledge digests from YouTube transcripts.",
    "Return a digest that follows the provided JSON schema exactly.",
    "Use concise Spanish unless the transcript clearly requires another language.",
  ].join("\n");
}

function digestJsonSchemaFormat() {
  return {
    name: "digest_draft",
    schema: {
      additionalProperties: false,
      properties: {
        actionableIdeas: {
          items: { type: "string" },
          type: "array",
        },
        conceptsToInvestigate: {
          items: { type: "string" },
          type: "array",
        },
        connections: {
          items: { type: "string" },
          type: "array",
        },
        digestTitle: { type: "string" },
        keyIdeas: {
          items: { type: "string" },
          type: "array",
        },
        relevantTimestamps: {
          items: {
            additionalProperties: false,
            properties: {
              note: { type: "string" },
              timestamp: { type: "string" },
            },
            required: ["timestamp", "note"],
            type: "object",
          },
          type: "array",
        },
        tldr: {
          items: { type: "string" },
          type: "array",
        },
        verdict: {
          enum: ["watch_full", "watch_fragments", "save_reference", "discard"],
          type: "string",
        },
      },
      required: [
        "digestTitle",
        "tldr",
        "keyIdeas",
        "relevantTimestamps",
        "actionableIdeas",
        "conceptsToInvestigate",
        "connections",
        "verdict",
      ],
      type: "object",
    },
    strict: true,
    type: "json_schema",
  };
}

function buildUserPrompt(input: SummarizerInput): string {
  return JSON.stringify({
    transcript: input.transcript.segments.map(formatSegment),
    transcriptQuality: input.transcriptQuality,
    video: input.video,
  });
}

function formatSegment(segment: TranscriptSegment): string {
  return `${formatTimestamp(segment.start)} ${segment.text}`;
}

function parseDigestDraft(payload: unknown): DigestDraft {
  const text = extractOutputText(payload);

  if (!text) {
    throw new SummarizerError("invalid-provider-response", "OpenCode response did not include output text");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SummarizerError("invalid-provider-response", "OpenCode output was not valid JSON");
  }

  if (!isDigestDraft(parsed)) {
    throw new SummarizerError("invalid-provider-response", "OpenCode output did not match digest.v0 draft");
  }

  return parsed;
}

function extractOutputText(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  const output = payload.output;
  if (!Array.isArray(output)) {
    return null;
  }

  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  return null;
}

function isDigestDraft(value: unknown): value is DigestDraft {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.digestTitle === "string" &&
    isStringArray(value.tldr) &&
    isStringArray(value.keyIdeas) &&
    isRelevantTimestampArray(value.relevantTimestamps) &&
    isStringArray(value.actionableIdeas) &&
    isStringArray(value.conceptsToInvestigate) &&
    isStringArray(value.connections) &&
    isVerdict(value.verdict)
  );
}

function isRelevantTimestampArray(value: unknown): value is RelevantTimestamp[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) && typeof item.note === "string" && typeof item.timestamp === "string",
    )
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isVerdict(value: unknown): value is DigestVerdict {
  return (
    value === "watch_full" ||
    value === "watch_fragments" ||
    value === "save_reference" ||
    value === "discard"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatTimestamp(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainingSeconds = wholeSeconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}
