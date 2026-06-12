# Polish Human CLI UX

Status: done
Category: enhancement

## Parent

.scratch/cli-product/000-prd.md

## What to build

Refine the human terminal experience now that the productized CLI command surface is
in place.

This slice should make the CLI feel deliberate: concise command help, clear progress,
useful final summaries, understandable errors, and copy that teaches Miguel what
happened without overwhelming him.

Because CLI feel is partly subjective, this slice should include human review before
it is considered done.

## Acceptance criteria

- [ ] `video-digest --help` is concise and includes examples for the main commands.
- [ ] Command-specific help exists where it materially improves discoverability.
- [ ] Successful human `ingest` output highlights the **Digest** title and useful
      artifact paths.
- [ ] Transcript-unavailable errors preserve the provider reason when available.
- [ ] Missing configuration errors explain the required environment variable or setup
      step.
- [ ] Progress output remains readable in interactive terminals and clean in
      non-interactive terminals.
- [ ] Miguel runs at least one local command and approves the terminal feel.

## Blocked by

- .scratch/cli-product/001-define-explicit-cli-commands.md
- .scratch/cli-product/004-add-doctor-command.md
- .scratch/cli-product/005-add-artifact-discovery-commands.md
