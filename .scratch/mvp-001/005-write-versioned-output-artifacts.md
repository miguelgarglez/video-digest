# Write Versioned Output Artifacts

Status: ready-for-agent  
Category: enhancement

## What to build

Write the versioned output files for a completed **Ingestion**: **Transcript Artifact**, Markdown **Digest**, JSON metadata, and optional email preview.

## Acceptance criteria

- [ ] Transcript artifact is written to `outputs/transcripts/<video-id>.json`.
- [ ] Markdown digest is written to `outputs/digests/<video-id>.md`.
- [ ] Metadata JSON is written to `outputs/metadata/<video-id>.json`.
- [ ] Email preview is written to `outputs/emails/<video-id>.md` only when `--email-preview` is provided.
- [ ] JSON outputs include schema versions.
- [ ] Warning-quality transcripts include visible warnings in Markdown and JSON.
- [ ] Secrets are never written to outputs.
- [ ] Tests verify file creation using a temporary output directory.

## Blocked by

- `.scratch/mvp-001/004-generate-digest-with-opencode.md`
