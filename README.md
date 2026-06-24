# Video Digest

Turn an explicitly selected YouTube video into a readable Digest, a reproducible
Transcript, or both. Video Digest provides a guided terminal interface for people and
versioned JSON contracts for agents and shell automation.

## What it creates

Each video becomes one Library Entry in your Artifact Library. A full run creates a
Markdown Digest alongside three Transcript representations:

```text
Video Digest/
├── digests/1ZgUcrR0K7I.md
├── metadata/1ZgUcrR0K7I.json
└── transcripts/
    ├── 1ZgUcrR0K7I.json   # canonical segments and timestamps
    ├── 1ZgUcrR0K7I.md     # human-readable transcript
    └── 1ZgUcrR0K7I.txt    # clean text for copying and pipelines
```

A Digest is structured Markdown designed for review rather than a raw model response:

```markdown
# Building Reliable CLI Products

## TL;DR
A concise account of the video's argument and its practical implications.

## Key ideas
- Stable machine contracts let people and agents share the same tool safely.
```

Transcript-only processing creates the metadata and Transcript files without calling
OpenCode. Reprocessing a video atomically replaces its current Library Entry; Video
Digest does not keep processing history.

## Status and support

Video Digest `0.1.0` is public, experimental, English-only software licensed under
MIT. The supported platform is macOS on Apple Silicon. macOS Intel, Linux, and Windows
are not supported in this release.

The npm package is published as `video-digest@0.1.0`. Repository CI is configured on
the supported Apple Silicon platform to verify the tests, types, exact tarball
contents, and an isolated installation of the packed CLI.

Compatibility may change before `1.0.0`. Human-facing behavior can evolve during
`0.x`; machine-facing changes are versioned and documented in the
[compatibility policy](docs/cli/compatibility.md).

## Prerequisites

