# Add Credential Store

Status: done
Category: enhancement

## Parent

.scratch/cli-interactive-config/000-prd.md

## What to build

Add a credential store abstraction and a macOS Keychain-backed implementation for the
OpenCode API key.

## Acceptance criteria

- [ ] A `CredentialStore` interface supports get, set, and delete for the OpenCode API
      key.
- [ ] The macOS implementation uses `security find-generic-password`,
      `security add-generic-password`, and `security delete-generic-password`.
- [ ] The Keychain service is `personal-video-digest`.
- [ ] The Keychain account is `opencode-api-key`.
- [ ] Tests verify command construction without touching the real Keychain.
- [ ] A credential resolver returns env var credentials before stored credentials.

## Blocked by

None - can start immediately.
