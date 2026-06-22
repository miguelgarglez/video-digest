import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("package metadata", () => {
  test("declares the public package contract", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      name?: string;
      description?: string;
      license?: string;
      author?: string;
      keywords?: string[];
      private?: boolean;
      os?: string[];
      cpu?: string[];
      files?: string[];
      bin?: Record<string, string>;
      version?: string;
      repository?: { type?: string; url?: string };
      bugs?: { url?: string };
      homepage?: string;
      engines?: Record<string, string>;
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const binPath = packageJson.bin?.["video-digest"];

    expect(packageJson).toMatchObject({
      name: "video-digest",
      version: "0.1.0",
      description: "Turn YouTube videos into local transcripts and structured digests.",
      license: "MIT",
      os: ["darwin"],
      cpu: ["arm64"],
      bin: { "video-digest": "./bin/video-digest" },
      repository: {
        type: "git",
        url: "git+https://github.com/miguelgarglez/personal-video-digest.git",
      },
      bugs: {
        url: "https://github.com/miguelgarglez/personal-video-digest/issues",
      },
      homepage: "https://github.com/miguelgarglez/personal-video-digest#readme",
      engines: { bun: ">=1.3.14" },
    });
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.author).toBe("Miguel García González");
    expect(packageJson.keywords).toEqual([
      "youtube",
      "transcript",
      "digest",
      "cli",
      "tui",
      "bun",
    ]);
    const publicFiles = [
      "bin",
      "src",
      "python/fetch_transcript.py",
      "python/pyproject.toml",
      "python/uv.lock",
      ".agents/skills/video-digest",
      "docs/cli",
      "README.md",
      "LICENSE",
    ];
    expect(packageJson.files).toEqual(publicFiles);
    await Promise.all(publicFiles.map((path) => access(join(process.cwd(), path))));
    expect(packageJson.dependencies).toEqual({ "@opentui/core": "0.4.1" });
    for (const lifecycle of [
      "preinstall",
      "install",
      "postinstall",
      "prepublish",
      "prepublishOnly",
      "prepare",
      "publish",
      "postpublish",
    ]) {
      expect(packageJson.scripts?.[lifecycle]).toBeUndefined();
    }
    expect(JSON.stringify(packageJson)).not.toMatch(/(?:_auth|authToken|npmToken)/i);

    expect(binPath).toBe("./bin/video-digest");
    await access(join(process.cwd(), binPath!));
  });
});
