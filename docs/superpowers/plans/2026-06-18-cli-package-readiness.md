# npm Package Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and verify the exact `video-digest@0.1.0` npm tarball without publishing it.

**Architecture:** Make `package.json.files` the public boundary, verify the packed manifest programmatically, and install the tarball into a temporary global prefix for black-box smoke tests. CI runs the same checks on macOS Apple Silicon.

**Tech Stack:** npm registry format, Bun, TypeScript, GitHub Actions, macOS ARM.

---

### Task 1: Publication metadata and platform constraints

**Files:**
- Modify: `package.json`
- Modify: `src/cli/package-metadata.test.ts`

- [x] **Step 1: Expand the failing metadata test**

```ts
test("declares the public package contract", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  expect(pkg).toMatchObject({
    name: "video-digest", version: "0.1.0", license: "MIT",
    os: ["darwin"], cpu: ["arm64"], bin: { "video-digest": "bin/video-digest" },
    repository: { type: "git", url: "git+https://github.com/miguelgarglez/video-digest.git" },
  });
  expect(pkg.private).not.toBe(true);
  expect(pkg.scripts?.postinstall).toBeUndefined();
});
```

- [x] **Step 2: Verify the test fails**

Run: `bun test src/cli/package-metadata.test.ts`  
Expected: FAIL on the old private name and missing version.

- [x] **Step 3: Add complete npm metadata and allowlist**

```json
{
  "name": "video-digest",
  "version": "0.1.0",
  "description": "Turn YouTube videos into local transcripts and structured digests.",
  "license": "MIT",
  "os": ["darwin"],
  "cpu": ["arm64"],
  "files": ["bin", "src", "python/fetch_transcript.py", "python/pyproject.toml", "python/uv.lock", ".agents/skills/video-digest", "docs/cli", "README.md", "LICENSE"],
  "repository": { "type": "git", "url": "git+https://github.com/miguelgarglez/video-digest.git" },
  "bugs": { "url": "https://github.com/miguelgarglez/video-digest/issues" },
  "homepage": "https://github.com/miguelgarglez/video-digest#readme"
}
```

Keep the approved `@opentui/core` dependency and development scripts. Pin direct
runtime dependency versions; do not add publish credentials or a publish script.

- [x] **Step 4: Run metadata tests and typecheck**

Run: `bun test src/cli/package-metadata.test.ts && bun run typecheck`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add package.json src/cli/package-metadata.test.ts
git commit -m "build(npm): define public package"
```

### Task 2: Exact tarball allowlist verifier

**Files:**
- Create: `scripts/verify-package.ts`
- Create: `scripts/verify-package.test.ts`
- Modify: `package.json`

- [x] **Step 1: Write a failing manifest-validation test**

```ts
test("rejects internal files", () => {
  expect(() => validatePackedFiles(["package/package.json", "package/.env"])).toThrow("Unexpected packed file: package/.env");
});

test("requires runtime resources", () => {
  expect(() => validatePackedFiles(["package/package.json"])).toThrow("Missing packed file: package/bin/video-digest");
});
```

- [x] **Step 2: Verify the test fails**

Run: `bun test scripts/verify-package.test.ts`  
Expected: FAIL because the verifier is missing.

- [x] **Step 3: Implement tarball validation**

```ts
const allowedRoots = [
  "package/.agents/skills/video-digest/", "package/bin/", "package/docs/cli/",
  "package/python/", "package/src/",
];
const allowedFiles = new Set(["package/package.json", "package/README.md", "package/LICENSE"]);
const forbiddenSource = /(?:\.(?:test|spec)\.[^/]+$|\.snap(?:\.|$)|\/(?:__)?(?:snapshots?|fixtures?)(?:__)?\/)/i;

