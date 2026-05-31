# Write Versioned Output Artifacts

Status: done  
Category: enhancement

## What to build

Write the versioned output files for a completed **Ingestion**: **Transcript Artifact**, Markdown **Digest**, JSON metadata, and optional email preview.

## Acceptance criteria

- [x] Transcript artifact is written to `outputs/transcripts/<video-id>.json`.
- [x] Markdown digest is written to `outputs/digests/<video-id>.md`.
- [x] Metadata JSON is written to `outputs/metadata/<video-id>.json`.
- [x] Email preview is written to `outputs/emails/<video-id>.md` only when `--email-preview` is provided.
- [x] JSON outputs include schema versions.
- [x] Warning-quality transcripts include visible warnings in Markdown and JSON.
- [x] Secrets are never written to outputs.
- [x] Tests verify file creation using a temporary output directory.

## Blocked by

- `.scratch/mvp-001/004-generate-digest-with-opencode.md`
