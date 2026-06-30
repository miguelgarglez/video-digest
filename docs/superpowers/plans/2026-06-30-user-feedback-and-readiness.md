# User Feedback and Sharing Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-preserving email and GitHub feedback flows to the TUI, make help reachable after failures, and clarify sharing readiness in repository documentation.

**Architecture:** A focused TUI feedback module owns allowlisted support context and pure URL construction. The existing Elm-style model/update/controller loop owns navigation and effects, while the macOS system-actions adapter validates and opens external URLs without invoking a shell. Documentation records public platform limits separately from the internal reason the web interface is paused.

**Tech Stack:** TypeScript 6, Bun 1.3, OpenTUI, macOS `/usr/bin/open` and `/usr/bin/sw_vers`, Bun test runner, Markdown.

---

## File map

- Create `src/tui/feedback.ts`: support-context types, macOS version lookup, and pure email/GitHub URL construction.
- Create `src/tui/feedback.test.ts`: URL encoding, allowlist, fallback, and privacy tests.
- Modify `src/cli/system-actions.ts`: validate and open feedback URLs through `/usr/bin/open`.
- Modify `src/cli/system-actions.test.ts`: external-URL allowlist and process-argument tests.
- Modify `src/tui/model.ts`: Help & Feedback state, events, effects, and support context.
- Modify `src/tui/update.ts`: navigation, feedback effects, stale-result fencing, and failure-help origin.
- Modify `src/tui/update.test.ts`: reducer tests for the new state machine paths.
- Modify `src/tui/screens.ts`: home option, Help & Feedback screen, fallback actions, and F1 help affordance.
- Modify `src/tui/screens.test.ts`: view content, privacy, order, and minimum-size tests.
- Modify `src/tui/renderer.ts`: dispatch F1 help and feedback screen actions.
- Modify `src/tui/renderer.test.ts`: keyboard and selection translation tests.
- Modify `src/tui/ports.ts`: narrow external-open capability.
- Modify `src/tui/controller.ts`: execute external-open effects through the port.
- Modify `src/tui/controller.test.ts`: success, failure, and stale-completion tests.
- Modify `src/tui/default-ports.ts`: resolve production support context once and wire system actions.
- Modify `src/tui/default-ports.test.ts`: injected platform lookup and port wiring tests.
- Modify TUI test helpers that construct `TuiPorts`: add the required `openExternal` fake.
- Modify `README.md`: prominent support boundary and understated future possibilities.
- Create `docs/internal/web-interface-status.md`: non-publicly-linked engineering status and reevaluation conditions.
- Create `.github/ISSUE_TEMPLATE/bug_report.md`: safe, actionable bug-report prompts.
- Create `src/cli/user-readiness-docs.test.ts`: repository-document contract tests.

### Task 1: Build allowlisted feedback context and links

**Files:**
- Create: `src/tui/feedback.ts`
- Create: `src/tui/feedback.test.ts`

- [ ] **Step 1: Write failing pure-link and platform-context tests**

Create `src/tui/feedback.test.ts` with deterministic values and an injected command runner:

