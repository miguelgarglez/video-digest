# JSON contracts

Video Digest exposes versioned JSON for scripts and agents through `--json`. This
page describes the stdout contract implemented by `video-digest 0.1.0`.

See also [Exit codes](./exit-codes.md) and
[compatibility and versioning](./compatibility.md).

## Stream rules

- A command accepted in JSON mode writes exactly one JSON object to stdout.
- Diagnostics, when present, are written to stderr. They are not part of the JSON
  contract and consumers must not parse them.
- JSON mode does not prompt, animate, copy to the clipboard, open an application,
  reveal a file, or prepare the Python runtime.
- Consumers should first inspect `schemaVersion`, then the command-specific fields.
- A failed object has `status: "failed"` and an `error` object unless a command's
  documented schema says otherwise. `error.message` is for display; branch on
  `error.code` and the process exit status.
- Fields shown as `null` are present and nullable. Domain failures that occur after
  URL parsing may include `videoId`. Parsing, runtime-readiness, and failures without
  a parsed Video omit it. Consumers must therefore treat `videoId` as optional on
  `status: "failed"` objects; it is required on completed Video results.

The public stdout schema versions are:

| Schema | Commands |
| --- | --- |
| `cli-result.v0` | `ingest`, `transcript`, and command-level failures |
| `doctor-report.v0` | `doctor` |
| `library-list.v0` | `list` |
| `open-result.v0` | `open` |
| `config-status.v0` | `config get` |
| `config-result.v0` | `config set` and `config unset` |
| `setup-result.v0` | `setup` |

## `video-digest ingest <youtube-url> --json`

On success, `paths.emailPreviewPath` is a string only when `--email-preview` was
requested; otherwise it is `null`. The three Transcript paths, Digest path, and
metadata path are always present.

<!-- contract:ingest-success -->
```json
{
  "canonicalUrl": "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
  "paths": {
    "digestPath": "/artifact-library/digests/1ZgUcrR0K7I.md",
    "emailPreviewPath": null,
    "metadataPath": "/artifact-library/metadata/1ZgUcrR0K7I.json",
    "transcriptJsonPath": "/artifact-library/transcripts/1ZgUcrR0K7I.json",
    "transcriptMarkdownPath": "/artifact-library/transcripts/1ZgUcrR0K7I.md",
    "transcriptTextPath": "/artifact-library/transcripts/1ZgUcrR0K7I.txt"
  },
  "schemaVersion": "cli-result.v0",
  "status": "completed",
  "transcriptQuality": "usable",
  "videoId": "1ZgUcrR0K7I"
}
```

Provider, credential, runtime, parsing, and unexpected failures use the same
schema. For example, unavailable subtitles return exit status `2`:

<!-- contract:ingest-failure -->
```json
{
  "error": {
    "code": "transcript-unavailable",
    "message": "No transcript is available for this video.\nProvider reason: Subtitles are disabled\nDigest generation was skipped. Try another video or a future transcript fallback."
  },
  "schemaVersion": "cli-result.v0",
  "status": "failed",
  "videoId": "1ZgUcrR0K7I"
}
```

An unusable Transcript is a completed quality decision rather than an `error`
object. It returns exit status `2` and this alternate result shape:

<!-- contract:ingest-unusable -->
```json
{
  "metadataPath": "/artifact-library/metadata/1ZgUcrR0K7I.json",
  "schemaVersion": "cli-result.v0",
  "status": "unusable-transcript",
  "transcriptQuality": "unusable",
  "videoId": "1ZgUcrR0K7I"
}
```

## `video-digest transcript <youtube-url> --json`

The command writes canonical Transcript JSON, human-readable Markdown, clean text,
and entry metadata before returning their paths.

<!-- contract:transcript-success -->
```json
{
  "canonicalUrl": "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
  "paths": {
    "metadataPath": "/artifact-library/metadata/1ZgUcrR0K7I.json",
    "transcriptJsonPath": "/artifact-library/transcripts/1ZgUcrR0K7I.json",
    "transcriptMarkdownPath": "/artifact-library/transcripts/1ZgUcrR0K7I.md",
    "transcriptTextPath": "/artifact-library/transcripts/1ZgUcrR0K7I.txt"
  },
  "schemaVersion": "cli-result.v0",
  "status": "completed",
  "transcriptQuality": "usable",
  "videoId": "1ZgUcrR0K7I"
}
```

