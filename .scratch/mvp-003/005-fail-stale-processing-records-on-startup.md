# Fail Stale Processing Records On Startup

Status: ready-for-agent  
Category: enhancement

## Parent

`.scratch/mvp-003/000-prd-web-ingestion-feedback.md`

## What to build

Prevent the history from permanently showing stale `processing` **Ingestions** after
the Bun process restarts. On startup, records left in `processing` from a previous run
should be marked `failed` with an operational error message explaining that the
server restarted before the **Ingestion** completed.

This slice should not retry the work automatically and should not introduce a durable
queue.

## Acceptance criteria

- [ ] Startup calls a repository operation that marks stale `processing` records as `failed`.
- [ ] The failed records receive an operational error code and a human-readable error message.
- [ ] The implementation does not retry stale work automatically.
- [ ] Fresh in-process background work is not marked failed after it has started in the same server run.
- [ ] The failure state renders through the existing ingestion detail page.
- [ ] Tests cover the repository operation and server startup behavior.

## Blocked by

- `.scratch/mvp-003/001-persist-processing-ingestion-state.md`