- [Bun](https://bun.sh/) to run the TypeScript CLI.
- [`uv`](https://docs.astral.sh/uv/) to prepare the isolated Transcript runtime.

Video Digest manages its own Python 3.12 runtime. It does not modify system Python.

## Install

Install the published package globally:

```sh
npm install --global video-digest
```

The Bun alternative is:

```sh
bun add --global video-digest
```

Both installations expose `video-digest`; Bun must remain available on `PATH` because
the executable uses Bun at runtime.

To run from source instead, clone this repository and install its locked JavaScript
dependencies:

```sh
git clone https://github.com/miguelgarglez/video-digest.git
cd video-digest
bun install --frozen-lockfile
bun run video-digest --version
bun run video-digest --help
```

Commands elsewhere in this README use the installed command `video-digest`. From a
source checkout, replace that prefix with
`bun run video-digest`; for example, run `bun run video-digest doctor`.

After publication, confirm a global installation with:

```sh
video-digest --version
video-digest --help
```

Dependency installation has no `postinstall` setup step: it does not prepare Python or
install Transcript dependencies.

## First run

Start the guided terminal interface:

```sh
video-digest
```

On first run, choose an Artifact Library folder. The default is
`~/Documents/Video Digest`. The TUI then lets you create a Digest, retrieve a
Transcript, browse the Library, change settings, or run diagnostics.

Transcript capabilities require a one-time, explicit setup:

```sh
video-digest setup
```

Before making changes, setup explains that it may install an isolated Python 3.12
runtime and the locked Transcript dependencies, then asks for confirmation. For a
non-interactive session, consent must be explicit:

```sh
video-digest setup --yes
```

Setup uses the shipped `uv.lock` and replaces the managed runtime only after a
successful build. Normal commands never install or update Python dependencies.

Digest generation also needs an OpenCode API key. Store it securely with an
interactive prompt:

```sh
video-digest config set opencode-api-key
```

The key is stored in macOS Keychain under the `video-digest` service. It is not written
to the application configuration or printed by the CLI. You can then create a first
Digest:

```sh
video-digest ingest 'https://www.youtube.com/watch?v=1ZgUcrR0K7I'
```

Quote YouTube URLs in the shell because characters such as `?` and `&` have special
meaning in shells including zsh.

## Direct commands

The TUI is the primary human interface. Direct commands are stable for scripts and
advanced workflows:

```sh
# Create a Digest and all Transcript representations.
video-digest ingest '<youtube-url>'

# Also create a Markdown email preview.
video-digest ingest '<youtube-url>' --email-preview

# Retrieve the Transcript without requiring OpenCode.
video-digest transcript '<youtube-url>'

# Inspect and prepare local readiness.
video-digest doctor
video-digest setup

# Inspect configuration and manage the Artifact Library.
video-digest config get
video-digest config set output-dir '/absolute/path/to/Video Digest'

# Browse and open Library Entries.
video-digest list
video-digest open latest
video-digest open 1ZgUcrR0K7I
```

Use `video-digest <command> --help` for command-specific syntax.

Transcript presentation flags always write the Library Entry first:

```sh
video-digest transcript '<youtube-url>' --copy    # copy clean text to the clipboard
video-digest transcript '<youtube-url>' --open    # open the Markdown Transcript
video-digest transcript '<youtube-url>' --stdout  # print only clean text to stdout
```

`--stdout` disables progress output so it is safe in a pipeline. It cannot be combined
with `--json`. The `--copy` and `--open` actions are macOS-specific and never run in
JSON mode.

`ingest`, `transcript`, `list`, and `open` also accept
`--output-dir '/absolute/path'` for a one-command Artifact Library override.

## Artifact Library

Video Digest resolves the Artifact Library in this order, from highest to lowest
precedence:

1. `--output-dir <path>` for the current command;
2. `VIDEO_DIGEST_OUTPUT_DIR` for the current environment;
3. the path saved by `video-digest config set output-dir <path>`; and
4. `~/Documents/Video Digest`.

The flag and environment variable do not modify saved configuration. `config get`
shows both the effective path and its source. The TUI changes the saved location from
Setup & Settings.

Application state is kept separate from user content:

```text
Artifacts       ~/Documents/Video Digest (or your selected folder)
Configuration   ~/Library/Application Support/video-digest/config.json
Python runtime  ~/Library/Application Support/video-digest/runtime/python
Dependencies    uv's standard cache
Credential      macOS Keychain, service video-digest
```

Pre-release files under this repository's former `./outputs` folder are not migrated
automatically.

## Use with agents

Agents should use `--json`, which emits exactly one versioned JSON value to stdout and
sends diagnostics to stderr:

```sh
video-digest doctor --json
video-digest transcript '<youtube-url>' --json
video-digest ingest '<youtube-url>' --json
video-digest list --json
```

Automation must validate each command's own schema rather than assuming common fields:

- `doctor` returns `doctor-report.v0` with top-level `ok` and a `checks` array;
- `ingest` and `transcript` return `cli-result.v0`, where completed results contain
  `status` and artifact `paths`;
- `list` returns `library-list.v0` with an `items` array and no `status`; and
- `open` returns `open-result.v0` with Library Entry fields and `openPath` on success.

Consumers should also inspect the process exit status, reject unknown schema versions,
and never parse human output. The exact success and failure shapes are defined in the
[JSON contracts](docs/cli/json-contracts.md), with numeric meanings in the
[exit-code reference](docs/cli/exit-codes.md).

The `0.1.0` release also contains a portable, independently installed
[Video Digest agent skill](https://github.com/miguelgarglez/video-digest/blob/main/.agents/skills/video-digest/SKILL.md).
Review the source first, then copy the command you intend to run:

```bash
gh skill preview miguelgarglez/video-digest video-digest --allow-hidden-dirs
gh skill install miguelgarglez/video-digest video-digest --allow-hidden-dirs
```

The `.agents` directory is hidden, so both commands require `--allow-hidden-dirs`.
Use a GitHub CLI version that includes `gh skill`; some versions do not provide this
preview feature. Video Digest never installs or updates GitHub CLI. The TUI only
displays and copies these commands; it never runs them. Package installation also
never modifies an agent host.

## Privacy and security

Video Digest includes no telemetry and performs no automatic update checks. Network
access happens only for an operation you request:

- YouTube oEmbed metadata and Transcript retrieval while processing a video;
- Digest generation through OpenCode; or
- consented runtime preparation through `uv`.

Public metadata lookup is best-effort and needs no YouTube API key. A failed lookup
does not block processing. OpenCode credentials resolve from `OPENCODE_API_KEY` when
explicitly set in the environment, then from macOS Keychain. Credential values are
intentionally excluded from configuration files and the documented JSON contracts;
`config get` reports only whether and where a credential is configured. OpenCode HTTP
failures expose the HTTP status while redacting the remote response body.

Advanced environments can override the OpenCode endpoint with `OPENCODE_BASE_URL` and
the model with `OPENCODE_MODEL`. `VIDEO_DIGEST_OUTPUT_DIR` temporarily selects the
Artifact Library. These variables and the optional `OPENCODE_API_KEY` are the supported
CLI environment settings shown in [`.env.example`](.env.example).

`--json` is non-interactive: it never prompts, opens an application, copies to the
clipboard, animates, or performs setup.

## Troubleshooting

Start with the readiness report:

```sh
video-digest doctor
```

For machine-readable diagnostics:

```sh
video-digest doctor --json
```

Common remediations:

- **Transcript runtime is missing or obsolete:** run `video-digest setup` and approve
  the explained changes. In non-interactive use, rerun with `--yes` only after a human
  has authorized setup.
- **`uv` is missing:** install `uv`, ensure it is available on `PATH`, then rerun
  `doctor`. Video Digest does not install prerequisites silently.
- **Digest credential is missing:** run
  `video-digest config set opencode-api-key`, or use `transcript` when no Digest is
  needed.
- **Artifact Library is not writable:** choose another absolute path with
  `video-digest config set output-dir <path>` or use `--output-dir` temporarily.
- **The TUI cannot use the terminal:** resize the terminal or use direct commands. A
  non-TTY invocation without arguments prints help instead of launching full screen.

Machine error payloads and numeric meanings are documented in the
[exit-code reference](docs/cli/exit-codes.md).

## Development

Clone the repository on a supported Mac, then install JavaScript dependencies:

```sh
bun install
```

Run the source CLI and explicitly prepare its managed Transcript runtime:

```sh
bun run video-digest --help
bun run video-digest setup
```

Run the quality gates before contributing:

```sh
bun test
bun run typecheck
```

Implementation decisions live in [`docs/adr/`](docs/adr/), and the domain language is
defined in [`CONTEXT.md`](CONTEXT.md). Bug reports and contributions are welcome in
the [GitHub repository](https://github.com/miguelgarglez/video-digest).

## License

Video Digest is available under the [MIT License](LICENSE).
