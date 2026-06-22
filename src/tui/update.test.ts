import { describe, expect, test } from "bun:test";
import type { LibraryEntry } from "../cli/artifacts";
import { initialModel, type Model, type ResultData } from "./model";
import { update } from "./update";

const entry: LibraryEntry = {
  channel: "Example Channel",
  paths: {
    digestPath: "/library/digests/abc123_DEF4.md",
    emailPreviewPath: null,
    metadataPath: "/library/metadata/abc123_DEF4.json",
    transcriptJsonPath: "/library/transcripts/abc123_DEF4.json",
    transcriptMarkdownPath: "/library/transcripts/abc123_DEF4.md",
    transcriptTextPath: "/library/transcripts/abc123_DEF4.txt",
  },
  title: "Example video",
  updatedAt: "2026-06-22T10:00:00.000Z",
  videoId: "abc123_DEF4",
};

const transcriptResult: ResultData = {
  cleanText: "A clean transcript.",
  entry,
  kind: "transcript",
};

function readyModel(overrides: Partial<Model> = {}): Model {
  return {
    ...initialModel({
      artifactLibrary: "/library",
      credentialConfigured: true,
      runtimeReadiness: { status: "ready" },
    }),
    ...overrides,
  };
}

describe("initialModel", () => {
  test("starts first-run onboarding when no library is configured", () => {
    expect(initialModel({ artifactLibrary: null })).toMatchObject({
      librarySelectionOrigin: "onboarding",
      screen: "choose-library",
    });
  });

  test("starts at home when the Artifact Library is configured", () => {
    expect(initialModel({ artifactLibrary: "/library" })).toMatchObject({
      config: { artifactLibrary: "/library" },
      screen: "home",
    });
  });
});

describe("progressive creation gates", () => {
  test("requests runtime setup only when creation needs Transcript capability", () => {
    const model = readyModel({ runtimeReadiness: { status: "missing", remediation: "Run setup" } });

    expect(update(model, { type: "choose-transcript" })).toEqual({
      effects: [],
      model: expect.objectContaining({ creationMode: "transcript", screen: "runtime-required" }),
    });
  });

  test("requests credentials only after Digest runtime readiness", () => {
    const model = readyModel({ credentialConfigured: false });

    expect(update(model, { type: "choose-digest" })).toEqual({
      effects: [],
      model: expect.objectContaining({ creationMode: "digest", screen: "credential-required" }),
    });
  });

  test("continues from runtime setup to the next capability gate", () => {
    const model = readyModel({
      creationMode: "digest",
      credentialConfigured: false,
      runtimeReadiness: { status: "missing", remediation: "Run setup" },
      screen: "runtime-required",
    });

    const preparing = update(model, { type: "prepare-runtime" });
    expect(update(preparing.model, { requestId: 1, type: "runtime-ready" }).model).toMatchObject({
      runtimeReadiness: { status: "ready" },
      screen: "credential-required",
    });
  });

  test("enters URL input directly when the chosen mode is ready", () => {
    expect(update(readyModel(), { type: "choose-digest" })).toEqual({
      effects: [],
      model: expect.objectContaining({ creationMode: "digest", screen: "enter-url" }),
    });
  });

  test("emits setup and credential persistence only after explicit submission", () => {
    const runtimeModel = readyModel({ screen: "runtime-required" });
    expect(update(runtimeModel, { type: "prepare-runtime" })).toEqual({
      effects: [{ requestId: 1, type: "prepare-runtime" }],
      model: expect.objectContaining({ pending: { kind: "prepare-runtime", requestId: 1 } }),
    });

    const credentialModel = readyModel({ credentialConfigured: false, screen: "credential-required" });
    const transition = update(credentialModel, { type: "save-credential", value: "secret" });
    expect(transition.effects).toEqual([{ requestId: 1, type: "save-credential", value: "secret" }]);
    expect(transition.model.pending).toEqual({ kind: "save-credential", requestId: 1 });
  });
});

