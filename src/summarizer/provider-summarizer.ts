import type { ResolvedDigestSelection } from "../cli/digest-config";
import { AnthropicMessagesSummarizer } from "./anthropic-messages-summarizer";
import { ChatCompletionsSummarizer } from "./chat-completions-summarizer";
import type { FetchLike } from "./http";
import { getProviderProfile } from "./providers";
import { ResponsesSummarizer } from "./responses-summarizer";
import type { Summarizer } from "./summarizer";

export function createProviderSummarizer(
  selection: ResolvedDigestSelection,
  apiKey: string,
  fetch?: FetchLike,
): Summarizer {
  const profile = getProviderProfile(selection.provider.effective);
  const options = { apiKey, fetch, model: selection.model.effective, profile };
  switch (profile.protocol) {
    case "responses":
      return new ResponsesSummarizer(options);
    case "chat-completions":
      return new ChatCompletionsSummarizer(options);
    case "anthropic-messages":
      return new AnthropicMessagesSummarizer(options);
  }
}
