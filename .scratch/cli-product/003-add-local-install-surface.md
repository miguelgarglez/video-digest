# Add Local Install Surface

Status: done
Category: enhancement

## Parent

.scratch/cli-product/000-prd.md

## What to build

Expose a stable local command named `video-digest` for Miguel's Mac without publishing
the package publicly.

This slice should add the package metadata and executable entrypoint needed for local
installation/linking, then document the exact local install and uninstall commands.
It should not install anything globally during implementation without Miguel's
explicit confirmation.

## Acceptance criteria

- [ ] `package.json` exposes a `bin` command named `video-digest`.
- [ ] The bin entrypoint delegates to the existing TypeScript CLI without duplicating
      ingestion logic.
- [ ] The local install instructions explain how Miguel can make `video-digest`
      available from any terminal directory.
- [ ] The docs include an uninstall/revert command.
- [ ] Public npm publishing remains explicitly out of scope.
- [ ] Tests or a dry-run command verify the package metadata points at an existing
      executable file.

## Blocked by

- .scratch/cli-product/001-define-explicit-cli-commands.md
