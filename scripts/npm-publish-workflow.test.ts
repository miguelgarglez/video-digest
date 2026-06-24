import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/npm-publish.yml", import.meta.url);
const runbookPath = new URL("../docs/runbooks/npm-release.md", import.meta.url);

async function readWorkflow(): Promise<string> {
  return readFile(workflowPath, "utf8");
}

async function readRunbook(): Promise<string> {
  return readFile(runbookPath, "utf8");
}

function indexOfRequired(source: string, value: string): number {
  const index = source.indexOf(value);
  expect(index, `expected ${JSON.stringify(value)}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("npm publish workflow", () => {
  test("is a manual trusted-publishing workflow with minimum permissions", async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain("name: Publish npm package");
    expect(workflow).toMatch(/^on:\n  workflow_dispatch:\n/m);
    expect(workflow).not.toMatch(/^  push:|^  pull_request:|^  release:/m);
    expect(workflow).toMatch(/^permissions:\n  contents: read\n  id-token: write\n\njobs:/m);
    expect(workflow.match(/^permissions:/gm)).toHaveLength(1);
    expect(workflow).not.toMatch(/\b(?:write-all|packages:|attestations:)\b/i);
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.|_authToken/i);
    expect(workflow).not.toMatch(/npm publish --provenance/i);
  });

  test("pins the release environment, runner, and third-party actions", async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain("environment: npm-production");
    expect(workflow).toContain("runs-on: macos-14 # Apple Silicon (M1 arm64)");
    expect(workflow).toContain('run: test "$(uname -m)" = "arm64"');
    expect(workflow).toContain(
      "uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3",
    );
    expect(workflow).toContain(
      "uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0",
    );
    expect(workflow).toContain(
      "uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
    );
    expect(workflow).toContain("node-version: 24");
    expect(workflow).toContain("registry-url: https://registry.npmjs.org");
    expect(workflow).toContain("package-manager-cache: false");

    const actionReferences = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map(
      ([, reference]) => reference,
    );
    expect(actionReferences).toHaveLength(3);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });

  test("guards identity and version before publishing exactly once", async () => {
    const workflow = await readWorkflow();

    const requiredGuards = [
      'if [ "${{ github.ref_name }}" != "main" ]; then',
      'const expectedVersion = process.env.RELEASE_VERSION;',
      'if (pkg.name !== "video-digest")',
      "if (pkg.version !== expectedVersion)",
      'npm view "video-digest@$RELEASE_VERSION" version --json',
      "Version is already published",
    ];

    for (const guard of requiredGuards) {
      expect(workflow).toContain(guard);
    }

    expect(workflow.match(/\bnpm publish --access public\b/g)).toHaveLength(1);
  });

  test("runs every release-readiness gate before publish", async () => {
    const workflow = await readWorkflow();

    const gates = [
      "run: bun install --frozen-lockfile",
      "run: bun test",
      "run: bun run typecheck",
      "run: bun run verify:package",
      "run: bun run smoke:package",
      "run: npm publish --access public",
    ];
    const positions = gates.map((gate) => indexOfRequired(workflow, gate));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });
});

describe("npm release runbook", () => {
  test("documents trusted publisher setup and the human release flow", async () => {
    const runbook = await readRunbook();

    for (const required of [
      "Trusted Publisher",
      "miguelgarglez/video-digest",
      "npm-publish.yml",
      "npm-production",
      "workflow_dispatch",
      "GitHub environment",
      "npm publish",
      "npm view video-digest version",
      "npm install --global video-digest",
    ]) {
      expect(runbook).toContain(required);
    }

    expect(runbook).toContain("--allow-publish");
    expect(runbook).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/i);
  });
});