describe("creation and results", () => {
  test("validates URL input without starting work", () => {
    const model = readyModel({ creationMode: "transcript", screen: "enter-url" });

    expect(update(model, { type: "submit-url", url: "  " })).toEqual({
      effects: [],
      model: expect.objectContaining({ message: "Enter a YouTube URL.", screen: "enter-url" }),
    });
  });

  test("starts the selected operation and keeps progress low-density", () => {
    const model = readyModel({ creationMode: "transcript", screen: "enter-url" });

    expect(update(model, { type: "submit-url", url: "  https://youtu.be/abc123_DEF4  " })).toEqual({
      effects: [{ requestId: 1, type: "transcript", url: "https://www.youtube.com/watch?v=abc123_DEF4" }],
      model: expect.objectContaining({
        message: "Getting transcript…",
        progress: null,
        screen: "progress",
        submittedUrl: "https://www.youtube.com/watch?v=abc123_DEF4",
      }),
    });
  });

  test("tracks progress and exposes result data without an inline preview", () => {
    const progress = update(readyModel({ creationMode: "transcript", screen: "enter-url" }), {
      type: "submit-url",
      url: "https://youtu.be/abc123_DEF4",
    }).model;
    const tracked = update(progress, { message: "Fetching transcript", requestId: 1, type: "operation-progress" }).model;
    expect(tracked.progress).toBe("Fetching transcript");

    const completed = update(tracked, { requestId: 1, result: transcriptResult, type: "operation-succeeded" }).model;
    expect(completed).toMatchObject({ progress: null, result: transcriptResult, screen: "result" });
    expect(completed.reader).toBeNull();
  });

  test("returns a failed operation to URL input with actionable context", () => {
    const model = update(readyModel({ creationMode: "digest", screen: "enter-url" }), {
      type: "submit-url",
      url: "https://youtu.be/abc123_DEF4",
    }).model;

    expect(update(model, { message: "Transcript unavailable", requestId: 1, type: "operation-failed" }).model).toMatchObject({
      message: "Transcript unavailable",
      screen: "enter-url",
    });
  });

  test("emits result actions only when their data exists", () => {
    const model = readyModel({ result: transcriptResult, screen: "result" });

    expect(update(model, { type: "copy-result" }).effects).toEqual([
      { requestId: 1, text: "A clean transcript.", type: "copy" },
    ]);
    expect(update(model, { type: "print-result" }).effects).toEqual([
      { requestId: 1, text: "A clean transcript.", type: "print" },
    ]);
    expect(update(model, { type: "reveal-result" }).effects).toEqual([
      { path: "/library/transcripts/abc123_DEF4.md", requestId: 1, type: "reveal" },
    ]);

    const digestWithoutText = readyModel({
      result: { cleanText: null, entry, kind: "digest" },
      screen: "result",
    });
    expect(update(digestWithoutText, { type: "copy-result" }).effects).toEqual([]);
  });

  test("loads the human-readable artifact into a separate reader", () => {
    const model = readyModel({ result: transcriptResult, screen: "result" });

    expect(update(model, { type: "read-result" })).toEqual({
      effects: [{ path: "/library/transcripts/abc123_DEF4.md", requestId: 1, type: "read" }],
      model: expect.objectContaining({ readerOrigin: "result" }),
    });

    const reading = update(model, { type: "read-result" }).model;
    const loaded = update(reading, {
      content: "# Transcript",
      path: "/library/transcripts/abc123_DEF4.md",
      requestId: 1,
      title: "Example video",
      type: "reader-loaded",
    }).model;
    expect(loaded).toMatchObject({
      reader: { content: "# Transcript", path: "/library/transcripts/abc123_DEF4.md", title: "Example video" },
      screen: "reader",
    });
  });
});