```ts
import { describe, expect, test } from "bun:test";
import {
  FEEDBACK_EMAIL,
  buildFeedbackLinks,
  resolveSupportContext,
  type SupportContext,
} from "./feedback";

const context: SupportContext = {
  appVersion: "1.0.0 beta",
  architecture: "arm64/test",
  macOSVersion: "26.5.1",
};

describe("buildFeedbackLinks", () => {
  test("encodes reviewable email and GitHub drafts from allowlisted context", () => {
    const links = buildFeedbackLinks(context, "failed-workflow");
    const email = new URL(links.email);
    const issue = new URL(links.githubIssue);

    expect(email.protocol).toBe("mailto:");
    expect(email.pathname).toBe(FEEDBACK_EMAIL);
    expect(email.searchParams.get("subject")).toBe("Video Digest feedback");
    expect(email.searchParams.get("body")).toContain("Video Digest: 1.0.0 beta");
    expect(email.searchParams.get("body")).toContain("Opened from: Failed workflow");
    expect(issue.origin).toBe("https://github.com");
    expect(issue.pathname).toBe("/miguelgarglez/video-digest/issues/new");
    expect(issue.searchParams.get("title")).toBe("[Bug] ");
    expect(issue.searchParams.get("body")).toContain("Architecture: arm64/test");
  });

  test("never derives feedback from arbitrary application data", () => {
    const serialized = JSON.stringify(buildFeedbackLinks(context, "main-menu"));
    expect(serialized).not.toContain("/Users/miguel");
    expect(serialized).not.toContain("youtube.com");
    expect(serialized).not.toContain("API_KEY");
    expect(serialized).not.toContain("transcript");
  });
});

describe("resolveSupportContext", () => {
  test("reads the macOS product version through the injected native runner", async () => {
    const commands: readonly string[][] = [];
    const result = await resolveSupportContext({
      appVersion: "1.0.0",
      architecture: "arm64",
      run: async (command) => {
        (commands as string[][]).push([...command]);
        return { exitCode: 0, stderr: "", stdout: "26.5.1\n" };
      },
    });
    expect(commands).toEqual([["/usr/bin/sw_vers", "-productVersion"]]);
    expect(result).toEqual({ appVersion: "1.0.0", architecture: "arm64", macOSVersion: "26.5.1" });
  });

  test("falls back to unknown for failed or malformed product-version lookups", async () => {
    for (const run of [
      async () => ({ exitCode: 1, stderr: "private failure", stdout: "" }),
      async () => { throw new Error("private failure"); },
      async () => ({ exitCode: 0, stderr: "", stdout: "26.5.1\nextra" }),
    ]) {
      await expect(resolveSupportContext({ appVersion: "1.0.0", architecture: "arm64", run }))
        .resolves.toEqual({ appVersion: "1.0.0", architecture: "arm64", macOSVersion: "unknown" });
    }
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `bun test src/tui/feedback.test.ts`

Expected: FAIL because `./feedback` does not exist.

- [ ] **Step 3: Implement the focused feedback module**

Create `src/tui/feedback.ts`:

```ts
import type { SpawnCommand } from "../cli/system-actions";
import { spawnCommand } from "../cli/system-actions";

export const FEEDBACK_EMAIL = "miguel.garglez@gmail.com";
export const GITHUB_ISSUES_URL = "https://github.com/miguelgarglez/video-digest/issues";

export type FeedbackOrigin = "failed-workflow" | "main-menu";
export type SupportContext = Readonly<{
  appVersion: string;
  architecture: string;
  macOSVersion: string;
}>;
export type FeedbackLinks = Readonly<{ email: string; githubIssue: string }>;

type ContextInput = Readonly<{
  appVersion: string;
  architecture: string;
  run?: SpawnCommand;
}>;

export async function resolveSupportContext(input: ContextInput): Promise<SupportContext> {
  let macOSVersion = "unknown";
  try {
    const result = await (input.run ?? spawnCommand)(["/usr/bin/sw_vers", "-productVersion"]);
    const candidate = result.stdout.trim();
    if (result.exitCode === 0 && /^\d+(?:\.\d+){1,2}$/.test(candidate)) macOSVersion = candidate;
  } catch {
    // Support context is optional and must never block TUI startup.
  }
  return { appVersion: safeFact(input.appVersion), architecture: safeFact(input.architecture), macOSVersion };
}

export function buildFeedbackLinks(context: SupportContext, origin: FeedbackOrigin): FeedbackLinks {
  const body = feedbackBody(context, origin);
  const email = new URL(`mailto:${FEEDBACK_EMAIL}`);
  email.searchParams.set("subject", "Video Digest feedback");
  email.searchParams.set("body", body);

  const githubIssue = new URL(`${GITHUB_ISSUES_URL}/new`);
  githubIssue.searchParams.set("title", "[Bug] ");
  githubIssue.searchParams.set("body", body);
  return { email: email.toString(), githubIssue: githubIssue.toString() };
}

function feedbackBody(context: SupportContext, origin: FeedbackOrigin): string {
  return [
    "What were you trying to do?",
    "",
    "What did you expect?",
    "",
    "What happened?",
    "",
    "Technical context (generated by Video Digest):",
    `- Video Digest: ${safeFact(context.appVersion)}`,
    `- macOS: ${safeFact(context.macOSVersion)}`,
    `- Architecture: ${safeFact(context.architecture)}`,
    `- Opened from: ${origin === "failed-workflow" ? "Failed workflow" : "Main menu"}`,
    "",
    "Do not include API keys, private artifacts, or sensitive paths.",
  ].join("\n");
}

