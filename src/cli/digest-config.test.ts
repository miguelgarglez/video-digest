import { describe, expect, test } from "bun:test";
import {
  DigestConfigurationError,
  resolveDigestSelection,
} from "./digest-config";

describe("resolveDigestSelection", () => {
  test("resolves flags before environment, config, and defaults", () => {
    expect(resolveDigestSelection({
      cliModel: "gpt-cli",
      cliProvider: "openai",
      config: {
        artifactLibrary: "/library",
        digest: {
          defaultProvider: "anthropic",
          models: { openai: "gpt-config" },
        },
        schemaVersion: "config.v1",
      },
      env: {
        VIDEO_DIGEST_MODEL: "gpt-env",
        VIDEO_DIGEST_PROVIDER: "xai",
      },
    })).toEqual({
      model: { effective: "gpt-cli", source: "flag" },
      provider: { effective: "openai", source: "flag" },
    });
  });

  test("uses environment before config", () => {
    expect(resolveDigestSelection({
      config: {
        artifactLibrary: "/library",
        digest: { defaultProvider: "anthropic", models: { xai: "grok-config" } },
        schemaVersion: "config.v1",
      },
      env: { VIDEO_DIGEST_MODEL: "grok-env", VIDEO_DIGEST_PROVIDER: "xai" },
    })).toEqual({
      model: { effective: "grok-env", source: "env" },
      provider: { effective: "xai", source: "env" },
    });
  });

  test("uses a model override only for the effective provider", () => {
    const result = resolveDigestSelection({
      config: {
        artifactLibrary: "/library",
        digest: {
          defaultProvider: "gemini",
          models: { anthropic: "claude-custom", gemini: "gemini-custom" },
        },
        schemaVersion: "config.v1",
      },
      env: {},
    });

    expect(result.model).toEqual({ effective: "gemini-custom", source: "config" });
    expect(result.provider).toEqual({ effective: "gemini", source: "config" });
  });

  test("uses product defaults without config or environment", () => {
    expect(resolveDigestSelection({ config: null, env: {} })).toEqual({
      model: { effective: "gpt-5.4-mini", source: "default" },
      provider: { effective: "opencode", source: "default" },
    });
  });

  test("rejects unsupported provider values with a stable code", () => {
    expect(() => resolveDigestSelection({
      config: null,
      env: { VIDEO_DIGEST_PROVIDER: "openrouter" },
    })).toThrow(DigestConfigurationError);

    try {
      resolveDigestSelection({ config: null, env: { VIDEO_DIGEST_PROVIDER: "openrouter" } });
    } catch (error) {
      expect(error).toMatchObject({ code: "unsupported-provider" });
    }
  });

  test("rejects an explicitly empty model", () => {
    expect(() => resolveDigestSelection({
      cliModel: " ",
      config: null,
      env: {},
    })).toThrow("Digest model cannot be empty");
  });
});
