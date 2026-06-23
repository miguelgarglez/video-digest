# npm Publish Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual, OIDC-based GitHub Actions workflow and runbook for safe future npm releases of `video-digest`.

**Architecture:** Keep the existing quality workflow non-publishing. Add a separate `npm-publish.yml` workflow with explicit version input, branch/version/package guards, full release-readiness gates, and npm Trusted Publishing. Add a runbook and tests that assert the workflow cannot regress into token-based or branch-agnostic publishing.

**Tech Stack:** GitHub Actions, npm Trusted Publishing/OIDC, Bun, TypeScript tests.

---

### Task 1: Workflow and runbook contract tests

**Files:**
- Create: `scripts/npm-publish-workflow.test.ts`

- [ ] **Step 1: Write failing tests**

Create tests that read `.github/workflows/npm-publish.yml` and
`docs/runbooks/npm-release.md`, then assert:

- the workflow is manual-only via `workflow_dispatch`;
- permissions are exactly `contents: read` and `id-token: write`;
- no `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `secrets.`, or `npm publish --provenance` appears;
- the workflow checks `main`, package name, input version, and unpublished version;
- release gates run before `npm publish --access public`;
- the runbook documents Trusted Publisher setup and post-publish verification.

- [ ] **Step 2: Verify tests fail**

Run: `bun test scripts/npm-publish-workflow.test.ts`

Expected: FAIL because the workflow and runbook do not exist.

### Task 2: Secure npm publish workflow

**Files:**
- Create: `.github/workflows/npm-publish.yml`

- [ ] **Step 1: Add workflow**

Add a `workflow_dispatch` workflow with a required `version` input, `environment:
npm-production`, macOS ARM runner, pinned checkout/setup-bun actions, and these gates:

1. assert `github.ref_name` is `main`;
2. assert `package.json` name/version match `video-digest` and the input version;
3. assert `video-digest@<version>` is not already published;
4. run `bun install --frozen-lockfile`;
5. run `bun test`;
6. run `bun run typecheck`;
7. run `bun run verify:package`;
8. run `bun run smoke:package`;
9. run `npm publish --access public`.

- [ ] **Step 2: Verify workflow tests pass**

Run: `bun test scripts/npm-publish-workflow.test.ts`

Expected: PASS.

### Task 3: Release runbook

**Files:**
- Create: `docs/runbooks/npm-release.md`

- [ ] **Step 1: Document setup and operation**

Document npm Trusted Publisher setup, GitHub environment protection, release steps,
post-publish verification, and rollback/yank guidance.

- [ ] **Step 2: Verify runbook tests pass**

Run: `bun test scripts/npm-publish-workflow.test.ts`

Expected: PASS.

### Task 4: Final verification

**Files:**
- Modify: none unless verification reveals a gap.

- [ ] **Step 1: Run focused and full safe checks**

Run: `bun test scripts/npm-publish-workflow.test.ts scripts/ci-quality.test.ts`

Expected: PASS.

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/npm-publish.yml docs/runbooks/npm-release.md scripts/npm-publish-workflow.test.ts docs/superpowers/specs/2026-06-23-npm-publish-workflow-design.md docs/superpowers/plans/2026-06-23-npm-publish-workflow.md
git commit -m "ci(npm): add trusted publish workflow"
```
