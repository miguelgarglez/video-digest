# Add Doctor Command

Status: done
Category: enhancement

## Parent

.scratch/cli-product/000-prd.md

## What to build

Add `video-digest doctor` to diagnose whether the local environment is ready to run a
single-video **Ingestion**.

The command should check local prerequisites and configuration without calling
YouTube or OpenCode by default. It should produce helpful human output and support
`--json` for agents.

## Acceptance criteria

- [ ] `bun run video-digest doctor` reports an aggregate pass/fail status.
- [ ] Doctor checks include Bun/runtime availability, uv path availability, Python
      sidecar files, OpenCode environment configuration, and writable output
      directory readiness.
- [ ] Failed checks include concrete remediation text.
- [ ] `bun run video-digest doctor --json` returns a versioned JSON report with each
      check's id, status, message, and remediation.
- [ ] Doctor does not call YouTube, OpenCode, Gmail, or other network providers by
      default.
- [ ] Tests cover passing and failing doctor reports using fakes or temporary
      directories.

## Blocked by

- .scratch/cli-product/001-define-explicit-cli-commands.md
- .scratch/cli-product/002-add-agent-safe-json-output.md