The runtime is inspected but never prepared implicitly:

<!-- contract:transcript-failure -->
```json
{
  "error": {
    "code": "runtime-not-ready",
    "message": "Python runtime is missing. Run video-digest setup."
  },
  "schemaVersion": "cli-result.v0",
  "status": "failed"
}
```

## `video-digest setup --yes --json`

`--yes` is required in JSON mode because setup changes application support state.

<!-- contract:setup-success -->
```json
{
  "schemaVersion": "setup-result.v0",
  "status": "ready"
}
```

Without explicit consent, no setup mutation starts:

<!-- contract:setup-failure -->
```json
{
  "error": {
    "code": "consent-required",
    "message": "Setup requires explicit consent; rerun with --yes."
  },
  "schemaVersion": "setup-result.v0",
  "status": "failed"
}
```

## `video-digest config <operation> --json`

`config get` uses `config-status.v0`. `artifactLibrary.configured` is the saved
preference or `null`; `effective` reflects environment/config/default precedence.
`source` is one of `env`, `config`, or `default`.
`--output-dir` is not accepted by `config`; it is a one-command override only for
`ingest`, `transcript`, `list`, and `open`.
`opencodeApiKey.source` is one of `env`, `keychain`, or `missing`; credential values
are never returned.

<!-- contract:config-get-success -->
```json
{
  "artifactLibrary": {
    "configured": null,
    "effective": "/example-home/Documents/Video Digest",
    "source": "default"
  },
  "opencodeApiKey": {
    "configured": false,
    "source": "missing"
  },
  "schemaVersion": "config-status.v0"
}
```

`config set output-dir <path>` returns `status: "saved"` and `artifactLibrary`:

<!-- contract:config-set-success -->
```json
{
  "artifactLibrary": "/artifact-library",
  "schemaVersion": "config-result.v0",
  "status": "saved"
}
```

`config unset opencode-api-key` returns `status: "deleted"` and never returns the
deleted credential:

<!-- contract:config-unset-success -->
```json
{
  "opencodeApiKey": {
    "configured": false
  },
  "schemaVersion": "config-result.v0",
  "status": "deleted"
}
```

Setting a credential is deliberately interactive and therefore unavailable in JSON
mode:

<!-- contract:config-failure -->
```json
{
  "error": {
    "code": "interactive-required",
    "message": "config set opencode-api-key requires an interactive prompt."
  },
  "schemaVersion": "config-result.v0",
  "status": "failed"
}
```

## `video-digest doctor --json`

Every check contains a `capability` (`transcript` or `digest`), stable check `id`,
human message, nullable remediation, and `status` (`pass`, `warn`, or `fail`).
Warnings do not make the report fail. `ok` is false when at least one check fails.

The exact check IDs are:

| Check ID | Capability | Interpretation |
| --- | --- | --- |
| `bun` | `transcript` | The Bun process running the CLI is available. |
| `uv` | `transcript` | `uv` is available for explicit runtime setup; it may warn when an already-prepared runtime remains usable. |
| `python-sidecar` | `transcript` | The packaged Transcript sidecar exists. |
| `python-runtime` | `transcript` | The managed Python runtime matches the shipped lockfile. |
| `opencode-api-key` | `digest` | Digest credentials are configured; absence is a warning because Transcript mode still works. |
| `output-dir` | `transcript` | The effective Artifact Library is writable or can be created. |

`capability` identifies the product capability directly assessed by a check. Digest
generation also depends on Transcript readiness, so consumers should use the report's
top-level `ok` and all failed checks rather than considering only `digest` rows.

