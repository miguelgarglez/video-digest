import { describe, expect, test } from "bun:test";
import { resolvePackageResources } from "./package-resources";

describe("resolvePackageResources", () => {
  test("resolves packaged resources from the module URL independently of cwd", () => {
    expect(resolvePackageResources(new URL("file:///opt/video-digest/dist/cli/package-resources.js"))).toEqual({
      packageJson: "/opt/video-digest/package.json",
      pythonDir: "/opt/video-digest/python",
      sidecarScript: "/opt/video-digest/python/fetch_transcript.py",
      uvLock: "/opt/video-digest/python/uv.lock",
    });
  });
});
