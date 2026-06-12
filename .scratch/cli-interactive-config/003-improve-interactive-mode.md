# Improve Interactive Mode

Status: done
Category: enhancement

## Parent

.scratch/cli-interactive-config/000-prd.md

## What to build

Update `video-digest` with no arguments to guide the user through **Digest** vs
transcript-only mode and credential setup.

## Acceptance criteria

- [ ] Interactive mode asks whether to create a **Digest** or transcript-only artifact.
- [ ] Choosing **Digest** with configured credentials runs full ingestion.
- [ ] Choosing transcript-only runs token-free transcript mode.
- [ ] Choosing **Digest** without credentials shows an OpenCode setup link.
- [ ] The user can paste a token, optionally save it to Keychain, and continue the
      digest in the same run.
- [ ] If the user declines token setup, the CLI offers transcript-only fallback.
- [ ] Tests cover all branches with fake dependencies.

## Blocked by

- .scratch/cli-interactive-config/001-add-credential-store.md
- .scratch/cli-interactive-config/002-add-config-commands.md
