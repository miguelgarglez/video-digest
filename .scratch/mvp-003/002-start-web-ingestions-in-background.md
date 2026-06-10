# Start Web Ingestions In Background

Status: done
Category: enhancement

## Parent

`.scratch/mvp-003/000-prd-web-ingestion-feedback.md`

## What to build

Change the web **Ingestion** submission flow so `POST /ingestions` responds quickly.
For a valid YouTube URL, the handler should create or update a `processing` record,
start the existing ingestion pipeline in a background promise, and redirect to the
detail page immediately.

The background execution should reuse the existing core progress events and persist
each observable stage without coupling the core to HTTP, polling, or browser behavior.

## Acceptance criteria

- [x] `POST /ingestions` validates and parses the YouTube URL before creating a record.
- [x] Valid submissions save `status = "processing"` with `progressStage = "queued"` before work starts.
- [x] Valid submissions return a `303` redirect to `/ingestions/:videoId` without awaiting transcript or digest generation.
- [x] Background execution calls the existing ingestion service and updates `progressStage` from `ingestVideo.onProgress`.
- [x] Background execution eventually saves the same final records as the current synchronous flow.
- [x] Invalid URL submissions return an HTML error response rather than plain text.
- [x] Core ingestion remains reusable by CLI and does not import web or storage modules.

## Blocked by

- `.scratch/mvp-003/001-persist-processing-ingestion-state.md`
