# Generate Digest with OpenCode

Status: done  
Category: enhancement

## What to build

Implement the `Summarizer` interface and `OpenCodeSummarizer` adapter that turns a summarizable **Transcript** into structured `digest.v0` content using OpenCode Zen.

## Acceptance criteria

- [x] The core depends on a `Summarizer` interface.
- [x] `OpenCodeSummarizer` reads `OPENCODE_API_KEY`, `OPENCODE_BASE_URL`, and `OPENCODE_MODEL`.
- [x] Missing `OPENCODE_API_KEY` fails before any provider call with a clear error.
- [x] The generated structure includes **Digest Title**, TL;DR, key ideas, relevant timestamps, actionable ideas, concepts to investigate, connections, and verdict.
- [x] `OPENCODE_MODEL` defaults to `gpt-5-nano`.
- [x] Tests cover provider behavior with a fake `fetch`; end-to-end orchestration with fake `Summarizer` is covered in Issue 006.
- [x] Provider-specific details do not leak into domain types.

## Blocked by

- `.scratch/mvp-001/003-score-transcript-quality.md`