describe("Library, Settings, diagnostics, and skill discovery", () => {
  test("loads Library Entries and retains the selected entry", () => {
    const home = readyModel();
    expect(update(home, { type: "browse-library" })).toEqual({
      effects: [{ requestId: 1, type: "load-library" }],
      model: expect.objectContaining({ entries: [], screen: "library", selectedEntry: null }),
    });

    const loading = update(readyModel(), { type: "browse-library" }).model;
    const loaded = update(loading, { entries: [entry], requestId: 1, type: "library-loaded" }).model;
    expect(update(loaded, { type: "select-entry", videoId: entry.videoId }).model.selectedEntry).toEqual(entry);
  });

  test("opens selected Library content in the reader and external applications explicitly", () => {
    const model = readyModel({ screen: "library", selectedEntry: entry });

    expect(update(model, { type: "read-entry" }).effects).toEqual([
      { path: "/library/digests/abc123_DEF4.md", requestId: 1, type: "read" },
    ]);
    expect(update(model, { type: "open-entry-externally" }).effects).toEqual([
      { path: "/library/digests/abc123_DEF4.md", requestId: 1, type: "open" },
    ]);
  });

  test("settings changes the library persistently and returns after save", () => {
    const settings = update(readyModel(), { type: "open-settings" }).model;
    expect(settings.screen).toBe("settings");

    const chooser = update(settings, { type: "change-library" }).model;
    expect(chooser).toMatchObject({ librarySelectionOrigin: "settings", screen: "choose-library" });
    const saving = update(chooser, { path: "/new-library", type: "save-library" });
    expect(saving.effects).toEqual([
      { path: "/new-library", requestId: 1, type: "save-library" },
    ]);

    expect(update(saving.model, { path: "/new-library", requestId: 1, type: "library-saved" }).model).toMatchObject({
      config: { artifactLibrary: "/new-library" },
      screen: "settings",
    });
  });

  test("runs diagnostics as an explicit effect and stores the report", () => {
    const transition = update(readyModel(), { type: "open-doctor" });
    expect(transition.effects).toEqual([{ requestId: 1, type: "run-doctor" }]);
    expect(transition.model.screen).toBe("doctor");

    const report = { checks: [], ok: true };
    expect(update(transition.model, { report, requestId: 1, type: "doctor-completed" }).model.doctorReport).toEqual(report);
  });

  test("skill discovery copies commands but never installs the skill", () => {
    const skill = update(readyModel({ screen: "settings" }), { type: "open-agent-skill" }).model;
    expect(skill.screen).toBe("agent-skill");
    expect(update(skill, { text: "gh skill preview owner/repo video-digest", type: "copy-text" }).effects).toEqual([
      { requestId: 1, text: "gh skill preview owner/repo video-digest", type: "copy" },
    ]);
  });
});

describe("navigation", () => {
  test("Escape returns from reader to its origin, then returns home", () => {
    const reader = readyModel({ readerOrigin: "library", screen: "reader" });
    expect(update(reader, { type: "back" }).model.screen).toBe("library");
    expect(update(readyModel({ screen: "library" }), { type: "back" }).model.screen).toBe("home");
  });

  test("Escape returns capability setup to Settings when Settings opened it", () => {
    const runtime = readyModel({ gateOrigin: "settings", screen: "runtime-required" });
    const credential = readyModel({ gateOrigin: "settings", screen: "credential-required" });

    expect(update(runtime, { type: "back" }).model.screen).toBe("settings");
    expect(update(credential, { type: "back" }).model.screen).toBe("settings");
  });

  test("Escape cancels progress before returning home", () => {
    const model = readyModel({
      creationMode: "transcript",
      nextRequestId: 2,
      pending: { kind: "transcript", requestId: 1 },
      screen: "progress",
    });
    expect(update(model, { type: "back" })).toEqual({
      effects: [{ requestId: 1, type: "cancel-operation" }],
      model: expect.objectContaining({ screen: "home" }),
    });
  });

  test("Home is a universal explicit navigation event", () => {
    const model = readyModel({ result: transcriptResult, screen: "result" });
    expect(update(model, { type: "go-home" })).toEqual({
      effects: [],
      model: expect.objectContaining({ result: null, screen: "home" }),
    });
  });

  test("Home cannot bypass first-run Artifact Library onboarding", () => {
    const onboarding = initialModel({ artifactLibrary: null });

    expect(update(onboarding, { type: "go-home" })).toEqual({ effects: [], model: onboarding });
  });

  test("Home cancels an active operation before navigating", () => {
    const model = readyModel({
      creationMode: "digest",
      nextRequestId: 2,
      pending: { kind: "ingest", requestId: 1 },
      screen: "progress",
    });

    expect(update(model, { type: "go-home" })).toEqual({
      effects: [{ requestId: 1, type: "cancel-operation" }],
      model: expect.objectContaining({ screen: "home" }),
    });
  });

  test("Escape from home and first-run onboarding requests a clean quit", () => {
    expect(update(readyModel(), { type: "back" }).effects).toEqual([{ type: "quit" }]);
    expect(update(initialModel({ artifactLibrary: null }), { type: "back" }).effects).toEqual([{ type: "quit" }]);
  });
});

