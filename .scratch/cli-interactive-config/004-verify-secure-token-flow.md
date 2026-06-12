# Verify Secure Token Flow

Status: done
Category: enhancement

## Parent

.scratch/cli-interactive-config/000-prd.md

## What to build

Verify the secure token flow without exposing real credentials.

## Acceptance criteria

- [ ] Automated tests pass.
- [ ] Typecheck passes.
- [ ] `git diff --check` passes.
- [ ] A fake-token Keychain smoke test can set, get, and unset a test credential.
- [ ] The CLI does not print stored token values.
- [ ] `video-digest doctor` reflects Keychain credential readiness when present.
- [ ] `video-digest` interactive flow works for transcript-only and digest setup paths
      with fake or controlled credentials.

## Blocked by

- .scratch/cli-interactive-config/001-add-credential-store.md
- .scratch/cli-interactive-config/002-add-config-commands.md
- .scratch/cli-interactive-config/003-improve-interactive-mode.md
