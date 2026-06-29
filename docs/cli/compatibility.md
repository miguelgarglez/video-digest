# Compatibility and versioning

Video Digest `0.1.0` is an experimental npm-distributed CLI. Its supported platform
is macOS on Apple Silicon (`darwin`/`arm64`). macOS on Intel, Linux, and Windows are
outside the supported compatibility contract.

See the [JSON contracts](./json-contracts.md) and [Exit codes](./exit-codes.md).

## Runtime contract

- Bun is the JavaScript runtime and the executable selected by the installed
  command. Installing through npm does not replace the Bun requirement. The package
  metadata declares the supported Bun engine range.
- `uv` is the manually installed runtime manager used only by explicit setup.
- `video-digest setup` may install an isolated Python 3.12 runtime and dependencies
  locked by the shipped `python/uv.lock`. It requires interactive confirmation or
  `--yes` in non-interactive use.
- Video Digest does not install or modify system Python.
- Normal `ingest`, `transcript`, `doctor`, `list`, and `open` operations never
  synchronize Python dependencies. `doctor` reports missing, obsolete, and ready
  runtime state; `ingest` and `transcript` fail with remediation when setup is not
  ready.
- The TUI relies on the packaged OpenTUI native renderer for macOS ARM.

The supported shell environment must be able to execute `bun`, and setup must be
able to execute `uv` (or the path supplied through `UV_BIN`). Clipboard, opening,
and Finder actions use the macOS `pbcopy` and `open` commands.

## Experimental `0.x` policy

Before `1.0.0`, commands, human copy, defaults, and data formats may evolve between
minor releases. A release that makes a breaking machine-readable change must
increment the affected `schemaVersion` and update the public contract examples and
tests. Consumers must reject unknown schema versions instead of guessing their
shape.

Additive changes that do not invalidate existing fields may remain within a schema
version during `0.x`; consumers should ignore fields they do not use. Removing or
renaming a field, changing its type or nullability, changing status semantics, or
changing the meaning of an error code requires a schema-version increment.

Process exit statuses are versioned by the [exit-code contract](./exit-codes.md).
Changes to their meaning are breaking even if a JSON payload is unchanged.

## Network, privacy, and installation boundaries

There is no telemetry and no automatic update check. Network requests happen only
for an explicit Video operation (public YouTube metadata or Transcript retrieval,
and selected-provider Digest generation) or consented runtime preparation. Package
installation itself must not prepare Python, run a postinstall setup, or modify
agent configuration.
