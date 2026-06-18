# Video Digest Public CLI Design

**Date:** 2026-06-18  
**Status:** Approved for implementation planning

## Objective

Turn the existing local `video-digest` command into a polished public experimental
product that can be consumed by people and agents.

The first milestone makes the CLI ready for npm publication and verifies the exact
package with `npm pack`. It does not publish to npm and does not ship standalone
executables. GitHub Release executables remain a separate future initiative because
making the Bun and Python runtimes truly self-contained requires its own packaging
design.

## Product Positioning

- The package and command are both named `video-digest`.
- A **Digest** is the product's primary outcome. Transcript-only operation is a
  first-class command but does not change the product name.
- The initial release is public and experimental.
- The initial version is `0.1.0`; compatibility may evolve before `1.0.0` but all
  changes must be documented.
- The project uses the MIT license.
- The only officially supported platform for the first release is macOS on Apple
  Silicon.

## Distribution Contract

The first release is a source package for Bun. It preserves the current TypeScript
architecture and Python transcript sidecar instead of introducing a build pipeline
that would not remove any runtime prerequisites.

The npm tarball contains only the public runtime and adoption surfaces:

- `bin/video-digest`;
- `src/`;
- `python/fetch_transcript.py`;
- `python/pyproject.toml`;
- `README.md`;
- `LICENSE`;
- the portable agent skill; and
- required npm metadata.

It excludes tests, `.scratch`, local configuration, generated outputs, internal
project documentation, and development-only files. The `files` field in
`package.json` is the allowlist that defines this boundary.

The package declares Bun, Python, and `uv` as explicit prerequisites. Installing the
npm package must not run a `postinstall` hook, create a Python environment, or install
Python packages.

## Explicit Runtime Setup

The existing transcript sidecar uses `uv run`. Without safeguards, `uv` may create an
environment and install dependencies on first use. Public CLI behavior must make that
state change explicit.

Add `video-digest setup` as the only command that prepares the packaged Python
sidecar. Before changing the environment, it explains what it will install and asks
for confirmation in an interactive terminal. Non-interactive execution requires
`video-digest setup --yes`; it must never infer consent.

The other commands do not synchronize Python dependencies:

- `doctor` reports whether the sidecar is ready and directs the user to `setup`;
- `ingest` and `transcript` fail with an actionable environment error when setup is
  incomplete; and
- the agent skill prohibits running `setup` without human authorization.

The implementation uses one package-resource resolver for `package.json`, `python/`,
and other shipped resources. Resolution is based on module location rather than the
process working directory, so global installation and invocation from another
directory behave consistently.

## CLI Experience

Retain the current command set:

```text
video-digest ingest <youtube-url>
video-digest transcript <youtube-url>
video-digest config <get|set|unset> [opencode-api-key]
video-digest doctor
video-digest list
video-digest open <latest|video-id>
```

Add these product surfaces:

- `video-digest setup` for explicit Python environment preparation;
- `video-digest --version`, sourced from `package.json`; and
- `video-digest <command> --help` for focused command documentation.

Interactive output remains human-oriented. `--json` remains non-interactive and
prints one versioned JSON value to stdout. Diagnostics go to stderr. JSON mode never
prompts, starts a spinner, opens an application, or performs implicit setup.

## Documentation

Rewrite the public README around adoption rather than repository history:

1. product purpose and primary use case;
2. a representative result;
3. support status and prerequisites;
4. installation and explicit setup;
5. quickstart;
6. secure OpenCode configuration;
7. command reference;
8. agent usage with `--json`;
9. troubleshooting through `doctor`;
10. experimental limitations, support, development, and contribution.

Keep stable machine-facing contracts in separate public documentation:

- JSON schema versions and example payloads;
- exit-code meanings;
- stdout and stderr rules; and
- compatibility expectations during `0.x`.

The README links to these contracts instead of duplicating them.

## Portable Agent Skill

Ship a portable skill using the standard `SKILL.md` structure. It is not coupled to a
particular agent product and uses the CLI as its only integration boundary.

The skill instructs an agent to:

1. run `video-digest doctor --json` before work;
2. choose `transcript` or `ingest` from the user's intent;
3. use `--json` for every machine-driven command;
4. inspect `schemaVersion`, status, and exit code rather than parsing human output;
5. use returned paths to locate artifacts;
6. avoid reading, printing, or requesting stored secrets;
7. avoid installing prerequisites or running `setup` without human approval; and
8. present actionable remediation when readiness checks fail.

The skill documents the supported commands and contracts but does not duplicate the
CLI implementation or embed provider-specific business logic.

## Error Contract

Errors are designed for both humans and agents:

- invalid invocation has a distinct usage failure;
- incomplete runtime setup has a distinct environment failure and remediation;
- transcript unavailable remains distinguishable from provider failure;
- missing digest credentials remains distinguishable from transcript-only operation;
- unexpected failures remain non-zero and expose no secrets; and
- JSON failures contain a stable error code and schema version on stdout, with any
  diagnostic detail on stderr.

Exact numeric exit codes and JSON payloads are documented and covered by contract
tests. Existing codes remain stable unless a documented compatibility decision
requires a change.

## Verification

Normal automated tests do not call YouTube, OpenCode, npm publishing, or the user's
real credential store.

Verification includes:

- unit tests for argument parsing, help, version output, setup consent, and resource
  resolution;
- contract tests for JSON payloads, stdout/stderr separation, and exit codes;
- a test proving normal commands never install Python dependencies;
- the existing test suite and TypeScript typecheck;
- `npm pack` followed by an allowlist inspection of the tarball;
- global installation of that tarball into an isolated temporary prefix;
- execution of `--help`, `--version`, and `doctor` from outside the repository;
- a `transcript --json` contract test with deterministic transcript and summarizer
  fakes, separate from the installed-package smoke test; and
- CI on a macOS Apple Silicon runner, matching the supported platform.

The publication-readiness milestone passes only against the packed artifact, not only
against source-tree execution.

## Out of Scope

- Publishing the package to npm.
- Standalone executables and GitHub Release artifacts.
- macOS Intel, Linux, and Windows support.
- Shell completions.
- New video providers, transcript providers, or summarizers.
- Playlist polling, Gmail delivery, and Knowledge Base integration.
- Silent or automatic installation of runtimes and dependencies.

## Acceptance Criteria

The design is implemented when:

1. `video-digest@0.1.0` can be packed without npm metadata errors.
2. The tarball contains only the documented allowlist.
3. The tarball installs into an isolated global prefix on macOS Apple Silicon.
4. The installed command works from outside the repository.
5. Runtime setup is explicit, consented, and never triggered by ordinary commands.
6. Human and JSON help, errors, and output contracts are documented and tested.
7. The README supports a new user from installation through first Digest.
8. The portable skill safely drives transcript and Digest workflows through JSON.
9. Tests, typecheck, pack verification, and isolated-install smoke tests pass.
10. No npm publication occurs as part of this milestone.
