import { describe, expect, test } from "bun:test";
import { AnthropicMessagesSummarizer } from "./anthropic-messages-summarizer";
import { ChatCompletionsSummarizer } from "./chat-completions-summarizer";
import { createProviderSummarizer } from "./provider-summarizer";
import { ResponsesSummarizer } from "./responses-summarizer";
import type { DigestProviderId } from "./providers";

describe("createProviderSummarizer", () => {
  test.each([
    ["opencode", ResponsesSummarizer],
    ["openai", ResponsesSummarizer],
    ["xai", ResponsesSummarizer],
    ["gemini", ChatCompletionsSummarizer],
    ["anthropic", AnthropicMessagesSummarizer],
  ] as Array<[DigestProviderId, new (...args: never[]) => unknown]>)
  ("dispatches %s to its protocol adapter", (provider, Adapter) => {
    expect(createProviderSummarizer(selection(provider), "key")).toBeInstanceOf(Adapter);
  });
});

function selection(provider: DigestProviderId) {
  return {
    model: { effective: `model-for-${provider}`, source: "config" as const },
    provider: { effective: provider, source: "config" as const },
  };
}
