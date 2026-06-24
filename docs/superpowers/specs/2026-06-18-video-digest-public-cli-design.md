# Video Digest Public CLI Design

**Date:** 2026-06-18  
**Status:** Approved for implementation planning

## Objective

Turn the existing local `video-digest` command into a polished public experimental
product for people and agents.

The `0.1.0` milestone makes the CLI ready for npm publication and verifies the exact
package with `npm pack`. It does not publish to npm and does not ship standalone
executables. GitHub Release executables remain a separate initiative because making
the Bun and Python runtimes self-contained requires a dedicated packaging design.

## Product Positioning

- The package and command are both named `video-digest`.
- A **Digest** is the primary outcome. Transcript-only operation is a first-class
  command but does not change the product name.
- The initial release is public, experimental, English-only, and MIT licensed.
- Compatibility may evolve before `1.0.0`, but machine-contract changes must be
  versioned and documented.
- The only supported platform is macOS on Apple Silicon. Package metadata rejects
  other operating systems and CPU architectures instead of allowing a known-broken
  installation.
- The product performs no telemetry and no automatic update checks.
- Network access occurs only for an explicit user operation: YouTube metadata or
  Transcript retrieval, Digest generation through OpenCode, or consented runtime
  preparation.

## Delivery Phases

The complete target remains `0.1.0`, but implementation is divided into independently
verifiable phases:

1. configuration, explicit runtime setup, and the Artifact Library;
2. direct CLI contracts and new artifact representations;
3. the guided terminal UI;
4. public documentation and the portable agent skill; and
5. package metadata, tarball verification, and isolated installation.

Every phase leaves tests passing and produces reviewable commits. No public package is
published between phases.

## Distribution Contract

The first release is a source package for Bun. It preserves the TypeScript application
and Python Transcript sidecar instead of introducing a build pipeline that would not
remove the runtime prerequisites.

The npm tarball contains only public runtime and adoption surfaces:

- `bin/video-digest`;
- `src/`;
- `python/fetch_transcript.py`;
- `python/pyproject.toml`;
- `python/uv.lock`;
- `.agents/skills/video-digest/`;
- public CLI contract documentation;
- `README.md`;
- `LICENSE`; and
- required npm metadata.

It excludes tests, `.scratch`, local configuration, generated outputs, internal
project documentation, and development-only files. The `files` field in
`package.json` is the allowlist for this boundary.

`@opentui/core` is the only runtime UI dependency. The package remains
Bun-native and declares supported runtime and platform constraints. Installing it
must not run a `postinstall` hook, create a Python environment, or install Python
packages.

The package is distributed through the npm registry. The primary installation command
is `bun add --global video-digest`; `npm install --global video-digest` is also
supported when npm is present. Bun remains the runtime selected by the executable
shebang in both cases.

## Application State

Keep user content, configuration, installed support state, and cache separate:

- **Artifact Library:** user-selected, defaulting to `~/Documents/Video Digest`;
- configuration: `~/Library/Application Support/video-digest/config.json`;
- Python runtime: `~/Library/Application Support/video-digest/runtime/python`; and
- dependency cache: the standard cache managed by `uv`.

The configuration file is versioned, contains no secrets, and stores the Artifact
Library path. OpenCode credentials remain in macOS Keychain under the new service name
`video-digest`; the old `personal-video-digest` credential is not migrated or read.

Artifact Library resolution follows this precedence:

```text
--output-dir <path>
VIDEO_DIGEST_OUTPUT_DIR
saved configuration
~/Documents/Video Digest
```

The flag applies only to one execution. The environment variable temporarily
overrides saved configuration without changing it. The TUI changes the persistent
preference through Settings; direct users use
`video-digest config set output-dir <path>`.

No product migration is added for the repository's existing `./outputs` directory.
That personal pre-release state may be moved or removed manually.

## Explicit Runtime Setup

`video-digest setup` has one responsibility: prepare the isolated Python runtime used
by the Transcript Source. It does not configure credentials or the Artifact Library.

Before changing the environment, `setup` explains that it may install an isolated
Python 3.12 runtime and the locked Transcript dependencies. It asks for confirmation
in a TTY. Non-interactive execution requires `video-digest setup --yes`; consent is
never inferred.

Setup uses the shipped `uv.lock` with frozen resolution. A marker derived from the
lockfile identifies whether the installed runtime is current. Rebuilds happen in a
temporary location and replace the active runtime only after success, so cancellation
or failure cannot corrupt a working runtime.

Normal commands never synchronize dependencies:

- `doctor` distinguishes missing `uv`, an unprepared runtime, and an obsolete runtime;
- `ingest` and `transcript` fail with actionable setup remediation; and
- the agent skill prohibits `setup` without human authorization.

The only manual runtime prerequisites are Bun and `uv`. The managed Python
installation never modifies the system Python.

A single package-resource resolver locates `package.json`, `python/`, the lockfile,
and other shipped resources from module location rather than the process working
directory.

