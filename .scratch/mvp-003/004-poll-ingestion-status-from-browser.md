# Poll Ingestion Status From Browser

Status: done
Category: enhancement

## Parent

`.scratch/mvp-003/000-prd-web-ingestion-feedback.md`

## What to build

Add minimal browser polling to the processing detail page. While an **Ingestion** is
processing, the browser should call `GET /api/ingestions/:videoId` every 1-2 seconds,
update the visible stage, and reload the page when a final state is reached so the
server-rendered final result is shown.

This slice should avoid a front-end framework and should not introduce new
dependencies.

## Acceptance criteria

- [x] Polling JavaScript is only included or activated for records with `status = "processing"`.
- [x] The browser polls `GET /api/ingestions/:videoId` every 1-2 seconds.
- [x] The visible progress label updates when the API returns a new `progressLabel`.
- [x] The page reloads when the API returns a final status.
- [x] Polling failures leave the current page readable and show a small retry/error hint.
- [x] No npm, Bun, or browser dependency is added for polling.

## Blocked by

- `.scratch/mvp-003/002-start-web-ingestions-in-background.md`
- `.scratch/mvp-003/003-render-processing-detail-page.md`
