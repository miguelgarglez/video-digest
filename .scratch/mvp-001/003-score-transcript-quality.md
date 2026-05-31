# Score Transcript Quality

Status: done  
Category: enhancement

## What to build

Implement deterministic `transcript-quality.v0` scoring for a **Transcript**, producing `usable`, `warning`, or `unusable` plus metrics and warnings.

## Acceptance criteria

- [x] Quality output includes `qualitySchemaVersion: "transcript-quality.v0"`.
- [x] Quality output includes language, segment count, total text length, duration seconds, average characters per minute, and warnings.
- [x] Empty or timestamp-less transcripts are `unusable`.
- [x] Very short or suspicious transcripts produce `unusable` or `warning` according to documented thresholds.
- [x] `warning` quality remains summarizable.
- [x] Tests cover `usable`, `warning`, and `unusable` fixtures.

## Blocked by

- `.scratch/mvp-001/002-fetch-transcript-with-python-sidecar.md`