## Direct CLI Contract

Retain the existing commands and add explicit product surfaces:

```text
video-digest ingest <youtube-url>
video-digest transcript <youtube-url>
video-digest setup [--yes]
video-digest config <get|set|unset> [key] [value]
video-digest doctor
video-digest list
video-digest open <latest|video-id>
video-digest --version
video-digest <command> --help
```

`ingest`, `transcript`, `list`, and `open` accept `--output-dir <path>`.

Transcript presentation adds:

```text
video-digest transcript <youtube-url> --copy
video-digest transcript <youtube-url> --open
video-digest transcript <youtube-url> --stdout
```

- `--copy` writes all artifacts and copies clean Transcript text to the macOS
  clipboard;
- `--open` writes all artifacts and opens the human-readable Markdown Transcript;
- `--stdout` writes all artifacts, disables progress output, and emits only clean
  Transcript text for shell pipelines; and
- `--stdout` and `--json` are mutually exclusive.

Without those flags, direct commands retain concise human output. When terminal
capabilities allow it, file paths are OSC 8 hyperlinks with plain paths as fallback.

`--json` remains non-interactive and writes exactly one versioned JSON value to
stdout. Diagnostics go to stderr. JSON mode never prompts, animates, opens another
application, copies to the clipboard, or performs setup.

## Artifact Model

An **Artifact Library** contains one **Library Entry** per Video. A Library Entry
groups all available representations for that Video instead of exposing unrelated
file rows.

Transcript processing writes three representations:

1. versioned JSON with segments and timestamps for reproducibility and agents;
2. Markdown with metadata and timestamps for human reading; and
3. clean text derived from the same segments for clipboard and stdout use.

The clean text renderer removes JSON structure and timestamps, joins segments without
changing their words, and creates readable paragraphs. It is a presentation derived
from the canonical JSON, not a second Transcript source.

A Library Entry may also contain a Digest and Email Preview. Reprocessing the same
Video replaces its current entry rather than creating history. Writes are atomic so a
failed replacement leaves the prior entry intact.

The library index reads metadata rather than scanning only the Digest directory, so
transcript-only entries remain visible. It returns available artifact paths and
metadata in both human and JSON modes.

YouTube oEmbed enriches each entry with public title and channel metadata without an
API key. This lookup is best-effort and occurs only while processing an explicitly
requested Video. Failure does not block Transcript or Digest creation; the Video ID is
the fallback display label. Persisted metadata prevents repeat lookups during list and
open operations.

## Terminal UI

Running `video-digest` without arguments in a TTY launches the primary human
interface, built with `@opentui/core`. Direct subcommands and JSON remain the stable
automation interface. Non-TTY execution without arguments shows help and never starts
the TUI.

The TUI is guided and low-density rather than dashboard-oriented. Each screen presents
one main decision with clear hierarchy and restrained shortcuts. It covers:

- create a Digest or Transcript;
- progress and cancellation;
- browse and open Library Entries;
- configure the Artifact Library and OpenCode credential;
- prepare and inspect the Transcript runtime;
- run and understand diagnostics; and
- discover the portable agent skill.

First-run onboarding is progressive. It asks for the Artifact Library location, then
enters the application. Python setup is requested only when a Transcript capability
is first used. OpenCode configuration is requested only when Digest generation needs
it.

After processing, an uncluttered success screen shows the result and these actions:

- open the human-readable artifact;
- copy clean Transcript text when available;
- print clean Transcript text to terminal scrollback;
- reveal the artifact in Finder; and
- return home.

Opening the artifact leads to a separate scrollable reading screen instead of placing
a dense preview on the success screen.

OpenTUI remains an adapter. Screen state and navigation are isolated from Ingestion,
Transcript, configuration, library, and setup services so direct commands and tests do
not depend on the renderer. The TUI restores terminal state after success, error,
Ctrl-C, or unexpected failure. It honors `NO_COLOR` and shows a clear fallback when
the terminal is too small or incapable of full-screen rendering.

The Agent Skill page explains the integration, links to the canonical `SKILL.md`, and
provides copyable preview and installation commands. Version `0.1.0` does not execute
`gh skill install` from the TUI because that GitHub CLI feature is still in public
preview.

## Documentation

Public documentation and all CLI/TUI copy are English-only in `0.1.0`. User-facing
strings are centralized enough to permit later localization without implementing an
i18n system now.

Rewrite the README around adoption:

1. product purpose and a representative result;
2. experimental status and supported platform;
3. Bun and `uv` prerequisites;
4. installation, first run, and consented runtime setup;
5. TUI and direct-command quickstarts;
6. Artifact Library behavior and secure OpenCode configuration;
7. command reference and Transcript output modes;
8. agent usage through `--json`;
9. troubleshooting through `doctor`;
10. privacy, limitations, support, development, and contribution.

Keep stable machine-facing contracts in separate public documentation:

