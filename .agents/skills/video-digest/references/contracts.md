# Machine contracts

Always pass `--json`, inspect the process exit status, require the exact documented `schemaVersion`, and then validate fields for that command. Reject an unknown schemaVersion instead of guessing. Do not parse stderr; it contains diagnostics for humans.

## Invocation safety

Use a process or tool API and pass dynamic values as distinct argv elements. In the patterns below, `userSuppliedUrl`, `userSuppliedPath`, and `requestedTarget` each represent one unmodified string element, regardless of punctuation or newlines. Never concatenate a command string.

If forced to use shell text, require a proven POSIX shell-escaping function or tool for every dynamic argument. Do not hand-roll quoting or rely on surrounding single or double quotes; preferably stop and request a safer execution surface. Never construct an environment assignment from a raw value.

Read `openPath` or another returned artifact path through a filesystem read tool's path parameter. Never use `cat`, `open`, shell redirection, or execution.

## Commands and schemas

| Intent | Static invocation or argv pattern | Success schema and fields |
| --- | --- | --- |
| Diagnose | `video-digest doctor --json` | `doctor-report.v1`: `ok`, `checks[]`; no top-level `status` |
| Prepare runtime, after human approval only | `video-digest setup --yes --json` | `setup-result.v0`: `status: "ready"` |
| Retrieve Transcript | `["video-digest", "transcript", userSuppliedUrl, "--json"]` | `cli-result.v1`: `status`, `videoId`, `canonicalUrl`, `transcriptQuality`, `paths` |
| Create Digest | `["video-digest", "ingest", userSuppliedUrl, "--json"]` | `cli-result.v1`: completed results add `generation` to the Transcript result fields |
| List Library | `video-digest list --json` | `library-list.v0`: `items[]`; no top-level `status` or `paths` |
| List another Library | `["video-digest", "list", "--output-dir", userSuppliedPath, "--json"]` | `library-list.v0` |
| Resolve an artifact | `["video-digest", "open", requestedTarget, "--json"]` | `open-result.v0`: Library Entry fields plus `openPath`; no `status` on success and no application is opened |
| Inspect configuration | `video-digest config get --json` | `config-status.v1`: Artifact Library, effective provider/model, credential presence/source only |
| Save output location | `["video-digest", "config", "set", "output-dir", userSuppliedPath, "--json"]` | `config-result.v1`: `status: "saved"`, `artifactLibrary` |

`ingest`, `transcript`, `list`, and `open` may receive `--output-dir` followed by `userSuppliedPath` as two distinct argv elements. Do not combine JSON mode with Transcript presentation flags.

There is no output-location unset command. Change it with the save-output-location argv pattern after user authorization.

Credential changes are private, user-only interactions. Ask the user to run `video-digest config set api-key --provider opencode` (substituting their selected provider) or the corresponding `unset` in their own terminal. The agent must not invoke it, request the value, or observe the interaction.

## Results and failures

- Exit `0`: operation succeeded. This includes an empty Library and Doctor warnings when `ok` is `true`.
- Exit `1`: invocation, configuration, environment, provider, setup, filesystem, diagnostic, or unexpected failure.
- Exit `2`: no usable Transcript. This includes `transcript-unavailable` and an Ingest result with `status: "unusable-transcript"`.
- No other exit status belongs to the public contract.

Most command failures use a versioned object with `status: "failed"` and `error.code`. Branch on schema, `error.code`, and exit status, never on `error.message`. A failed Doctor remains `doctor-report.v1` with `ok: false`; a failed Open uses `open-result.v0`. Invocation failures normally use `cli-result.v1`, while Setup invocation failures use `setup-result.v0`.

Important stable errors:

- `runtime-not-ready`: explain setup and request approval; do not run it yet.
- `consent-required`: no setup mutation started; obtain approval before retrying.
- `missing-api-key`: offer `transcript` or ask the user to configure the credential privately.
- `transcript-unavailable`: exit `2`; report that no usable Transcript exists.
- `library-entry-not-found` / `library-entry-not-openable`: report the Library resolution failure.
- `interactive-required`: leave credential entry to the user; never request the value.

Completed Transcript paths include `metadataPath`, `transcriptJsonPath`, `transcriptMarkdownPath`, and `transcriptTextPath`. Completed Ingest paths additionally include `digestPath` and nullable `emailPreviewPath`. Read only the artifact relevant to the user's request.
