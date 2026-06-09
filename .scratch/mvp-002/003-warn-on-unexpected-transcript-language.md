# Warn on Unexpected Transcript Language

Status: done  
Category: enhancement

## What to build

Make **Transcript Quality** warn when a fetched **Transcript** is in a language outside the accepted **Transcript Language Policy**, while still allowing summarization when the transcript is otherwise useful.

## Acceptance criteria

- [x] `en` transcripts do not receive an unexpected-language warning.
- [x] `es` transcripts do not receive an unexpected-language warning.
- [x] Any other known language receives an unexpected-language warning.
- [x] A useful transcript with only an unexpected-language warning is classified as `warning`, not `unusable`.
- [x] Auto-generated provenance alone does not create a warning.

## Blocked by

- `.scratch/mvp-002/002-expose-transcript-provenance.md`
