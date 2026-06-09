# Expose Transcript Provenance

Status: done  
Category: enhancement

## What to build

Extend the **Transcript Source** contract so each fetched **Transcript** can expose provenance metadata without adding a new provider or changing summarization behavior.

## Acceptance criteria

- [x] A **Transcript** can represent unknown, manually authored, or auto-generated provenance.
- [x] The Python sidecar emits provenance metadata when the provider exposes it.
- [x] The TypeScript adapter validates provenance metadata from the sidecar.
- [x] Missing provenance is accepted as unknown metadata.
- [x] Existing ingestion behavior remains unchanged for usable, warning, and unusable transcripts.

## Blocked by

- `.scratch/mvp-002/001-document-transcript-source-policy.md`