function safeFact(value: string): string {
  const candidate = value.trim();
  return candidate.length > 0 && candidate.length <= 80 && !/[\r\n]/.test(candidate) ? candidate : "unknown";
}
```

Update `SpawnResult` in `src/cli/system-actions.ts` to include `stdout: string`, make
`spawnCommand` pipe and collect stdout, and update existing fake results in
`src/cli/system-actions.test.ts` from `{ exitCode, stderr }` to
`{ exitCode, stderr, stdout: "" }`.

- [ ] **Step 4: Run the focused tests**

Run: `bun test src/tui/feedback.test.ts src/cli/system-actions.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the feedback primitives**

```bash
git add src/tui/feedback.ts src/tui/feedback.test.ts src/cli/system-actions.ts src/cli/system-actions.test.ts
git commit -m "feat(tui): Build feedback drafts"
```

### Task 2: Add a safe external-URL system action

**Files:**
- Modify: `src/cli/system-actions.ts`
- Modify: `src/cli/system-actions.test.ts`

- [ ] **Step 1: Write failing URL-validation tests**

Add imports for `openExternalUrl` and these tests to `src/cli/system-actions.test.ts`:

```ts
test("opens only approved feedback URL shapes as separate process arguments", async () => {
  const commands: readonly string[][] = [];
  const spawn: SpawnCommand = async (command) => {
    (commands as string[][]).push([...command]);
    return { exitCode: 0, stderr: "", stdout: "" };
  };

  await openExternalUrl("mailto:miguel.garglez@gmail.com?subject=Video%20Digest", spawn);
  await openExternalUrl("https://github.com/miguelgarglez/video-digest/issues/new?title=%5BBug%5D", spawn);

  expect(commands).toEqual([
    ["/usr/bin/open", "mailto:miguel.garglez@gmail.com?subject=Video%20Digest"],
    ["/usr/bin/open", "https://github.com/miguelgarglez/video-digest/issues/new?title=%5BBug%5D"],
  ]);
});

test("rejects shells, files, foreign hosts, and misleading GitHub paths before spawning", async () => {
  let calls = 0;
  const spawn: SpawnCommand = async () => {
    calls += 1;
    return { exitCode: 0, stderr: "", stdout: "" };
  };
  for (const url of [
    "file:///Users/test/private",
    "javascript:alert(1)",
    "https://example.com/miguelgarglez/video-digest/issues/new",
    "https://github.com/another/repository/issues/new",
    "mailto:another@example.com",
  ]) {
    await expect(openExternalUrl(url, spawn)).rejects.toMatchObject({ code: "open-failed" });
  }
  expect(calls).toBe(0);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `bun test src/cli/system-actions.test.ts`

Expected: FAIL because `openExternalUrl` is not exported.

- [ ] **Step 3: Implement strict external opening**

Extend `SystemActions` with `openExternal(url: string): Promise<void>`, add the method
to `createMacOSSystemActions`, and add:

```ts
export async function openExternalUrl(url: string, spawn: SpawnCommand = spawnCommand): Promise<void> {
  if (!isApprovedFeedbackUrl(url)) {
    throw new SystemActionError("open-failed", "Could not open the feedback destination. Copy the link instead.");
  }
  await execute(["/usr/bin/open", url], {}, spawn, new SystemActionError(
    "open-failed",
    "Could not open the feedback destination. Copy the link instead.",
  ));
}

function isApprovedFeedbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "mailto:") return url.pathname === "miguel.garglez@gmail.com";
    return url.protocol === "https:" && url.hostname === "github.com" &&
      url.pathname === "/miguelgarglez/video-digest/issues/new";
  } catch {
    return false;
  }
}
```

Change the generic copy failure text to `Could not copy the text. Copy it manually
and try again.` because the capability now also copies feedback links.

- [ ] **Step 4: Run system-action tests**

Run: `bun test src/cli/system-actions.test.ts`

Expected: PASS, including the existing backpressure and error-normalization cases.

- [ ] **Step 5: Commit the system boundary**

```bash
git add src/cli/system-actions.ts src/cli/system-actions.test.ts
git commit -m "feat(cli): Open safe feedback links"
```

### Task 3: Extend the TUI state machine

**Files:**
- Modify: `src/tui/model.ts`
- Modify: `src/tui/update.ts`
- Modify: `src/tui/update.test.ts`

- [ ] **Step 1: Write failing reducer tests for navigation and effects**

Add to `src/tui/update.test.ts`:

```ts
describe("Help & Feedback", () => {
  test("opens from Home with allowlisted context and returns Home", () => {
    const home = readyModel({
      supportContext: { appVersion: "1.0.0", architecture: "arm64", macOSVersion: "26.5.1" },
    });
    const help = update(home, { type: "open-help" }).model;
    expect(help).toMatchObject({ helpOrigin: "main-menu", helpReturnScreen: "home", screen: "help-feedback" });
    expect(update(help, { type: "back" }).model.screen).toBe("home");
  });

  test("opens from a failed workflow without carrying its error into feedback", () => {
    const failed = readyModel({
      creationMode: "transcript",
      message: "Private failure at /Users/test and https://youtu.be/abc123_DEF4",
      screen: "enter-url",
    });
    const help = update(failed, { type: "open-help" }).model;
    expect(help).toMatchObject({ helpOrigin: "failed-workflow", helpReturnScreen: "enter-url", message: null });
    expect(JSON.stringify(help)).not.toContain("Private failure");
  });

  test("starts external opening and fences stale completion", () => {
    const help = readyModel({ screen: "help-feedback" });
    const opening = update(help, { type: "open-external-url", url: "mailto:miguel.garglez@gmail.com" });
    expect(opening.effects).toEqual([{ requestId: 1, type: "open-external", url: "mailto:miguel.garglez@gmail.com" }]);
    expect(opening.model.pending).toEqual({ kind: "open-external", requestId: 1 });
    const dismissed = update(opening.model, { type: "back" }).model;
    expect(update(dismissed, { requestId: 1, type: "system-action-failed", message: "late" }).model).toBe(dismissed);
  });
});
```

- [ ] **Step 2: Run the reducer test and verify type failures**

Run: `bun test src/tui/update.test.ts`

Expected: FAIL because the Help & Feedback state and events are not defined.

- [ ] **Step 3: Add model types and defaults**

In `src/tui/model.ts`:

```ts
import type { FeedbackOrigin, SupportContext } from "./feedback";

export type Screen =
  | "choose-library"
  | "home"
  | "enter-url"
  | "runtime-required"
  | "credential-required"
  | "progress"
  | "result"
  | "reader"
  | "library"
  | "settings"
  | "provider-settings"
  | "model-settings"
  | "doctor"
  | "agent-skill"
  | "help-feedback";

export type HelpReturnScreen = Exclude<Screen, "help-feedback">;
```

Add `open-external` to `PendingKind`, and add these fields to `Model`:

```ts
helpOrigin: FeedbackOrigin;
helpReturnScreen: HelpReturnScreen;
supportContext: SupportContext;
```

Add `supportContext?: SupportContext` to `InitialModelInput`, and initialize with:

```ts
helpOrigin: "main-menu",
helpReturnScreen: "home",
supportContext: input.supportContext ?? {
  appVersion: "unknown",
  architecture: "unknown",
  macOSVersion: "unknown",
},
```

Add events and effect:

```ts
| { type: "open-help" }
| { type: "open-external-url"; url: string }

| { type: "open-external"; requestId: RequestId; url: string }
```

- [ ] **Step 4: Implement reducer transitions and pending policy**

In `src/tui/update.ts`, add cases:

```ts
case "open-help": {
  if (model.pending || model.screen === "help-feedback") return unchanged(model);
  const failed = model.message !== null;
  return transition({
    ...model,
    helpOrigin: failed ? "failed-workflow" : "main-menu",
    helpReturnScreen: model.screen,
    message: null,
    screen: "help-feedback",
  });
}
case "open-external-url":
  return model.screen === "help-feedback" && event.url.length > 0
    ? startRequest(model, "open-external", (requestId) => ({ requestId, type: "open-external", url: event.url }))
    : unchanged(model);
