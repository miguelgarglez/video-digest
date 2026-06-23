import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/release-please.yml", import.meta.url);
const configPath = new URL("../release-please-config.json", import.meta.url);
const manifestPath = new URL("../.release-please-manifest.json", import.meta.url);
const changelogPath = new URL("../CHANGELOG.md", import.meta.url);
const packageJsonPath = new URL("../package.json", import.meta.url);
const runbookPath = new URL("../docs/runbooks/npm-release.md", import.meta.url);

async function readText(url: URL): Promise<string> {
  return readFile(url, "utf8");
}

function indexOfRequired(source: string, value: string): number {
  const index = source.indexOf(value);
  expect(index, `expected ${JSON.stringify(value)}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("Release Please workflow", () => {
  test("creates release PRs from main with least publish exposure", async () => {
    const workflow = await readText(workflowPath);

    expect(workflow).toContain("name: Release Please");
    expect(workflow).toMatch(/^on:\n  push:\n    branches: \[main\]\n/m);
    expect(workflow).toMatch(
      /^permissions:\n  contents: write\n  pull-requests: write\n\njobs:/m,
    );
    expect(workflow).not.toMatch(/\bnpm\s+publish\b/i);
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|id-token:|secrets\./i);
  });

  test("uses pinned Release Please action with manifest configuration", async () => {
    const workflow = await readText(workflowPath);

    expect(workflow).toContain(
      "uses: googleapis/release-please-action@5c625bfb5d1ff62eadeeb3772007f7f66fdcf071 # v4.4.1",
    );
    expect(workflow).toContain("config-file: release-please-config.json");
    expect(workflow).toContain("manifest-file: .release-please-manifest.json");

    const actions = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map(([, reference]) => reference);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });
});

describe("Release Please configuration", () => {
  test("tracks the root node package from the current published version", async () => {
    const config = JSON.parse(await readText(configPath));
    const manifest = JSON.parse(await readText(manifestPath));
    const packageJson = JSON.parse(await readText(packageJsonPath));

    expect(config).toEqual({
      packages: {
        ".": {
          "release-type": "node",
          "package-name": "video-digest",
          "changelog-path": "CHANGELOG.md",
          "include-component-in-tag": false,
        },
      },
    });
    expect(manifest).toEqual({ ".": packageJson.version });
  });

  test("documents release history and keeps the initial npm release note", async () => {
    const changelog = await readText(changelogPath);
    const manifest = JSON.parse(await readText(manifestPath));

    expect(changelog).toContain("# Changelog");
    expect(changelog).toContain(manifest["."]);
    expect(changelog).toContain("Initial public npm release of `video-digest`.");
  });
});

describe("Release runbook", () => {
  test("describes Release Please, tags, and manual npm publishing as separate gates", async () => {
    const runbook = await readText(runbookPath);

    const requiredOrder = [
      "Release Please",
      "Release PR",
      "CHANGELOG.md",
      "Git tag",
      "GitHub Release",
      "Publish npm package",
    ];
    const positions = requiredOrder.map((text) => indexOfRequired(runbook, text));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));

    expect(runbook).toContain("Do not publish npm directly from the Release Please workflow");
    expect(runbook).toContain("Run workflow");
    expect(runbook).toContain("Enter the exact version from the Release Please PR");
  });
});
