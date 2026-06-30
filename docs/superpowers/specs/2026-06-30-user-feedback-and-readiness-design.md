# User feedback and sharing readiness

Status: Approved
Date: 2026-06-30

## Objective

Make the primary TUI easier to support and safer to share with new users. Users can
contact the maintainer by email or open a GitHub issue with useful, non-sensitive
technical context. The public documentation makes the current platform boundary clear
and mentions possible future expansion without implying a commitment.

This is a contained product-readiness pass. It does not reactivate the web interface,
add telemetry, or expand the supported platforms.

## Product principles

- Feedback remains user-initiated and reviewable before it is sent.
- Video Digest never sends feedback, diagnostics, or telemetry itself.
- Diagnostic context is built from an allowlist rather than by attempting to redact
  arbitrary application data.
- Help is available from the main navigation and near failed workflows.
- Current support limits are visible before installation.
- Future possibilities are distinguished from supported or scheduled work.

## TUI experience

### Main navigation

The home screen adds `Help & Feedback` as its sixth option, after `Diagnostics`. It is
a top-level destination rather than part of `Setup & Settings` because support is a
user task, not application configuration.

The new screen displays:

- the installed Video Digest version;
- the macOS version and process architecture;
- a short explanation of exactly what context will be included;
- `Send Feedback by Email`;
- `Report an Issue on GitHub`;
- fallback actions to copy the email address and GitHub issue URL.

The email destination is `miguel.garglez@gmail.com`. The GitHub destination is the new
issue form for `miguelgarglez/video-digest`.

Selecting either primary action asks macOS to open the generated external URL. Video
Digest does not submit the message. The user reviews, edits, and sends it in their mail
client or browser. If macOS cannot open the URL, the TUI reports the failure without
leaving the help screen and keeps the copy fallback available.

Back and quit behavior follows the existing TUI conventions. The screen must remain
usable at the current minimum supported terminal size.

### Failed workflows

User-visible failure states offer one `Get Help` action that opens the same Help &
Feedback screen. The screen records only that it was reached from a failed workflow;
it does not carry the raw error message.

Adding two provider-specific feedback actions to each failure state would make error
screens noisy. One route to a shared support screen keeps the recovery path consistent.

## Feedback content

Feedback payloads are produced by pure functions so their privacy boundary and URL
encoding can be tested independently from rendering and macOS integration.

### Allowlisted context

The generated email and GitHub bodies include only:

- Video Digest version;
- macOS version;
- process architecture;
- entry context: `main menu` or `failed workflow`.

They also contain prompts for the user to describe what they were doing, what they
expected, and what happened. The email has a concise prefilled subject. The GitHub URL
prefills a concise title prefix and Markdown body.

The generated content must not include:

- paths, usernames, or the Artifact Library location;
- Video URLs or IDs;
- Digest or Transcript content;
- provider configuration, model selection, or credentials;
- environment variables;
- raw errors, logs, command arguments, or clipboard content.

Arbitrary errors are intentionally excluded instead of sanitized. Redaction is not a
reliable security boundary because an unfamiliar error format can contain an
unrecognized path, URL, or secret.

### Platform facts

Platform facts come from runtime APIs already available to the CLI. No new dependency
or shell command is needed. The implementation owns a small immutable support-context
value rather than letting the screen read global process state directly.

## Architecture

The change is split into three boundaries:

1. **Presentation**: the TUI model, transitions, screen copy, and actions for Help &
   Feedback.
2. **Feedback link builder**: pure functions that accept allowlisted support context
   and return encoded `mailto:` and HTTPS URLs.
3. **System action**: a port that asks macOS to open an external URL and reports success
   or failure through the existing effect loop.

The new external-URL action must validate its scheme against an explicit allowlist:
`mailto:` for email and `https:` for GitHub. It must not accept a shell fragment or
construct a shell command. Values are passed as separate process arguments, matching
the existing system-action safety model.

The TUI state records the help origin as `main` or `failure`. It does not retain a raw
failure value for feedback. Pending external actions use the existing request-ID
discipline so late completions cannot overwrite newer state.

## Documentation

### Public documentation

The README should state before installation that the current supported platform is
macOS on Apple Silicon. Existing detailed compatibility documentation remains the
normative contract.

A short `Future possibilities` paragraph may mention a web interface and support for
Windows or Linux. It must not include dates, promises, implementation detail, the cloud
IP limitation, or proxy discussion.

The repository adds a simple GitHub bug-report template that asks for reproduction
steps, expected behavior, actual behavior, and the allowlisted platform context. It
warns users not to paste API keys, private artifacts, or sensitive paths.

### Internal web status

`docs/internal/web-interface-status.md` records that the existing web interface is
paused. It explains that YouTube commonly rejects Transcript retrieval from cloud
provider IPs, proxy use would introduce recurring cost and operational complexity, and
the project is not accepting that trade-off now.

The note defines reevaluation conditions rather than presenting the pause as permanent:

- a reliable no-cost or acceptably priced retrieval path becomes available;
- the project has a local or user-operated execution design that avoids cloud-IP
  blocking; or
- demand justifies the cost and maintenance of a proxy strategy.

This internal explanation is versioned in the repository but is not linked from the
README and is not included in the npm package's current `files` allowlist.

## Error handling

- Failure to open an email client or browser produces a concise TUI error and leaves
  copy actions available.
- Failure to copy a fallback link uses the existing system-action error behavior.
- Missing or unexpected platform facts fall back to `unknown`; they do not block the
  help screen.
- URL construction is deterministic and cannot fail for valid allowlisted context.
- No network request is made when rendering the screen or constructing feedback.

## Verification

Automated coverage includes:

- navigation to Help & Feedback from home and back;
- navigation from a failed workflow without retaining its raw error;
- screen content, action order, footer behavior, and small-terminal behavior;
- correct RFC-compliant encoding of the email and GitHub URLs;
- exact inclusion of every allowlisted context field;
- absence of representative paths, Video URLs, credentials, and artifact content;
- allowed and rejected external URL schemes;
- successful and failed external-open effects, including stale request completion;
- fallback copy actions;
- the README support statement, future-possibilities wording, internal status note,
  and GitHub issue template;
- the existing complete test and type-check suites.

No live email, browser submission, GitHub issue creation, proxy request, or paid service
is used by automated tests.

## Non-goals

- Automatically sending email or creating GitHub issues.
- Telemetry, analytics, crash reporting, or log upload.
- Attaching raw diagnostics or user artifacts.
- An automatic update check.
- Redesigning onboarding or adding a general About screen.
- Reactivating, deploying, or deleting the current web interface.
- Configuring or paying for Transcript proxies.
- Supporting macOS Intel, Windows, or Linux.
- Promising a roadmap or delivery date for future platforms or interfaces.