```

Include `open-external` in `isSystemActionKind()` and the dismissible branch of
`pendingPolicy()`. In `navigateBack()`, add:

```ts
case "help-feedback":
  return transition(clearPending({ ...model, message: null, screen: model.helpReturnScreen }));
```

Reset `helpOrigin` and `helpReturnScreen` in `goHome()` so abandoned failure context
does not leak into later help visits.

- [ ] **Step 5: Run reducer tests**

Run: `bun test src/tui/update.test.ts`

Expected: PASS. Full type checking follows after Tasks 4 and 5 complete the exhaustive
screen and effect integrations.

- [ ] **Step 6: Review the uncommitted state-machine diff**

```bash
git diff --check -- src/tui/model.ts src/tui/update.ts src/tui/update.test.ts
```

Expected: exit status 0. Keep these changes uncommitted until Task 5 completes the
exhaustive controller and presentation integration, so no intermediate commit breaks
the repository type check.

### Task 4: Render and dispatch Help & Feedback

**Files:**
- Modify: `src/tui/screens.ts`
- Modify: `src/tui/screens.test.ts`
- Modify: `src/tui/renderer.ts`
- Modify: `src/tui/renderer.test.ts`

- [ ] **Step 1: Write failing screen tests**

Update the expected Home options in `src/tui/screens.test.ts` to append
`"Help & Feedback"`, then add:

```ts
test("Help & Feedback exposes reviewable destinations and copy fallbacks", () => {
  const view = buildScreenView(readyModel({
    helpOrigin: "failed-workflow",
    screen: "help-feedback",
    supportContext: { appVersion: "1.0.0", architecture: "arm64", macOSVersion: "26.5.1" },
  }));
  expect(view).toMatchObject({
    focus: "options",
    options: [
      "Send Feedback by Email",
      "Report an Issue on GitHub",
      "Copy Email Address",
      "Copy GitHub Issue Link",
    ],
    title: "Help & Feedback",
  });
  expect(view.body.join(" ")).toContain("Video Digest 1.0.0");
  expect(view.body.join(" ")).toContain("macOS 26.5.1 · arm64");
  expect(JSON.stringify(view)).not.toContain("/Users/");
});