<!-- contract:doctor-success -->
```json
{
  "schemaVersion": "doctor-report.v0",
  "checks": [
    {
      "capability": "transcript",
      "id": "python-runtime",
      "message": "Managed Python runtime is ready",
      "remediation": null,
      "status": "pass"
    },
    {
      "capability": "digest",
      "id": "opencode-api-key",
      "message": "OPENCODE_API_KEY is missing; digest generation is unavailable",
      "remediation": "Set OPENCODE_API_KEY to enable video-digest ingest. Transcript mode works without it.",
      "status": "warn"
    }
  ],
  "ok": true
}
```

A failed diagnostic remains a `doctor-report.v0` report, not a generic `error`
object, and exits `1`:

<!-- contract:doctor-failure -->
```json
{
  "schemaVersion": "doctor-report.v0",
  "checks": [
    {
      "capability": "transcript",
      "id": "python-runtime",
      "message": "Managed Python runtime is missing",
      "remediation": "Run video-digest setup.",
      "status": "fail"
    }
  ],
  "ok": false
}
```

## `video-digest list --json`

`items` is ordered by newest `updatedAt`, then by Video ID. Each Library Entry has
all six artifact path keys. Missing optional artifacts are `null`; `metadataPath`
is always a string. `title` and `channel` are nullable.

<!-- contract:list-success -->
```json
{
  "items": [
    {
      "channel": "Example Channel",
      "paths": {
        "digestPath": "/artifact-library/digests/1ZgUcrR0K7I.md",
        "emailPreviewPath": null,
        "metadataPath": "/artifact-library/metadata/1ZgUcrR0K7I.json",
        "transcriptJsonPath": "/artifact-library/transcripts/1ZgUcrR0K7I.json",
        "transcriptMarkdownPath": "/artifact-library/transcripts/1ZgUcrR0K7I.md",
        "transcriptTextPath": "/artifact-library/transcripts/1ZgUcrR0K7I.txt"
      },
      "title": "Example Video",
      "updatedAt": "2026-06-18T12:00:00.000Z",
      "videoId": "1ZgUcrR0K7I"
    }
  ],
  "schemaVersion": "library-list.v0"
}
```

An empty Library is a successful list with `items: []`. An operational failure
uses the generic command-failure schema:

<!-- contract:list-failure -->
```json
{
  "error": {
    "code": "unexpected-error",
    "message": "Artifact Library could not be read."
  },
  "schemaVersion": "cli-result.v0",
  "status": "failed"
}
```

## `video-digest open <latest|video-id> --json`

JSON mode resolves the preferred human-readable artifact but never opens it. A
Digest is preferred; Transcript Markdown is the fallback. Success contains the
same Library Entry fields as `list` plus `openPath`, and has no `status` field.

<!-- contract:open-success -->
```json
{
  "channel": "Example Channel",
  "paths": {
    "digestPath": "/artifact-library/digests/1ZgUcrR0K7I.md",
    "emailPreviewPath": null,
    "metadataPath": "/artifact-library/metadata/1ZgUcrR0K7I.json",
    "transcriptJsonPath": "/artifact-library/transcripts/1ZgUcrR0K7I.json",
    "transcriptMarkdownPath": "/artifact-library/transcripts/1ZgUcrR0K7I.md",
    "transcriptTextPath": "/artifact-library/transcripts/1ZgUcrR0K7I.txt"
  },
  "title": "Example Video",
  "updatedAt": "2026-06-18T12:00:00.000Z",
  "videoId": "1ZgUcrR0K7I",
  "openPath": "/artifact-library/digests/1ZgUcrR0K7I.md",
  "schemaVersion": "open-result.v0"
}
```

<!-- contract:open-failure -->
```json
{
  "error": {
    "code": "library-entry-not-found",
    "message": "No Library Entry found for video AAAAAAAAAAA."
  },
  "schemaVersion": "open-result.v0",
  "status": "failed"
}
```

## Invocation failures

When `--json` is present but argument parsing fails, stdout still receives one
failure object. It uses `setup-result.v0` when the first token is `setup`, and
`cli-result.v0` otherwise:

<!-- contract:invocation-failure -->
```json
{
  "error": {
    "code": "conflicting-options",
    "message": "--stdout cannot be combined with --json. Remove one of these options."
  },
  "schemaVersion": "cli-result.v0",
  "status": "failed"
}
```