describe("asynchronous effect correlation", () => {
  test("allocates monotonic request IDs and ignores every late event from a cancelled operation", () => {
    const input = readyModel({ creationMode: "transcript", screen: "enter-url" });
    const first = update(input, { type: "submit-url", url: "https://youtu.be/abc123_DEF4" });
    expect(first.effects).toEqual([
      { requestId: 1, type: "transcript", url: "https://www.youtube.com/watch?v=abc123_DEF4" },
    ]);

    const cancelled = update(first.model, { type: "back" });
    expect(cancelled.effects).toEqual([{ requestId: 1, type: "cancel-operation" }]);
    expect(cancelled.model.pending).toBeNull();

    const secondInput = update(update(cancelled.model, { type: "choose-transcript" }).model, {
      type: "submit-url",
      url: "https://youtu.be/XYZ987_abc1",
    });
    expect(secondInput.model.pending).toEqual({ kind: "transcript", requestId: 2 });

    const lateProgress = update(secondInput.model, {
      message: "stale progress",
      requestId: 1,
      type: "operation-progress",
    });
    expect(lateProgress.model).toBe(secondInput.model);

    const lateSuccess = update(secondInput.model, {
      requestId: 1,
      result: transcriptResult,
      type: "operation-succeeded",
    });
    expect(lateSuccess.model).toBe(secondInput.model);

    const lateFailure = update(secondInput.model, {
      message: "stale failure",
      requestId: 1,
      type: "operation-failed",
    });
    expect(lateFailure.model).toBe(secondInput.model);

    const completed = update(secondInput.model, {
      requestId: 2,
      result: transcriptResult,
      type: "operation-succeeded",
    });
    expect(completed.model).toMatchObject({ pending: null, screen: "result" });
  });

  test("deduplicates repeated submissions for every async effect category", () => {
    const cases = [
      {
        event: { path: "/new-library", type: "save-library" } as const,
        model: readyModel({ librarySelectionOrigin: "settings", screen: "choose-library" }),
      },
      {
        event: { type: "prepare-runtime" } as const,
        model: readyModel({ runtimeReadiness: { remediation: "setup", status: "missing" }, screen: "runtime-required" }),
      },
      {
        event: { type: "save-credential", value: " secret " } as const,
        model: readyModel({ credentialConfigured: false, screen: "credential-required" }),
      },
      {
        event: { type: "submit-url", url: "https://youtu.be/abc123_DEF4" } as const,
        model: readyModel({ creationMode: "transcript", screen: "enter-url" }),
      },
      { event: { type: "browse-library" } as const, model: readyModel() },
      {
        event: { type: "read-result" } as const,
        model: readyModel({ result: transcriptResult, screen: "result" }),
      },
      { event: { type: "open-doctor" } as const, model: readyModel() },
      {
        event: { type: "copy-result" } as const,
        model: readyModel({ result: transcriptResult, screen: "result" }),
      },
    ];

    for (const item of cases) {
      const first = update(item.model, item.event);
      expect(first.effects).toHaveLength(1);
      expect(first.model.pending?.requestId).toBe(1);

      const duplicate = update(first.model, item.event);
      expect(duplicate.effects).toEqual([]);
      expect(duplicate.model).toBe(first.model);
      expect(duplicate.model.nextRequestId).toBe(2);
    }
  });

  test("correlates completion for save, setup, credential, Library, reader, doctor, and system effects", () => {
    const staleRequestId = 99;
    const report = { checks: [], ok: true };
    const cases = [
      {
        completion: { path: "/saved", requestId: staleRequestId, type: "library-saved" } as const,
        event: { path: "/saved", type: "save-library" } as const,
        model: readyModel({ screen: "choose-library" }),
      },
      {
        completion: { requestId: staleRequestId, type: "runtime-ready" } as const,
        event: { type: "prepare-runtime" } as const,
        model: readyModel({ runtimeReadiness: { remediation: "setup", status: "missing" }, screen: "runtime-required" }),
      },
      {
        completion: { requestId: staleRequestId, type: "credential-saved" } as const,
        event: { type: "save-credential", value: "secret" } as const,
        model: readyModel({ credentialConfigured: false, screen: "credential-required" }),
      },
      {
        completion: { entries: [entry] as LibraryEntry[], requestId: staleRequestId, type: "library-loaded" } as const,
        event: { type: "browse-library" } as const,
        model: readyModel(),
      },
      {
        completion: {
          content: "body",
          path: entry.paths.digestPath!,
          requestId: staleRequestId,
          title: "Title",
          type: "reader-loaded",
        } as const,
        event: { type: "read-result" } as const,
        model: readyModel({ result: transcriptResult, screen: "result" }),
      },
      {
        completion: { report, requestId: staleRequestId, type: "doctor-completed" } as const,
        event: { type: "open-doctor" } as const,
        model: readyModel(),
      },
      {
        completion: { requestId: staleRequestId, type: "system-action-completed" } as const,
        event: { type: "copy-result" } as const,
        model: readyModel({ result: transcriptResult, screen: "result" }),
      },
    ];

    for (const item of cases) {
      const active = update(item.model, item.event).model;
      expect(update(active, item.completion).model).toBe(active);
    }
  });
});

