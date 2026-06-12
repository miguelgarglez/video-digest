# Define Explicit CLI Commands

Status: done
Category: enhancement

## Parent

.scratch/cli-product/000-prd.md

## What to build

Turn the current mostly implicit CLI entrypoint into an explicit command model while
preserving the existing single-URL invocation as a compatibility path.

After this slice, `video-digest ingest <youtube-url>` should run the same single-video
**Ingestion** path as the current CLI, and `bun run video-digest <youtube-url>` should
continue to work by mapping the URL to `ingest`.

The help output should introduce the new command shape without requiring installation
or public packaging yet.

## Acceptance criteria

- [ ] `bun run video-digest ingest <youtube-url>` runs a single-video **Ingestion**.
- [ ] `bun run video-digest <youtube-url>` still runs the same single-video
      **Ingestion** for backwards compatibility.
- [ ] `bun run video-digest --help` shows the explicit command shape.
- [ ] Missing or unsupported commands return a clear usage error.
- [ ] Existing `--email-preview` behavior still works for both explicit and legacy
      invocation.
- [ ] Parser tests cover explicit `ingest`, legacy URL invocation, missing command, and
      unsupported command behavior.

## Blocked by

None - can start immediately.
