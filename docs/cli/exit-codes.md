# Exit codes and error codes

Video Digest uses a small process exit-status contract. JSON consumers must inspect
both the process status and the versioned object on stdout. See
[JSON contracts](./json-contracts.md) and
[compatibility and versioning](./compatibility.md).

## Process exit statuses

| Exit status | Meaning |
| --- | --- |
| 0 | The requested operation succeeded. This includes an empty Library list and a `doctor` report containing warnings but no failed checks. |
| 1 | Invocation, configuration, environment, provider, setup, filesystem, system-action, diagnostic, or unexpected failure. A `doctor` report with any failed check exits `1`. |
| 2 | No usable Transcript was available: the provider reported `transcript-unavailable`, or `ingest` classified the Transcript as `unusable-transcript`. |

No other process exit status is part of the `0.1.0` public contract.

## Command-family behavior

| Command family | Exit `0` | Exit `1` | Exit `2` |
| --- | --- | --- | --- |
| Invocation | Valid `--help` or `--version` output | Argument parsing or unsupported invocation | Never |
| Setup | Runtime prepared and ready | Consent, locking, recovery, or preparation failure | Never |
| Doctor | `ok: true`, including warnings | `ok: false` because at least one check failed | Never |
| Ingest / Transcript | Artifacts completed | Runtime, credential, provider, filesystem, or unexpected failure | Transcript unavailable; also an unusable Transcript for `ingest` |
| Library / Config | Successful list, resolution, or configuration operation | Library, validation, interactive-requirement, or configuration failure | Never |

## JSON error codes

Error codes are scoped by the schema and operation. They are more precise than
exit status `1`; consumers should not branch on the human-readable message.

### Invocation

These parsing errors use `cli-result.v1`, except an invocation beginning with
`setup`, which uses `setup-result.v0`.

| Error code | Meaning |
| --- | --- |
| `conflicting-options` | Mutually exclusive flags were combined. |
| `duplicate-option` | The same option was supplied more than once. |
| `invalid-url` | The input is not a supported YouTube Video URL. |
| `missing-option-value` | An option or configuration key lacks its value. |
| `missing-url` | A Video URL or `open` target is missing. |
| `unsupported-command` | A command or positional argument is unsupported. |
| `unsupported-option` | A flag is unsupported for the selected command. |

All invocation errors exit `1`.

### Runtime and setup

| Error code | Schema | Meaning |
| --- | --- | --- |
| `runtime-not-ready` | `cli-result.v1` | Transcript work requires explicit `video-digest setup`. |
| `consent-required` | `setup-result.v0` | JSON or non-interactive setup omitted `--yes`. |
| `already-running` | `setup-result.v0` | Another live setup or recovery owns the setup lock. |
| `recovery-required` | `setup-result.v0` | Setup cannot safely recover or prove ownership automatically. |
| `setup-failed` | `setup-result.v0` | An unexpected setup operation failed. |

These errors exit `1`. Normal commands never run setup implicitly.

### Transcript and Digest providers

| Error code | Exit status | Meaning |
| --- | --- | --- |
| `transcript-unavailable` | 2 | The Transcript provider reports that no Transcript is available. |
| `missing-api-key` | 1 | Digest generation has no credential for the selected provider. Transcript-only operation remains available. |
| `provider-failed` | 1 | The Transcript or Digest provider failed. |
| `invalid-provider-response` | 1 | A provider response could not be validated. |
| `authentication-failed` | 1 | The selected provider rejected its credential. |
| `context-limit-exceeded` | 1 | The request exceeds the selected model context. |
| `invalid-model` | 1 | The configured model is unavailable or invalid. |
| `provider-unavailable` | 1 | The selected provider is temporarily unavailable. |
| `quota-exceeded` | 1 | The selected provider account has exhausted quota. |
| `rate-limited` | 1 | The selected provider temporarily rate-limited the request. |
| `unexpected-error` | 1 | An unclassified operation failed. |

The `unusable-transcript` value is a `cli-result.v1` result `status`, not an
`error.code`; it exits `2` after writing failure metadata.

### Configuration and Library

| Error code | Schema | Meaning |
| --- | --- | --- |
| `interactive-required` | `config-result.v1` | The requested credential operation requires a human prompt. |
| `library-entry-not-found` | `open-result.v0` | The requested Video has no Library Entry. |
| `library-entry-not-openable` | `open-result.v0` | The entry has no readable Digest or Transcript Markdown. |

These errors exit `1`.

## Human-interface system actions

The following stable errors belong to direct presentation actions and the TUI:

| Error code | Meaning |
| --- | --- |
| `copy-failed` | Clean Transcript text could not be copied with `pbcopy`. |
| `open-failed` | The selected human-readable artifact could not be opened. |
| `reveal-failed` | The selected artifact could not be revealed in Finder. |

They exit `1` when they terminate a direct command. They are not emitted by a JSON
operation: JSON mode suppresses clipboard, opener, and Finder actions.

## stdout and stderr on failure

With `--json`, stdout contains exactly one documented JSON object, including on a
parsing failure. Diagnostics, when present, are written to stderr and are intended
for humans. Without `--json`, failures are written to stderr as concise actionable
text; stdout remains the human result channel.