test("a settled failure advertises F1 help without replacing input focus", () => {
  const view = buildScreenView(readyModel({ message: "Creation failed.", screen: "enter-url" }));
  expect(view.focus).toBe("input");
  expect(view.helpAvailable).toBe(true);
  expect(view.footer).toContain("F1 Get Help");
});
```

- [ ] **Step 2: Write the failing renderer keyboard test**

In `src/tui/renderer.test.ts`, use the existing fake facade to render a model with a
settled error, invoke its `onKey({ name: "f1", ctrl: false, meta: false, shift: false })`,
and assert:

```ts
expect(events).toContainEqual({ type: "open-help" });
```

Also select all four Help & Feedback options and assert that the first two dispatch
`open-external-url`, while the last two dispatch `copy-text` with the displayed email
address and generated GitHub URL.

- [ ] **Step 3: Run both focused tests and verify failures**

Run: `bun test src/tui/screens.test.ts src/tui/renderer.test.ts`

Expected: FAIL on the missing screen, `helpAvailable`, and actions.

- [ ] **Step 4: Implement the view contract and feedback screen**

In `src/tui/screens.ts`, import the feedback builders, add
`helpAvailable: boolean` to `ScreenView`, and extend `ScreenAction`:

```ts
| { type: "open-help" }
| { type: "open-external-url"; url: string };
```

Compute `helpAvailable` in `buildScreenView` as:

```ts
const helpAvailable = !pending && model.message !== null && model.screen !== "help-feedback";
```

When true, append `F1 Get Help` to the footer and `{ key: "F1", label: "Get Help" }`
to the accessibility keys without changing the current focus. Add the sixth Home
action/option, then add:

```ts
case "help-feedback": {
  const links = buildFeedbackLinks(model.supportContext, model.helpOrigin);
  return {
    actions: [
      { type: "open-external-url", url: links.email },
      { type: "open-external-url", url: links.githubIssue },
      { type: "copy-text", text: FEEDBACK_EMAIL },
      { type: "copy-text", text: links.githubIssue },
    ],
    body: [
      `Video Digest ${model.supportContext.appVersion}`,
      `macOS ${model.supportContext.macOSVersion} · ${model.supportContext.architecture}`,
      "The draft includes only the technical context shown above. Review it before sending.",
      "Video Digest never sends feedback automatically.",
    ],
    bodyLinks: [
      { text: FEEDBACK_EMAIL, url: links.email },
      { text: GITHUB_ISSUES_URL, url: GITHUB_ISSUES_URL },
    ],
    options: [
      "Send Feedback by Email",
      "Report an Issue on GitHub",
      "Copy Email Address",
      "Copy GitHub Issue Link",
    ],
    title: "Help & Feedback",
  };
}
```

- [ ] **Step 5: Dispatch F1 without interfering with text input**

In `src/tui/renderer.ts`, add this before Escape handling in `handleKey`:

```ts
if (!key.ctrl && !key.meta && !key.shift && name === "f1" && view.helpAvailable) {
  void dispatch({ type: "open-help" }).catch(() => undefined);
  return true;
}
```

No printable key is reserved, so URL, model, path, and credential inputs remain
unchanged.

- [ ] **Step 6: Run view, renderer, and native minimum-size tests**

Run: `bun test src/tui/screens.test.ts src/tui/renderer.test.ts src/tui/renderer-native.test.ts`

Expected: PASS, including the existing 60x18 layout assertion.

- [ ] **Step 7: Review the uncommitted presentation diff**

```bash
git diff --check -- src/tui/screens.ts src/tui/screens.test.ts src/tui/renderer.ts src/tui/renderer.test.ts
```

Expected: exit status 0. Keep these changes with the state-machine work for the stable
integration commit in Task 5.

### Task 5: Wire effects and production support context

**Files:**
- Modify: `src/tui/ports.ts`
- Modify: `src/tui/controller.ts`
- Modify: `src/tui/controller.test.ts`
- Modify: `src/tui/default-ports.ts`
- Modify: `src/tui/default-ports.test.ts`
- Modify: `src/tui/controller-hardening.test.ts`
- Modify: `src/tui/start.test.ts`

- [ ] **Step 1: Write failing controller tests for external opening**

Extend the `system` fake in `src/tui/controller.test.ts` with
`openExternal: async () => undefined`, then add:

```ts
test("opens feedback externally and normalizes failure without leaking it", async () => {
  const opened: string[] = [];
  const controller = createTuiController(homeModel({ screen: "help-feedback" }), fakePorts({
    system: {
      copy: async () => undefined,
      openExternal: async (url) => { opened.push(url); },
    },
  }));
  await controller.dispatch({ type: "open-external-url", url: "mailto:miguel.garglez@gmail.com" });
  expect(opened).toEqual(["mailto:miguel.garglez@gmail.com"]);
  expect(controller.getModel().pending).toBeNull();

  const failing = createTuiController(homeModel({ screen: "help-feedback" }), fakePorts({
    system: {
      copy: async () => undefined,
      openExternal: async () => { throw new Error("private service detail"); },
    },
  }));
  await failing.dispatch({ type: "open-external-url", url: "https://github.com/miguelgarglez/video-digest/issues/new" });
  expect(failing.getModel().message).toBe("Could not open the feedback destination. Copy the link instead.");
  expect(JSON.stringify(failing.getModel())).not.toContain("private service detail");
});
```

- [ ] **Step 2: Write failing default-session tests**

In `src/tui/default-ports.test.ts`, inject a `supportContextResolver` returning
`{ appVersion: "test", architecture: "arm64", macOSVersion: "26.5.1" }` and assert the
bootstrap model stores that exact value. Extend injected `systemActions` with an
`openExternal` spy and assert `session.ports.system.openExternal(url)` delegates once.

- [ ] **Step 3: Run focused tests and verify failures**

Run: `bun test src/tui/controller.test.ts src/tui/default-ports.test.ts`

Expected: FAIL because the new port and controller effect are not wired.

- [ ] **Step 4: Extend the narrow port and controller**

Change `TuiPorts.system` in `src/tui/ports.ts` to:

```ts
system: Pick<SystemActions, "copy" | "openExternal">;
```

In `executeOwnedEffect()` in `src/tui/controller.ts`, add:

```ts
case "open-external":
  try {
    await ports.system.openExternal(effect.url);
    await emit({ requestId: effect.requestId, type: "system-action-completed" });
  } catch {
    await emit({
      message: "Could not open the feedback destination. Copy the link instead.",
      requestId: effect.requestId,
      type: "system-action-failed",
    });
  }
  return;
