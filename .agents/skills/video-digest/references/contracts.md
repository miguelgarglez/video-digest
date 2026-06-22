# Machine contracts

Always pass `--json`, inspect the process exit status, require the exact documented `schemaVersion`, and then validate fields for that command. Reject an unknown schemaVersion instead of guessing. Do not parse stderr; it contains diagnostics for humans.

## Commands and schemas

| Intent | Invocation | Success schema and fields |
| --- | --- | --- |
| Diagnose | `video-digest doctor --json` | `doctor-report.v0`: `ok`, `checks[]`; no top-level `status` |
| Prepare runtime, after human approval only | `video-digest setup --yes --json` | `setup-result.v0`: `status: "ready"` |
| Retrieve Transcript | `video-digest transcript '<youtube-url>' --json` | `cli-result.v0`: `status`, `videoId`, `canonicalUrl`, `transcriptQuality`, `paths` |
| Create Digest | `video-digest ingest '<youtube-url>' --json` | `cli-result.v0`: completed results have `status`, `videoId`, `canonicalUrl`, `transcriptQuality`, `paths` |
| List Library | `video-digest list --json` | `library-list.v0`: `items[]`; no top-level `status` or `paths` |
| Resolve an artifact | `video-digest open <latest-or-video-id> --json` | `open-result.v0`: Library Entry fields plus `openPath`; no `status` on success and no application is opened |
| Inspect configuration | `video-digest config get --json` | `config-status.v0`: `artifactLibrary`, credential presence/source only |
| Save output location | `video-digest config set output-dir '<path>' --json` | `config-result.v0`: `status: "saved"`, `artifactLibrary` |

`ingest`, `transcript`, `list`, and `open` may add `--output-dir '<path>'` for a single invocation. Do not combine JSON mode with Transcript presentation flags.

There is no output-location unset command. Change the saved location by running `video-digest config set output-dir '<path>' --json` with user authorization.

Credential changes are private, user-only interactions. Ask the user to run `video-digest config set opencode-api-key` or `video-digest config unset opencode-api-key` in their own terminal. The agent must not invoke these commands, request the value, or observe the interaction.

## Results and failures

- Exit `0`: operation succeeded. This includes an empty Library and Doctor warnings when `ok` is `true`.
- Exit `1`: invocation, configuration, environment, provider, setup, filesystem, diagnostic, or unexpected failure.
- Exit `2`: no usable Transcript. This includes `transcript-unavailable` and an Ingest result with `status: "unusable-transcript"`.
- No other exit status belongs to the `0.1.0` contract.

Most command failures use a versioned object with `status: "failed"` and `error.code`. Branch on schema, `error.code`, and exit status, never on `error.message`. A failed Doctor remains `doctor-report.v0` with `ok: false`; a failed Open uses `open-result.v0`. Invocation failures normally use `cli-result.v0`, while Setup invocation failures use `setup-result.v0`.

Important stable errors:

- `runtime-not-ready`: explain setup and request approval; do not run it yet.
- `consent-required`: no setup mutation started; obtain approval before retrying.
- `missing-api-key`: offer `transcript` or ask the user to configure the credential privately.
- `transcript-unavailable`: exit `2`; report that no usable Transcript exists.
- `library-entry-not-found` / `library-entry-not-openable`: report the Library resolution failure.
- `interactive-required`: leave credential entry to the user; never request the value.

Completed Transcript paths include `metadataPath`, `transcriptJsonPath`, `transcriptMarkdownPath`, and `transcriptTextPath`. Completed Ingest paths additionally include `digestPath` and nullable `emailPreviewPath`. Read only the artifact relevant to the user's request.
