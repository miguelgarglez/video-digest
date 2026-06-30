import {
  DEFAULT_DIGEST_PROVIDER,
  getProviderProfile,
  isDigestProviderId,
  type DigestProviderId,
} from "../summarizer/providers";
import type { AppConfig } from "./config-store";

export type ResolutionSource = "flag" | "env" | "config" | "default";

export type ResolvedDigestSelection = Readonly<{
  model: { effective: string; source: ResolutionSource };
  provider: { effective: DigestProviderId; source: ResolutionSource };
}>;

export class DigestConfigurationError extends Error {
  constructor(
    public readonly code: "unsupported-provider" | "invalid-model",
    message: string,
  ) {
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
  const cliProvider = nonEmpty(input.cliProvider);
  const envProvider = nonEmpty(input.env.VIDEO_DIGEST_PROVIDER);
  const rawProvider = cliProvider
    ?? envProvider
    ?? input.config?.digest.defaultProvider
    ?? DEFAULT_DIGEST_PROVIDER;

  if (!isDigestProviderId(rawProvider)) {
    throw new DigestConfigurationError(
      "unsupported-provider",
      `Unsupported Digest Provider: ${rawProvider}`,
    );
  }

  const providerSource: ResolutionSource = cliProvider
    ? "flag"
    : envProvider
      ? "env"
      : input.config
        ? "config"
        : "default";

  if (input.cliModel !== undefined && input.cliModel.trim().length === 0) {
    throw new DigestConfigurationError("invalid-model", "Digest model cannot be empty.");
  }

  const cliModel = nonEmpty(input.cliModel);
  const envModel = nonEmpty(input.env.VIDEO_DIGEST_MODEL);
  const configuredModel = nonEmpty(input.config?.digest.models[rawProvider]);
  const rawModel = cliModel
    ?? envModel
    ?? configuredModel
    ?? getProviderProfile(rawProvider).defaultModel;

  const modelSource: ResolutionSource = cliModel
    ? "flag"
    : envModel
      ? "env"
      : configuredModel
        ? "config"
        : "default";

  return {
    model: { effective: rawModel, source: modelSource },
    provider: { effective: rawProvider, source: providerSource },
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