```

Update every `TuiPorts` test fake to include `openExternal: async () => undefined`.
Do not cast around the missing capability.

- [ ] **Step 5: Resolve support context once during bootstrap**

In `src/tui/default-ports.ts`, import `arch` from `node:os`, `VIDEO_DIGEST_VERSION`,
and `resolveSupportContext`. Add this dependency seam:

```ts
supportContextResolver?: typeof resolveSupportContext;
```

During `createDefaultTuiSession`, resolve it alongside readiness and credentials:

```ts
const [runtimeReadiness, credentials, supportContext] = await Promise.all([
  safeRuntimeReadiness(runtime),
  safeCredentials(env, credentialStore),
  (dependencies.supportContextResolver ?? resolveSupportContext)({
    appVersion: VIDEO_DIGEST_VERSION,
    architecture: arch(),
  }),
]);
```

Pass `supportContext` to `initialModel`, and expose:

```ts
system: { copy: systemActions.copy, openExternal: systemActions.openExternal },
```

- [ ] **Step 6: Run controller, bootstrap, hardening, and startup tests**

Run: `bun test src/tui/controller.test.ts src/tui/controller-hardening.test.ts src/tui/default-ports.test.ts src/tui/start.test.ts`

Expected: PASS. The hardening tests must continue to prove effects cannot be injected
directly into the controller.

- [ ] **Step 7: Commit the effect wiring**

```bash
git add src/tui/model.ts src/tui/update.ts src/tui/update.test.ts src/tui/screens.ts src/tui/screens.test.ts src/tui/renderer.ts src/tui/renderer.test.ts src/tui/ports.ts src/tui/controller.ts src/tui/controller.test.ts src/tui/default-ports.ts src/tui/default-ports.test.ts src/tui/controller-hardening.test.ts src/tui/start.test.ts
git commit -m "feat(tui): Open feedback destinations"
```

### Task 6: Document sharing readiness and paused web work

**Files:**
- Modify: `README.md`
- Create: `docs/internal/web-interface-status.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.md`
- Create: `src/cli/user-readiness-docs.test.ts`

- [ ] **Step 1: Write failing repository-document tests**

Create `src/cli/user-readiness-docs.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("user-readiness documentation", () => {
  test("states support before installation and keeps future work non-committal", async () => {
    const readme = await readFile("README.md", "utf8");
    const support = readme.indexOf("macOS on Apple Silicon");
    const install = readme.indexOf("## Install");
    expect(support).toBeGreaterThan(-1);
    expect(support).toBeLessThan(install);
    expect(readme).toContain("## Future possibilities");
    expect(readme).toContain("web interface");
    expect(readme).toContain("Windows and Linux");
    expect(readme).not.toContain("proxy");
    expect(readme).not.toContain("cloud-provider IPs");
  });

  test("keeps the web constraint internal and defines reevaluation conditions", async () => {
    const note = await readFile("docs/internal/web-interface-status.md", "utf8");
    expect(note).toContain("Status: Paused");
    expect(note).toContain("cloud-provider IPs");
    expect(note).toContain("recurring proxy cost");
    expect(note).toContain("## Reevaluation conditions");
  });

  test("asks for actionable bug reports without soliciting private data", async () => {
    const template = await readFile(".github/ISSUE_TEMPLATE/bug_report.md", "utf8");
    for (const heading of ["Steps to reproduce", "Expected behavior", "Actual behavior", "Technical context"]) {
      expect(template).toContain(`## ${heading}`);
    }
    expect(template).toContain("Do not include API keys");
    expect(template).toContain("Video Digest version");
    expect(template).toContain("macOS version");
    expect(template).toContain("Architecture");
  });
});
```

- [ ] **Step 2: Run the documentation test and verify missing-file failures**

Run: `bun test src/cli/user-readiness-docs.test.ts`

Expected: FAIL because the internal note, template, and future section do not exist.

- [ ] **Step 3: Update the README**

Keep the existing detailed `Status and support` wording. Immediately before the
installation commands, add:

```md
> **Supported platform:** macOS on Apple Silicon only. The current package does not
> support macOS Intel, Windows, or Linux.
```

Near the end of the README, before license/support links, add:

```md
## Future possibilities

