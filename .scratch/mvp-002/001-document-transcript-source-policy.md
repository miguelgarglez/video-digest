# Document Transcript Source Policy

Status: done  
Category: enhancement

## What to build

Document the **Transcript Source** policy so future changes do not have to infer language order, translation behavior, auto-generated transcript handling, or fallback scope from implementation details.

## Acceptance criteria

- [x] **Transcript Language Policy** is defined in the domain glossary.
- [x] **Transcript Provenance** is defined in the domain glossary.
- [x] The ADR states the preferred language order as `en` then `es`.
- [x] The ADR states that **Transcript Source** does not translate transcripts automatically.
- [x] The ADR states that auto-generated transcripts are accepted and provenance is stored when available.
- [x] The ADR states that automatic provider **Fallback** remains out of scope for MVP 002.

## Blocked by

None - can start immediately