export function validatePackedFiles(files: string[]): void {
  for (const file of files) {
    if (forbiddenSource.test(file)) {
      throw new Error(`Unexpected packed file: ${file}`);
    }
    if (!allowedFiles.has(file) && !allowedRoots.some((root) => file.startsWith(root))) {
      throw new Error(`Unexpected packed file: ${file}`);
    }
  }
  for (const required of ["package/bin/video-digest", "package/python/fetch_transcript.py", "package/python/uv.lock"]) {
    if (!files.includes(required)) throw new Error(`Missing packed file: ${required}`);
  }
}
```

Apply the forbidden-source check before the allowed-root check. A test, spec,
snapshot, or fixture remains forbidden even when it is nested under the otherwise
allowed `package/src/` runtime root.

The executable script runs `npm pack --json`, lists the generated `.tgz` with
`tar -tzf`, validates it, prints the tarball path, and removes no user files. Add
`"verify:package": "bun run scripts/verify-package.ts"`.

- [x] **Step 4: Run verifier tests and a real pack**

Run: `bun test scripts/verify-package.test.ts && bun run verify:package`  
Expected: PASS and one local `video-digest-0.1.0.tgz` path; no npm publication.

- [x] **Step 5: Commit**

```bash
git add scripts/verify-package.ts scripts/verify-package.test.ts package.json
git commit -m "test(npm): verify packed contents"
```

### Task 3: Isolated global-install smoke test

**Files:**
- Create: `scripts/smoke-packed-cli.ts`
- Create: `scripts/smoke-packed-cli.test.ts`
- Modify: `package.json`

- [x] **Step 1: Write a failing command-plan test**

```ts
test("smoke test executes outside the repository", () => {
  const plan = buildSmokePlan("/tmp/video-digest.tgz", "/tmp/prefix", "/tmp/work");
  expect(plan.commands).toContainEqual(["npm", "install", "--global", "--prefix", "/tmp/prefix", "/tmp/video-digest.tgz"]);
  expect(plan.cwd).toBe("/tmp/work");
});
```

- [x] **Step 2: Verify the test fails**

Run: `bun test scripts/smoke-packed-cli.test.ts`  
Expected: FAIL because the smoke planner is missing.

- [x] **Step 3: Implement isolated install and assertions**

```ts
export function buildSmokePlan(tarball: string, prefix: string, cwd: string) {
  const executable = join(prefix, "bin", "video-digest");
  return { cwd, commands: [
    ["npm", "install", "--global", "--prefix", prefix, tarball],
    [executable, "--version"], [executable, "--help"], [executable, "doctor", "--json"],
  ] };
}
```

Create temporary prefix/work directories, execute the plan, assert version `0.1.0`,
parse doctor JSON, and remove only those temporary directories in `finally`. Do not run
`setup`, contact providers, touch the real Keychain, or modify agent skills.

- [x] **Step 4: Run the isolated smoke test**

Run: `bun test scripts/smoke-packed-cli.test.ts && bun run smoke:package`  
Expected: PASS from a working directory outside the repository.

Status: verified after explicit user approval with `bun run smoke:package`.

- [x] **Step 5: Commit**

```bash
git add scripts/smoke-packed-cli.ts scripts/smoke-packed-cli.test.ts package.json
git commit -m "test(npm): smoke test packed CLI"
```

### Task 4: macOS ARM quality workflow and final dry run

**Files:**
- Create: `.github/workflows/cli-quality.yml`
- Modify: `README.md`

- [x] **Step 1: Add a workflow matching the supported platform**

```yaml
name: CLI quality
on:
  pull_request:
  push:
    branches: [main]
jobs:
  verify:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - run: bun install --frozen-lockfile
      - run: bun test
      - run: bun run typecheck
      - run: bun run verify:package
      - run: bun run smoke:package
```

Confirm from the GitHub runner documentation that the selected label is Apple Silicon
at implementation time. If it is not, replace it with the current official ARM label;
do not silently weaken the job to x64.

- [x] **Step 2: Run the complete local release-readiness suite**

Run: `bun install --frozen-lockfile && bun test && bun run typecheck && bun run verify:package && bun run smoke:package`  
Expected: every command exits 0; the tarball is not published.

Status: verified after explicit user approval with `bun install --frozen-lockfile`,
`bun test`, `bun run typecheck`, `bun run verify:package`, and
`bun run smoke:package`.

- [x] **Step 3: Recheck the public package name**

Run: `npm view video-digest name version --json`  
Expected before first publication: npm returns `E404`. If a package now occupies the
name, stop and ask the user to choose a new name; do not publish or silently switch to
a scoped package.

- [x] **Step 4: Inspect the final tarball metadata**

Run: `npm pack --dry-run --json`  
Expected: name `video-digest`, version `0.1.0`, only allowlisted files, and no metadata error.

- [x] **Step 5: Update README verification status without claiming publication**

State that the repository is publication-ready and experimental. Do not add an npm
version badge or installation claim that implies the package is already public.

- [x] **Step 6: Commit**

```bash
git add .github/workflows/cli-quality.yml README.md
git commit -m "ci(cli): verify public package"
```
