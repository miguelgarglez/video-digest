# Verify Productized CLI End To End

Status: done
Category: enhancement

## Parent

.scratch/cli-product/000-prd.md

## What to build

Verify that the productized CLI works as a local tool for Miguel and as a stable
command surface for agents.

This is a final validation slice, not a broad feature slice. It should exercise local
installation, a real **Ingestion**, artifact discovery, JSON output, and agent-style
consumption from a directory outside the repository.

## Acceptance criteria

- [ ] Automated tests pass.
- [ ] Typecheck passes.
- [ ] `video-digest doctor` passes or reports only explicitly accepted warnings.
- [ ] A real local `video-digest ingest <youtube-url>` generates a **Digest**.
- [ ] `video-digest ingest <youtube-url> --json` returns parseable JSON with artifact
      paths.
- [ ] `video-digest list` shows the generated **Digest**.
- [ ] `video-digest open latest` opens or resolves the latest **Digest** correctly.
- [ ] The locally installed command works from a directory outside the repository.
- [ ] A short README section documents the final CLI workflow.

## Blocked by

- .scratch/cli-product/001-define-explicit-cli-commands.md
- .scratch/cli-product/002-add-agent-safe-json-output.md
- .scratch/cli-product/003-add-local-install-surface.md
- .scratch/cli-product/004-add-doctor-command.md
- .scratch/cli-product/005-add-artifact-discovery-commands.md
- .scratch/cli-product/006-polish-human-cli-ux.md
