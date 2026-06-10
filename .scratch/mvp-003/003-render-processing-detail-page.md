# Render Processing Detail Page

Status: done
Category: enhancement

## Parent

`.scratch/mvp-003/000-prd-web-ingestion-feedback.md`

## What to build

Render a useful server-side detail page for a **Video** whose **Ingestion** is still
processing. The page should explain what is happening, show the current stage in
Spanish, and keep the existing final result page behavior for completed, skipped, and
failed records.

This slice should improve perceived responsiveness even before browser polling is
added: a refresh should still show the latest persisted stage from SQLite.

## Acceptance criteria

- [x] `GET /ingestions/:videoId` renders a processing state when the record status is `processing`.
- [x] The processing page shows the canonical URL, status badge, human progress label, and updated timestamp.
- [x] Processing labels use Spanish-facing copy and do not expose raw internal stage strings as the primary text.
- [x] The page includes a discreet activity indicator without inventing fake percentage progress.
- [x] Final completed records still render the existing **Digest** section.
- [x] Final failed, transcript-unavailable, and unusable-transcript records still render their error or warning information.

## Blocked by

- `.scratch/mvp-003/001-persist-processing-ingestion-state.md`
