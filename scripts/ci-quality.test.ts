import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/cli-quality.yml", import.meta.url);

async function readWorkflow(): Promise<string> {
  return readFile(workflowPath, "utf8");
}

function indexOfRequired(source: string, value: string): number {
  const index = source.indexOf(value);
  expect(index, `workflow must contain ${JSON.stringify(value)}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("CLI quality workflow", () => {
  test("runs the release-readiness gates in order on the supported runner", async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain("runs-on: macos-14 # Apple Silicon (M1 arm64)");
    expect(workflow).toContain("timeout-minutes:");
    expect(workflow).toContain("run: test \"$(uname -m)\" = \"arm64\"");
    expect(workflow).toContain("bun-version: 1.3.14");

    const gates = [
      "bun install --frozen-lockfile",
      "bun test",
      "bun run typecheck",
      "bun run verify:package",
      "bun run smoke:package",
    ];
    const positions = gates.map((gate) => indexOfRequired(workflow, `run: ${gate}`));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  test("uses least privilege and immutable action references", async () => {
    const workflow = await readWorkflow();

    expect(workflow).toMatch(/^permissions:\n  contents: read\n\njobs:/m);
    expect(workflow.match(/^permissions:/gm)).toHaveLength(1);
    expect(workflow).not.toMatch(/\b(?:write|write-all)\b/i);
    expect(workflow).not.toMatch(/^\s*env:/m);
    expect(workflow).not.toMatch(/\b(?:id-token|packages):/i);
    expect(workflow).toContain(
      "uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3",
    );
    expect(workflow).toContain(
      "uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0",
    );

    const actionReferences = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map(
      ([, reference]) => reference,
    );
    expect(actionReferences).toHaveLength(2);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });

  test("cannot publish or receive release credentials", async () => {
    const workflow = await readWorkflow();

    expect(workflow).not.toMatch(/\bnpm\s+publish\b/i);
    expect(workflow).not.toMatch(/\bbun\s+publish\b/i);
    expect(workflow).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./i);
  });
});