A web interface and support for Windows and Linux are possible future directions.
They are not part of the current compatibility contract or a committed roadmap.
```

Do not mention cloud IPs, transcript-provider limitations, or proxies in the README.

- [ ] **Step 4: Write the internal web status note**

Create `docs/internal/web-interface-status.md`:

```md
# Web interface status

Status: Paused
Date: 2026-06-30

The code under `src/web/` is retained as an experimental adapter, but it is not an
active product surface. YouTube commonly blocks Transcript retrieval from
cloud-provider IPs. The upstream retrieval approach suggests proxy-based mitigation,
which would add recurring proxy cost and operational complexity.

The project is not accepting that cost and maintenance trade-off now. Do not present
the web interface as supported, deploy it as part of routine releases, or invest in
feature parity with the TUI while this status remains in effect.

## Reevaluation conditions

Reevaluate the web interface when at least one condition holds:

- a reliable no-cost or acceptably priced Transcript retrieval path is available;
- a local or user-operated execution design avoids cloud-IP blocking; or
- demonstrated demand justifies a maintained proxy strategy.

When work resumes, validate Transcript retrieval from the intended deployment
environment before investing in UI features.
```

- [ ] **Step 5: Add the safe bug-report template**

Create `.github/ISSUE_TEMPLATE/bug_report.md`:

```md
---
name: Bug report
about: Report a reproducible Video Digest problem
title: "[Bug] "
labels: ""
assignees: ""
---

Do not include API keys, private Digest or Transcript content, Video URLs you cannot
share, or sensitive local paths.

## Steps to reproduce

1.

## Expected behavior


## Actual behavior


## Technical context

- Video Digest version:
- macOS version:
- Architecture:
```

- [ ] **Step 6: Run documentation and package-boundary tests**

Run: `bun test src/cli/user-readiness-docs.test.ts src/cli/package-metadata.test.ts scripts/verify-package.test.ts`

Expected: PASS. Confirm `docs/internal/web-interface-status.md` is not listed in the
npm package manifest produced by the package verification test.

- [ ] **Step 7: Commit documentation**

```bash
git add README.md docs/internal/web-interface-status.md .github/ISSUE_TEMPLATE/bug_report.md src/cli/user-readiness-docs.test.ts
git commit -m "docs: Clarify user readiness"
```

### Task 7: Complete regression verification

**Files:**
- Modify only files required to correct failures introduced by Tasks 1-6.

- [ ] **Step 1: Run formatting-independent repository checks**

Run: `git diff --check`

Expected: exit status 0 with no whitespace errors.

- [ ] **Step 2: Run the complete test suite**

Run: `bun test --pass-with-no-tests`

Expected: all tests PASS; no live browser, email, GitHub, YouTube, provider, proxy, or
paid-service call occurs.

- [ ] **Step 3: Run the TypeScript compiler**

Run: `bun run typecheck`

Expected: exit status 0 with no diagnostics.

- [ ] **Step 4: Verify the distributable package**

Run: `bun run verify:package`

Expected: package verification PASS, with the TUI feedback implementation included
and `docs/internal/web-interface-status.md` excluded by the existing package allowlist.

- [ ] **Step 5: Review privacy-sensitive output manually**

Run:

```bash
bun test src/tui/feedback.test.ts src/tui/screens.test.ts src/tui/controller.test.ts
rg -n "/Users/|youtube\.com|API_KEY|artifactLibrary|cleanText" src/tui/feedback.ts
```

Expected: focused tests PASS; `rg` returns no matches from `src/tui/feedback.ts`.

- [ ] **Step 6: Confirm only intended files changed**

Run: `git status --short && git log --oneline --max-count=8`

Expected: only intentional task files are present. The pre-existing untracked
`package-lock.json` remains unmodified and uncommitted.

- [ ] **Step 7: Commit any verification-only correction**

If Steps 1-6 required a correction, stage only the affected tracked files and commit:

```bash
git commit -m "fix(tui): Complete feedback verification"
```

If no correction was required, do not create an empty commit.
