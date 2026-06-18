import { describe, expect, test } from "bun:test";
import { resolvePackageResources } from "./package-resources";

describe("resolvePackageResources", () => {
  for (const moduleUrl of [
    "file:///opt/video-digest/src/cli/package-resources.ts",
    "file:///opt/video-digest/dist/cli/package-resources.js",
  ]) {
    test(`resolves packaged resources from ${new URL(moduleUrl).pathname}`, () => {
      expect(resolvePackageResources(new URL(moduleUrl))).toEqual({
        packageJson: "/opt/video-digest/package.json",
        pythonDir: "/opt/video-digest/python",
        sidecarScript: "/opt/video-digest/python/fetch_transcript.py",
        uvLock: "/opt/video-digest/python/uv.lock",
      });
    });
  }
});