describe("untrusted event payloads", () => {
  test("canonicalizes YouTube URLs and rejects unsupported input inline", () => {
    const model = readyModel({ creationMode: "transcript", screen: "enter-url" });
    const invalid = update(model, { type: "submit-url", url: "https://example.com/video" });
    expect(invalid.effects).toEqual([]);
    expect(invalid.model).toMatchObject({ message: "Enter a supported YouTube URL.", screen: "enter-url" });

    const valid = update(model, { type: "submit-url", url: "https://youtu.be/abc123_DEF4?t=4" });
    expect(valid.effects).toEqual([
      { requestId: 1, type: "transcript", url: "https://www.youtube.com/watch?v=abc123_DEF4" },
    ]);
    expect(valid.model.submittedUrl).toBe("https://www.youtube.com/watch?v=abc123_DEF4");
  });

  test("selects the canonical Library Entry by ID instead of trusting event paths", () => {
    const canonical = { ...entry, paths: { ...entry.paths } };
    const forged = {
      ...entry,
      paths: { ...entry.paths, digestPath: "/tmp/attacker-controlled.md" },
    };
    const model = readyModel({ entries: [canonical], screen: "library" });

    const selected = update(model, { type: "select-entry", videoId: forged.videoId }).model.selectedEntry;
    expect(selected).not.toBe(canonical);
    expect(selected?.paths.digestPath).toBe(entry.paths.digestPath);
  });

  test("trims credential input and never retains secret material in model state", () => {
    const model = readyModel({ credentialConfigured: false, screen: "credential-required" });
    const started = update(model, { type: "save-credential", value: "  top-secret  " });

    expect(started.effects).toEqual([{ requestId: 1, type: "save-credential", value: "top-secret" }]);
    expect(JSON.stringify(started.model)).not.toContain("top-secret");
    expect(update(started.model, { type: "save-credential", value: "another-secret" }).effects).toEqual([]);
  });
});

describe("pending state integrity", () => {
  test("blocks Back and Home while saving the Artifact Library, then reconciles completion", () => {
    const chooser = readyModel({ librarySelectionOrigin: "settings", screen: "choose-library" });
    const saving = update(chooser, { path: "/new-library", type: "save-library" }).model;

    expect(update(saving, { type: "back" })).toEqual({ effects: [], model: saving });
    expect(update(saving, { type: "go-home" })).toEqual({ effects: [], model: saving });

    const completed = update(saving, { path: "/new-library", requestId: 1, type: "library-saved" }).model;
    expect(completed).toMatchObject({
      config: { artifactLibrary: "/new-library" },
      pending: null,
      screen: "settings",
    });
  });

  test("blocks Back and Home during runtime preparation, then reconciles readiness", () => {
    const gate = readyModel({
      creationMode: "transcript",
      runtimeReadiness: { remediation: "setup", status: "missing" },
      screen: "runtime-required",
    });
    const preparing = update(gate, { type: "prepare-runtime" }).model;

    expect(update(preparing, { type: "back" })).toEqual({ effects: [], model: preparing });
    expect(update(preparing, { type: "go-home" })).toEqual({ effects: [], model: preparing });

    const completed = update(preparing, { requestId: 1, type: "runtime-ready" }).model;
    expect(completed).toMatchObject({ pending: null, runtimeReadiness: { status: "ready" }, screen: "enter-url" });
  });

  test("blocks Back and Home while saving credentials without retaining their copy", () => {
    const gate = readyModel({
      creationMode: "digest",
      credentialConfigured: false,
      screen: "credential-required",
    });
    const saving = update(gate, { type: "save-credential", value: "  top-secret  " }).model;

    expect(update(saving, { type: "back" })).toEqual({ effects: [], model: saving });
    expect(update(saving, { type: "go-home" })).toEqual({ effects: [], model: saving });
    expect(JSON.stringify(saving)).not.toContain("top-secret");

    const completed = update(saving, { requestId: 1, type: "credential-saved" }).model;
    expect(completed).toMatchObject({ credentialConfigured: true, pending: null, screen: "enter-url" });
    expect(JSON.stringify(completed)).not.toContain("top-secret");
  });

  test("only cancellable controller operations emit cancellation and clear pending navigation", () => {
    const doctor = update(readyModel(), { type: "open-doctor" }).model;
    expect(update(doctor, { type: "back" })).toEqual({ effects: [], model: doctor });

    const operation = update(readyModel({ creationMode: "transcript", screen: "enter-url" }), {
      type: "submit-url",
      url: "https://youtu.be/abc123_DEF4",
    }).model;
    expect(update(operation, { type: "back" })).toEqual({
      effects: [{ requestId: 1, type: "cancel-operation" }],
      model: expect.objectContaining({ pending: null, screen: "home" }),
    });
  });
});

