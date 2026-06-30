import type { ProviderProfile } from "./providers";
import { SummarizerError } from "./summarizer";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function classifyProviderFailure(
  response: Response,
  profile: ProviderProfile,
  model: string,
): SummarizerError {
  const code = response.status === 401 || response.status === 403
    ? "authentication-failed"
    : response.status === 402
      ? "quota-exceeded"
      : response.status === 404
        ? "invalid-model"
        : response.status === 413
          ? "context-limit-exceeded"
          : response.status === 429
            ? "rate-limited"
            : response.status >= 500
              ? "provider-unavailable"
              : "provider-failed";

  const message = code === "authentication-failed"
    ? `${profile.displayName} authentication failed.`
    : code === "quota-exceeded"
      ? `${profile.displayName} quota is exhausted.`
      : code === "invalid-model"
        ? `${profile.displayName} rejected model ${model}.`
        : code === "context-limit-exceeded"
          ? `${profile.displayName} context limit was exceeded.`
          : code === "rate-limited"
            ? `${profile.displayName} rate limit was exceeded.`
            : code === "provider-unavailable"
              ? `${profile.displayName} is unavailable.`
              : `${profile.displayName} request failed with HTTP ${response.status}.`;

  return new SummarizerError(code, message, profile.id, model);
}

export function unavailableError(profile: ProviderProfile, model: string): SummarizerError {
  return new SummarizerError(
    "provider-unavailable",
    `${profile.displayName} is unavailable.`,
    profile.id,
    model,
  );
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
