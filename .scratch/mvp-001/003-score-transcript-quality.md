# Score Transcript Quality

Status: ready-for-agent  
Category: enhancement

## What to build

Implement deterministic `transcript-quality.v0` scoring for a **Transcript**, producing `usable`, `warning`, or `unusable` plus metrics and warnings.

## Acceptance criteria

- [ ] Quality output includes `qualitySchemaVersion: "transcript-quality.v0"`.
- [ ] Quality output includes language, segment count, total text length, duration seconds, average characters per minute, and warnings.
- [ ] Empty or timestamp-less transcripts are `unusable`.
- [ ] Very short or suspicious transcripts produce `unusable` or `warning` according to documented thresholds.
- [ ] `warning` quality remains summarizable.
- [ ] Tests cover `usable`, `warning`, and `unusable` fixtures.

## Blocked by

- `.scratch/mvp-001/002-fetch-transcript-with-python-sidecar.md`
