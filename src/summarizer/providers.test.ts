import { describe, expect, test } from "bun:test";
import {
  DIGEST_PROVIDER_IDS,
  getProviderProfile,
  isDigestProviderId,
} from "./providers";

describe("Digest Provider registry", () => {
  test("contains the five supported providers in stable order", () => {
    expect(DIGEST_PROVIDER_IDS).toEqual([
      "opencode",
      "openai",
      "anthropic",
      "gemini",
      "xai",
    ]);
  });

  test("maps every provider to its protocol and credential variable", () => {
    expect(getProviderProfile("opencode")).toMatchObject({
      credentialEnv: "OPENCODE_API_KEY",
      protocol: "responses",
    });
    expect(getProviderProfile("openai")).toMatchObject({
      credentialEnv: "OPENAI_API_KEY",
      protocol: "responses",
    });
    expect(getProviderProfile("anthropic")).toMatchObject({
      credentialEnv: "ANTHROPIC_API_KEY",
      protocol: "anthropic-messages",
    });
    expect(getProviderProfile("gemini")).toMatchObject({
      credentialEnv: "GEMINI_API_KEY",
      protocol: "chat-completions",
    });
    expect(getProviderProfile("xai")).toMatchObject({
      credentialEnv: "XAI_API_KEY",
      protocol: "responses",
    });
  });

  test("rejects unknown provider IDs", () => {
    expect(isDigestProviderId("openrouter")).toBe(false);
    expect(() => getProviderProfile("openrouter")).toThrow("Unsupported Digest Provider");
  });
});
