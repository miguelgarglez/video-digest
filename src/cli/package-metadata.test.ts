import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";

const execFileAsync = promisify(execFile);

interface PackManifest {
  files: Array<{ path: string }>;
}

async function listFiles(root: string, relativeDirectory = ""): Promise<string[]> {
  const directory = join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = join(relativeDirectory, entry.name);
      return entry.isDirectory() ? listFiles(root, relativePath) : [relativePath];
    }),
  );
  return nested.flat();
}

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
      "!src/**/*.test.*",
      "!src/**/*.spec.*",
      "!src/**/__snapshot__/**",
      "!src/**/__snapshots__/**",
      "!src/**/snapshot/**",
      "!src/**/snapshots/**",
      "!src/**/__fixture__/**",
      "!src/**/__fixtures__/**",
      "!src/**/fixture/**",
      "!src/**/fixtures/**",
      "!src/**/*.snap",
      "python/fetch_transcript.py",
      "python/pyproject.toml",
      "python/uv.lock",
      ".agents/skills/video-digest",
      "docs/cli",
      "README.md",
      "LICENSE",
    ];
    expect(packageJson.files).toEqual(publicFiles);
    await Promise.all(
      publicFiles
        .filter((path) => !path.startsWith("!"))
        .map((path) => access(join(process.cwd(), path))),
    );
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

  test("packs every runtime source and no test fixture", async () => {
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    const [manifest] = JSON.parse(stdout) as PackManifest[];
    expect(manifest).toBeDefined();
    if (!manifest) throw new Error("npm pack returned no package manifest");
    const packedPaths = manifest.files.map(({ path }) => path);
    const packedSet = new Set(packedPaths);
    const sourcePaths = await readdir(join(process.cwd(), "src"), { recursive: true });
    const runtimeSources = sourcePaths
      .filter(
        (path) =>
          path.endsWith(".ts") &&
          !/\.(?:test|spec)\.[^/]+$/.test(path) &&
          !/(?:^|\/)(?:__)?(?:snapshots?|fixtures?)(?:__)?(?:\/|$)/i.test(path),
      )
      .map((path) => `src/${path}`);

    expect(packedPaths.filter((path) => /\.(?:test|spec)\.[^/]+$/.test(path))).toEqual([]);
    expect(
      packedPaths.filter(
        (path) =>
          /(?:^|\/)(?:__)?(?:snapshots?|fixtures?)(?:__)?(?:\/|$)/i.test(path) ||
          /\.snap(?:\.|$)/i.test(path),
      ),
    ).toEqual([]);
    for (const runtimeSource of runtimeSources) {
      expect(packedSet.has(runtimeSource)).toBe(true);
    }
    const skillResources = (await listFiles(join(process.cwd(), ".agents/skills/video-digest"))).map(
      (path) => `.agents/skills/video-digest/${path}`,
    );
    const documentationResources = (await listFiles(join(process.cwd(), "docs/cli"))).map(
      (path) => `docs/cli/${path}`,
    );
    for (const resource of [
      "package.json",
      "bin/video-digest",
      "python/fetch_transcript.py",
      "python/pyproject.toml",
      "python/uv.lock",
      "README.md",
      "LICENSE",
      ...skillResources,
      ...documentationResources,
    ]) {
      expect(packedSet.has(resource)).toBe(true);
    }
  });
});
