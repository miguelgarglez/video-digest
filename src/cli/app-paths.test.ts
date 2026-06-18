import { describe, expect, test } from "bun:test";
import { resolveAppPaths } from "./app-paths";

describe("resolveAppPaths", () => {
  test("resolves the exact macOS application paths beneath the supplied home", () => {
    expect(resolveAppPaths("/Users/example")).toEqual({
      configPath: "/Users/example/Library/Application Support/video-digest/config.json",
      defaultArtifactLibrary: "/Users/example/Documents/Video Digest",
      runtimeDir: "/Users/example/Library/Application Support/video-digest/runtime/python",
    });
  });
});
