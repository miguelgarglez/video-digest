# Verify Transcript Policy

Status: done  
Category: enhancement

## What to build

Add focused tests around the **Transcript Source** policy and run the transcript and full test suites.

## Acceptance criteria

- [x] Adapter tests cover provenance parsing from sidecar JSON.
- [x] Adapter tests cover missing provenance as unknown metadata.
- [x] Quality tests cover unexpected transcript language warnings.
- [x] Quality tests cover auto-generated provenance without automatic warning.
- [x] `bun test src/transcript` passes.
- [x] `bun run test` passes.

## Blocked by

- `.scratch/mvp-002/003-warn-on-unexpected-transcript-language.md`