- JSON schema versions and example payloads;
- exact exit-code meanings;
- stdout and stderr rules; and
- compatibility expectations during `0.x`.

The README links to these contracts instead of duplicating them.

## Portable Agent Skill

The canonical skill lives at `.agents/skills/video-digest/SKILL.md`, follows the open
Agent Skills specification, and uses the direct CLI as its only integration boundary.
It is shipped in the npm tarball but installed independently; package setup never
modifies an agent host.

Documentation shows a review-first flow using GitHub CLI and a manual fallback:

```text
gh skill preview miguelgarglez/video-digest video-digest --allow-hidden-dirs
gh skill install miguelgarglez/video-digest video-digest --allow-hidden-dirs
```

The flag is required because the canonical skill lives under the hidden `.agents`
directory. These commands require a GitHub CLI version that includes the preview
`gh skill` feature; Video Digest never installs or updates GitHub CLI.

The skill instructs an agent to:

1. run `video-digest doctor --json` before work;
2. choose `transcript` or `ingest` from user intent;
3. use `--json` for machine-driven commands;
4. inspect `schemaVersion`, status, and exit code instead of human output;
5. use returned Library Entry paths to locate artifacts;
6. avoid reading, printing, or requesting stored secrets;
7. avoid installing prerequisites or running `setup` without human approval; and
8. present actionable remediation when readiness checks fail.

The skill contains no pre-approved unrestricted shell permission, provider-specific
business logic, or automatic setup behavior.

## Error Contract

Errors serve people and agents:

- invalid invocation has a distinct usage failure;
- incomplete or obsolete runtime setup has a distinct environment failure;
- Transcript unavailable remains distinguishable from provider failure;
- missing Digest credentials remains distinguishable from transcript-only operation;
- clipboard, opener, metadata enrichment, and TUI rendering failures have scoped
  remediation and do not expose secrets; and
- unexpected failures remain non-zero and leave terminal and artifacts consistent.

JSON failures contain a stable error code and schema version on stdout, with
diagnostics on stderr. Exact numeric exit codes and payloads are documented and
covered by contract tests. A machine-schema change increments its schema version.

## Verification

Normal automated tests do not call YouTube, OpenCode, npm publishing, the user's real
Keychain, clipboard, Finder, or global agent configuration.

Verification includes:

- argument parsing, command help, version output, and output-directory precedence;
- setup consent, frozen lockfile use, atomic runtime replacement, and readiness
  detection;
- configuration schema, Keychain service name, and secret exclusion;
- JSON, Markdown, and clean-text Transcript renderers;
- Library Entries for transcript-only and Digest workflows;
- atomic replacement of an existing Video entry;
- best-effort oEmbed metadata with deterministic fakes and fallback;
- clipboard, opener, Finder, and stdout adapters with fakes;
- JSON payloads, stdout/stderr separation, schema versions, and exit codes;
- TUI state/navigation tests independent of the real terminal renderer;
- renderer smoke tests for launch, cancellation, cleanup, and small-terminal fallback;
- a proof that normal commands never install Python dependencies;
- the existing test suite and TypeScript typecheck;
- `npm pack` followed by exact allowlist inspection;
- global installation from the tarball into an isolated temporary prefix;
- `--help`, `--version`, and `doctor` from outside the repository; and
- CI on macOS Apple Silicon, matching the supported platform.

The publication-readiness milestone passes only against the packed artifact, not only
against source-tree execution.

## Out of Scope

- Publishing to npm.
- Standalone executables and GitHub Release artifacts.
- macOS Intel, Linux, and Windows support.
- Importing or migrating pre-release `./outputs` data.
- Execution history or multiple versions of one Video entry.
- Shell completions.
- Automated agent-skill installation.
- Telemetry and automatic update checks.
- Localization beyond English.
- New video, Transcript, or Digest providers.
- Playlist polling, Gmail Delivery, and Knowledge Base integration.
- Silent or automatic installation of runtimes and dependencies.

## Acceptance Criteria

The design is implemented when:

1. `video-digest@0.1.0` packs without npm metadata errors and rejects unsupported
   platforms.
2. The tarball contains only the documented allowlist and installs into an isolated
   global prefix on macOS Apple Silicon.
3. The installed command works from outside the repository.
4. Runtime setup is explicit, locked, atomic, and never triggered by ordinary
   commands.
5. First-run TUI onboarding is progressive and the guided UI covers creation,
   Library, Settings, setup, and diagnostics.
6. A Transcript produces JSON, Markdown, and clean-text representations with copy,
   open, print, and stdout paths.
7. One atomic Library Entry per Video represents transcript-only and Digest results.
8. Human and machine help, errors, schemas, and exit codes are documented and tested.
9. The README takes a new user from installation through a first Digest.
10. The independently installed skill safely drives workflows through JSON.
11. Tests, typecheck, TUI smoke tests, pack verification, and isolated installation
    pass on the supported platform.
12. No npm publication, telemetry, implicit installation, or personal data migration
    occurs in this milestone.
