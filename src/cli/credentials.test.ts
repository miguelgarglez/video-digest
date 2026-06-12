import { describe, expect, test } from "bun:test";
import {
  MacOSKeychainCredentialStore,
  resolveOpenCodeApiKey,
} from "./credentials";

describe("MacOSKeychainCredentialStore", () => {
  test("reads the OpenCode key from macOS Keychain", async () => {
    const commands: string[][] = [];
    const store = new MacOSKeychainCredentialStore({
      runSecurity: async (args) => {
        commands.push(args);
        return {
          exitCode: 0,
          stderr: "",
          stdout: "test-key\n",
        };
      },
    });

    await expect(store.getOpenCodeApiKey()).resolves.toBe("test-key");
    expect(commands).toEqual([
      ["find-generic-password", "-a", "opencode-api-key", "-s", "personal-video-digest", "-w"],
    ]);
  });

  test("stores the OpenCode key in macOS Keychain", async () => {
    const commands: string[][] = [];
    const store = new MacOSKeychainCredentialStore({
      runSecurity: async (args) => {
        commands.push(args);
        return {
          exitCode: 0,
          stderr: "",
          stdout: "",
        };
      },
    });

    await store.setOpenCodeApiKey("test-key");

    expect(commands).toEqual([
      [
        "add-generic-password",
        "-a",
        "opencode-api-key",
        "-s",
        "personal-video-digest",
        "-w",
        "test-key",
        "-U",
      ],
    ]);
  });

  test("deletes the OpenCode key from macOS Keychain", async () => {
    const commands: string[][] = [];
    const store = new MacOSKeychainCredentialStore({
      runSecurity: async (args) => {
        commands.push(args);
        return {
          exitCode: 0,
          stderr: "",
          stdout: "",
        };
      },
    });

    await store.deleteOpenCodeApiKey();

    expect(commands).toEqual([
      ["delete-generic-password", "-a", "opencode-api-key", "-s", "personal-video-digest"],
    ]);
  });

  test("returns null when the OpenCode key is absent", async () => {
    const store = new MacOSKeychainCredentialStore({
      runSecurity: async () => ({
        exitCode: 44,
        stderr: "The specified item could not be found.",
        stdout: "",
      }),
    });

    await expect(store.getOpenCodeApiKey()).resolves.toBeNull();
  });
});

describe("resolveOpenCodeApiKey", () => {
  test("prefers the environment variable over stored credentials", async () => {
    const result = await resolveOpenCodeApiKey({
      env: {
        OPENCODE_API_KEY: "env-key",
      },
      store: {
        deleteOpenCodeApiKey: async () => {},
        getOpenCodeApiKey: async () => "stored-key",
        setOpenCodeApiKey: async () => {},
      },
    });

    expect(result).toEqual({
      source: "env",
      value: "env-key",
    });
  });

  test("falls back to stored credentials", async () => {
    const result = await resolveOpenCodeApiKey({
      env: {},
      store: {
        deleteOpenCodeApiKey: async () => {},
        getOpenCodeApiKey: async () => "stored-key",
        setOpenCodeApiKey: async () => {},
      },
    });

    expect(result).toEqual({
      source: "keychain",
      value: "stored-key",
    });
  });
});
