# Persist Processing Ingestion State

Status: ready-for-agent  
Category: enhancement

## Parent

`.scratch/mvp-003/000-prd-web-ingestion-feedback.md`

## What to build

Extend the persisted **Ingestion** record so the web adapter can represent an
in-progress **Video** processing run before a final **Digest**, skip, or failure is
available.

This slice should introduce `processing` as an operational storage/web status, add a
nullable `progressStage`, and expose enough JSON from the existing ingestion API for a
browser poller to understand the current state. `progressStage` is not domain
language and should not be added to `CONTEXT.md`.

## Acceptance criteria

- [ ] `IngestionRecordStatus` accepts `processing`.
- [ ] `IngestionRecord` persists a nullable `progressStage`.
- [ ] `progressStage` accepts `queued` plus the stages emitted by `ingestVideo.onProgress`.
- [ ] `IngestionRepository` can save and read records with `status = "processing"`.
- [ ] `IngestionRepository` can update only the progress stage for an existing record.
- [ ] `GET /api/ingestions/:videoId` includes `status`, `progressStage`, `statusLabel`, `progressLabel`, and `updatedAt`.
- [ ] UI labels are generated in the web layer and are Spanish-facing copy.
- [ ] Existing completed, unusable, transcript-unavailable, and failed records still round-trip through storage.

## Blocked by

None - can start immediately
