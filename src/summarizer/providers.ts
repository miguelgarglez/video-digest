export const DIGEST_PROVIDER_IDS = [
  "opencode",
  "openai",
  "anthropic",
  "gemini",
  "xai",
] as const;

export type DigestProviderId = (typeof DIGEST_PROVIDER_IDS)[number];
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
  opencode: {
    credentialEnv: "OPENCODE_API_KEY",
    defaultModel: "gpt-5.4-mini",
    displayName: "OpenCode Zen",
    endpoint: "https://opencode.ai/zen/v1/responses",
    id: "opencode",
    protocol: "responses",
  },
  openai: {
    credentialEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-5.4-mini",
    displayName: "OpenAI",
    endpoint: "https://api.openai.com/v1/responses",
    id: "openai",
    protocol: "responses",
  },
  anthropic: {
    credentialEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-6",
    displayName: "Anthropic",
    endpoint: "https://api.anthropic.com/v1/messages",
    id: "anthropic",
    protocol: "anthropic-messages",
  },
  gemini: {
    credentialEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-3.5-flash",
    displayName: "Google Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    id: "gemini",
    protocol: "chat-completions",
  },
  xai: {
    credentialEnv: "XAI_API_KEY",
    defaultModel: "grok-4.3",
    displayName: "xAI",
    endpoint: "https://api.x.ai/v1/responses",
    id: "xai",
    protocol: "responses",
  },
} as const satisfies Record<DigestProviderId, ProviderProfile>;

export function isDigestProviderId(value: string): value is DigestProviderId {
  return (DIGEST_PROVIDER_IDS as readonly string[]).includes(value);
}

export function getProviderProfile(value: string): ProviderProfile {
  if (!isDigestProviderId(value)) {
    throw new Error(`Unsupported Digest Provider: ${value}`);
  }
  return profiles[value];
}

export function listProviderProfiles(): readonly ProviderProfile[] {
  return DIGEST_PROVIDER_IDS.map((id) => profiles[id]);
}
