import { describe, expect, test } from "bun:test";
import {
  MacOSKeychainCredentialStore,
  resolveProviderApiKey,
  type CredentialStore,
} from "./credentials";
import type { DigestProviderId } from "../summarizer/providers";

function fakeStore(stored: string | null): CredentialStore {
  return {
    deleteApiKey: async () => {},
    getApiKey: async () => stored,
    setApiKey: async () => {},
  };
}

describe("MacOSKeychainCredentialStore", () => {
  test("reads a provider-isolated key from macOS Keychain", async () => {
    const commands: string[][] = [];
    const store = new MacOSKeychainCredentialStore({
      runSecurity: async (args) => {
        commands.push(args);
        return { exitCode: 0, stderr: "", stdout: "test-key\n" };
      },
    });

    await expect(store.getApiKey("anthropic")).resolves.toBe("test-key");
    expect(commands).toEqual([[
      "find-generic-password",
      "-a",
      "provider:anthropic:api-key",
      "-s",
      "video-digest",
      "-w",
    ]]);
  });

  test("stores a provider-isolated key in macOS Keychain", async () => {
    const commands: string[][] = [];
    const store = new MacOSKeychainCredentialStore({
      runSecurity: async (args) => {
        commands.push(args);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    await store.setApiKey("anthropic", "test-key");

    expect(commands).toEqual([[
      "add-generic-password",
      "-a",
      "provider:anthropic:api-key",
      "-s",
      "video-digest",
      "-w",
      "test-key",
      "-U",
    ]]);
  });

  test("deletes only the selected provider key", async () => {
    const commands: string[][] = [];
    const store = new MacOSKeychainCredentialStore({
      runSecurity: async (args) => {
        commands.push(args);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    await store.deleteApiKey("xai");

    expect(commands).toEqual([[
      "delete-generic-password",
      "-a",
      "provider:xai:api-key",
      "-s",
      "video-digest",
    ]]);
  });

  test("returns null when the provider key is absent", async () => {
    const store = new MacOSKeychainCredentialStore({
      runSecurity: async () => ({
        exitCode: 44,
        stderr: "The specified item could not be found.",
        stdout: "",
      }),
    });

    await expect(store.getApiKey("gemini")).resolves.toBeNull();
  });

  test("never reflects command stderr when credential mutation fails", async () => {
    const store = new MacOSKeychainCredentialStore({
      runSecurity: async () => ({
        exitCode: 1,
        stderr: "remote diagnostic echoed test-key",
        stdout: "",
      }),
    });

    await expect(store.setApiKey("openai", "test-key"))
      .rejects.toThrow("Could not store provider API key in Keychain");
    await expect(store.setApiKey("openai", "test-key"))
      .rejects.not.toThrow("test-key");
  });
});

describe("resolveProviderApiKey", () => {
  test.each([
    ["opencode", "OPENCODE_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["gemini", "GEMINI_API_KEY"],
    ["xai", "XAI_API_KEY"],
  ] as const)("resolves %s from %s before Keychain", async (provider, envName) => {
    const result = await resolveProviderApiKey({
      env: { [envName]: "env-key" },
      provider,
      store: fakeStore("stored-key"),
    });

    expect(result).toEqual({ source: "env", value: "env-key" });
  });

  test("falls back to the selected provider Keychain entry", async () => {
    const seen: DigestProviderId[] = [];
    const store: CredentialStore = {
      deleteApiKey: async () => {},
      getApiKey: async (provider) => {
        seen.push(provider);
        return "stored-key";
      },
      setApiKey: async () => {},
    };

    await expect(resolveProviderApiKey({ env: {}, provider: "xai", store }))
      .resolves.toEqual({ source: "keychain", value: "stored-key" });
    expect(seen).toEqual(["xai"]);
  });

  test("reports a missing selected provider credential", async () => {
    await expect(resolveProviderApiKey({ env: {}, provider: "gemini", store: fakeStore(null) }))
      .resolves.toEqual({ source: "missing", value: null });
  });
});
