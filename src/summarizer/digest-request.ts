import type { DigestDraft, DigestVerdict, RelevantTimestamp } from "../digest/digest";
import type { TranscriptSegment } from "../transcript/transcript-source";
import type { SummarizerInput } from "./summarizer";

export function buildDigestSystemPrompt(): string {
  return [
    "You generate structured personal knowledge digests from YouTube transcripts.",
    "Return a digest that follows the provided JSON schema exactly.",
    "Use concise Spanish unless the transcript clearly requires another language.",
  ].join("\n");
}

export function buildDigestUserPrompt(input: SummarizerInput): string {
  return JSON.stringify({
    transcript: input.transcript.segments.map(formatSegment),
    transcriptQuality: input.transcriptQuality,
    video: input.video,
  });
}

export function digestJsonSchema() {
  return {
    additionalProperties: false,
    properties: {
      actionableIdeas: { items: { type: "string" }, type: "array" },
      conceptsToInvestigate: { items: { type: "string" }, type: "array" },
      connections: { items: { type: "string" }, type: "array" },
      digestTitle: { type: "string" },
      keyIdeas: { items: { type: "string" }, type: "array" },
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
      tldr: { items: { type: "string" }, type: "array" },
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
  } as const;
}

export function parseDigestDraft(text: string): DigestDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Provider output was not valid JSON");
  }

  if (!isDigestDraft(parsed)) {
    throw new Error("Provider output did not match digest.v0 draft");
  }
  return parsed;
}

function formatSegment(segment: TranscriptSegment): string {
  return `${formatTimestamp(segment.start)} ${segment.text}`;
}

function formatTimestamp(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  const prefix = hours > 0 ? `${hours.toString().padStart(2, "0")}:` : "";
  return `${prefix}${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function isDigestDraft(value: unknown): value is DigestDraft {
  if (!isRecord(value)) return false;
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
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) && typeof item.note === "string" && typeof item.timestamp === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isVerdict(value: unknown): value is DigestVerdict {
  return value === "watch_full" || value === "watch_fragments" ||
    value === "save_reference" || value === "discard";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