describe("event payload snapshots", () => {
  test("deep-snapshots Library Entries and selected entries", () => {
    const source: LibraryEntry = {
      ...entry,
      paths: { ...entry.paths },
    };
    const loading = update(readyModel(), { type: "browse-library" }).model;
    const loaded = update(loading, { entries: [source], requestId: 1, type: "library-loaded" }).model;

    source.title = "Mutated title";
    source.paths.digestPath = "/tmp/mutated.md";
    expect(loaded.entries[0]).toMatchObject({
      paths: { digestPath: "/library/digests/abc123_DEF4.md" },
      title: "Example video",
    });

    const selected = update(loaded, { type: "select-entry", videoId: source.videoId }).model;
    const canonical = selected.entries[0]!;
    expect(selected.selectedEntry).not.toBe(canonical);
    (canonical as LibraryEntry).paths.digestPath = "/tmp/second-mutation.md";
    expect(selected.selectedEntry?.paths.digestPath).toBe("/library/digests/abc123_DEF4.md");

    const opening = update(selected, { type: "open-entry-externally" });
    (canonical as LibraryEntry).paths.digestPath = "/tmp/third-mutation.md";
    expect(opening.effects).toEqual([
      { path: "/library/digests/abc123_DEF4.md", requestId: 2, type: "open" },
    ]);
  });

  test("deep-snapshots completed operation results", () => {
    const source = {
      cleanText: "Original text",
      entry: { ...entry, paths: { ...entry.paths } },
      kind: "transcript" as const,
    };
    const running = update(readyModel({ creationMode: "transcript", screen: "enter-url" }), {
      type: "submit-url",
      url: "https://youtu.be/abc123_DEF4",
    }).model;
    const completed = update(running, { requestId: 1, result: source, type: "operation-succeeded" }).model;

    source.cleanText = "Mutated text";
    source.entry.title = "Mutated title";
    source.entry.paths.transcriptMarkdownPath = "/tmp/mutated.md";
    expect(completed.result).toMatchObject({
      cleanText: "Original text",
      entry: {
        paths: { transcriptMarkdownPath: "/library/transcripts/abc123_DEF4.md" },
        title: "Example video",
      },
    });

    const reading = update(completed, { type: "read-result" });
    source.entry.paths.transcriptMarkdownPath = "/tmp/second-mutation.md";
    expect(reading.effects).toEqual([
      { path: "/library/transcripts/abc123_DEF4.md", requestId: 2, type: "read" },
    ]);
  });

  test("deep-snapshots doctor reports", () => {
    const report = {
      checks: [{ capability: "transcript" as const, id: "runtime", message: "Ready", remediation: null, status: "pass" as const }],
      ok: true,
    };
    const running = update(readyModel(), { type: "open-doctor" }).model;
    const completed = update(running, { report, requestId: 1, type: "doctor-completed" }).model;

    report.ok = false;
    report.checks[0]!.message = "Mutated";
    expect(completed.doctorReport).toEqual({
      checks: [{ capability: "transcript", id: "runtime", message: "Ready", remediation: null, status: "pass" }],
      ok: true,
    });
  });

  test("snapshots runtime failure readiness", () => {
    const readiness = { remediation: "Run setup.", status: "missing" as const };
    const gate = readyModel({ runtimeReadiness: readiness, screen: "runtime-required" });
    const running = update(gate, { type: "prepare-runtime" }).model;
    const failed = update(running, {
      message: "Setup failed",
      readiness,
      requestId: 1,
      type: "runtime-failed",
    }).model;

    readiness.remediation = "Mutated remediation";
    expect(failed.runtimeReadiness).toEqual({ remediation: "Run setup.", status: "missing" });
  });
});
