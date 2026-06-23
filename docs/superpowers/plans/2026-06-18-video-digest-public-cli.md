# Video Digest Public CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the complete publication-ready `video-digest@0.1.0` product described by the approved design.

**Architecture:** Execute five independently verifiable plans in order. Each phase preserves the direct JSON CLI as the agent contract while progressively adding durable state, artifacts, the human TUI, adoption material, and black-box package verification.

**Tech Stack:** Bun, TypeScript, Python 3.12 managed by uv, OpenTUI, npm package format, GitHub Actions.

---

- [x] **Phase 1: Build configuration, runtime setup, and Artifact Library foundations**

Follow [2026-06-18-cli-foundation.md](./2026-06-18-cli-foundation.md). Exit gate:
configuration precedence, consented frozen runtime setup, doctor readiness, and the
new Keychain service all pass focused tests and typecheck.

- [x] **Phase 2: Build direct CLI and artifact contracts**

Follow [2026-06-18-cli-artifact-contracts.md](./2026-06-18-cli-artifact-contracts.md).
Exit gate: every Video produces one atomic Library Entry; Transcript JSON, Markdown,
and text renderings and copy/open/stdout modes pass contract tests.

- [x] **Phase 3: Build the guided human TUI**

Follow [2026-06-18-cli-tui.md](./2026-06-18-cli-tui.md). Stop before dependency
installation and obtain explicit user approval for `@opentui/core`. Exit gate: TUI
state, workflows, cleanup, and a manual TTY smoke test pass.

- [x] **Phase 4: Publish documentation and the portable skill in-repository**

Follow [2026-06-18-cli-docs-agent-skill.md](./2026-06-18-cli-docs-agent-skill.md).
Exit gate: public contracts, README, MIT license, and safe Agent Skill are complete and
validated without installing the skill.

- [x] **Phase 5: Verify the npm package without publishing**

Follow [2026-06-18-cli-package-readiness.md](./2026-06-18-cli-package-readiness.md).
Exit gate: the full suite, typecheck, tarball allowlist, isolated global installation,
and macOS ARM CI definition pass. Do not run `npm publish`.
