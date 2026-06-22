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

    expect(update(model, { type: "runtime-ready" }).model).toMatchObject({
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
      effects: [{ type: "prepare-runtime" }],
      model: runtimeModel,
    });

    const credentialModel = readyModel({ credentialConfigured: false, screen: "credential-required" });
    const transition = update(credentialModel, { type: "save-credential", value: "secret" });
    expect(transition.effects).toEqual([{ type: "save-credential", value: "secret" }]);
    expect(transition.model).toBe(credentialModel);
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
      effects: [{ type: "transcript", url: "https://youtu.be/abc123_DEF4" }],
      model: expect.objectContaining({
        message: "Getting transcript…",
        progress: null,
        screen: "progress",
        submittedUrl: "https://youtu.be/abc123_DEF4",
      }),
    });
  });

  test("tracks progress and exposes result data without an inline preview", () => {
    const progress = readyModel({ creationMode: "transcript", screen: "progress" });
    const tracked = update(progress, { message: "Fetching transcript", type: "operation-progress" }).model;
    expect(tracked.progress).toBe("Fetching transcript");

    const completed = update(tracked, { result: transcriptResult, type: "operation-succeeded" }).model;
    expect(completed).toMatchObject({ progress: null, result: transcriptResult, screen: "result" });
    expect(completed.reader).toBeNull();
  });

  test("returns a failed operation to URL input with actionable context", () => {
    const model = readyModel({ creationMode: "digest", screen: "progress" });

    expect(update(model, { message: "Transcript unavailable", type: "operation-failed" }).model).toMatchObject({
      message: "Transcript unavailable",
      screen: "enter-url",
    });
  });

  test("emits result actions only when their data exists", () => {
    const model = readyModel({ result: transcriptResult, screen: "result" });

    expect(update(model, { type: "copy-result" }).effects).toEqual([
      { text: "A clean transcript.", type: "copy" },
    ]);
    expect(update(model, { type: "print-result" }).effects).toEqual([
      { text: "A clean transcript.", type: "print" },
    ]);
    expect(update(model, { type: "reveal-result" }).effects).toEqual([
      { path: "/library/transcripts/abc123_DEF4.md", type: "reveal" },
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
      effects: [{ path: "/library/transcripts/abc123_DEF4.md", type: "read" }],
      model: expect.objectContaining({ readerOrigin: "result" }),
    });

    const loaded = update(model, {
      content: "# Transcript",
      path: "/library/transcripts/abc123_DEF4.md",
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
      effects: [{ type: "load-library" }],
      model: expect.objectContaining({ entries: [], screen: "library", selectedEntry: null }),
    });

    const loaded = update(readyModel({ screen: "library" }), { entries: [entry], type: "library-loaded" }).model;
    expect(update(loaded, { entry, type: "select-entry" }).model.selectedEntry).toEqual(entry);
  });

  test("opens selected Library content in the reader and external applications explicitly", () => {
    const model = readyModel({ screen: "library", selectedEntry: entry });

    expect(update(model, { type: "read-entry" }).effects).toEqual([
      { path: "/library/digests/abc123_DEF4.md", type: "read" },
    ]);
    expect(update(model, { type: "open-entry-externally" }).effects).toEqual([
      { path: "/library/digests/abc123_DEF4.md", type: "open" },
    ]);
  });

  test("settings changes the library persistently and returns after save", () => {
    const settings = update(readyModel(), { type: "open-settings" }).model;
    expect(settings.screen).toBe("settings");

    const chooser = update(settings, { type: "change-library" }).model;
    expect(chooser).toMatchObject({ librarySelectionOrigin: "settings", screen: "choose-library" });
    expect(update(chooser, { path: "/new-library", type: "save-library" }).effects).toEqual([
      { path: "/new-library", type: "save-library" },
    ]);

    expect(update(chooser, { path: "/new-library", type: "library-saved" }).model).toMatchObject({
      config: { artifactLibrary: "/new-library" },
      screen: "settings",
    });
  });

  test("runs diagnostics as an explicit effect and stores the report", () => {
    const transition = update(readyModel(), { type: "open-doctor" });
    expect(transition.effects).toEqual([{ type: "run-doctor" }]);
    expect(transition.model.screen).toBe("doctor");

    const report = { checks: [], ok: true };
    expect(update(transition.model, { report, type: "doctor-completed" }).model.doctorReport).toEqual(report);
  });

  test("skill discovery copies commands but never installs the skill", () => {
    const skill = update(readyModel({ screen: "settings" }), { type: "open-agent-skill" }).model;
    expect(skill.screen).toBe("agent-skill");
    expect(update(skill, { text: "gh skill preview owner/repo video-digest", type: "copy-text" }).effects).toEqual([
      { text: "gh skill preview owner/repo video-digest", type: "copy" },
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
    const model = readyModel({ creationMode: "transcript", screen: "progress" });
    expect(update(model, { type: "back" })).toEqual({
      effects: [{ type: "cancel-operation" }],
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
    const model = readyModel({ creationMode: "digest", screen: "progress" });

    expect(update(model, { type: "go-home" })).toEqual({
      effects: [{ type: "cancel-operation" }],
      model: expect.objectContaining({ screen: "home" }),
    });
  });

  test("Escape from home and first-run onboarding requests a clean quit", () => {
    expect(update(readyModel(), { type: "back" }).effects).toEqual([{ type: "quit" }]);
    expect(update(initialModel({ artifactLibrary: null }), { type: "back" }).effects).toEqual([{ type: "quit" }]);
  });
});
