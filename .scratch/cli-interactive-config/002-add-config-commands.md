# Add Config Commands

Status: done
Category: enhancement

## Parent

.scratch/cli-interactive-config/000-prd.md

## What to build

Add `video-digest config` commands for checking, storing, and removing the OpenCode API
key.

## Acceptance criteria

- [ ] `video-digest config get` reports whether the OpenCode API key is configured.
- [ ] `config get` never prints the token value.
- [ ] `video-digest config set opencode-api-key` prompts for the token and stores it.
- [ ] `video-digest config unset opencode-api-key` removes the stored token.
- [ ] JSON mode for config commands reports structured status and never prompts.
- [ ] Tests use a fake credential store.

## Blocked by

- .scratch/cli-interactive-config/001-add-credential-store.md
