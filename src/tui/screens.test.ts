import { describe, expect, test } from "bun:test";
import type { LibraryEntry } from "../cli/artifacts";
import type { DoctorReport } from "../cli/doctor";
import { initialModel, type Model, type ResultData } from "./model";
import { buildScreenView, MIN_TERMINAL_SIZE, sanitizeTerminalText } from "./screens";

const entry: LibraryEntry = {
  channel: "Example\u001b]8;;https://evil.invalid\u0007 Channel",
  paths: {
    digestPath: "/library/digests/abc123_DEF4.md",
    emailPreviewPath: null,
    metadataPath: "/library/metadata/abc123_DEF4.json",
    transcriptJsonPath: "/library/transcripts/abc123_DEF4.json",
    transcriptMarkdownPath: "/library/transcripts/abc123_DEF4.md",
    transcriptTextPath: "/library/transcripts/abc123_DEF4.txt",
  },
  title: "Example\nvideo\u001b[31m",
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

describe("buildScreenView", () => {
  test("home exposes one focused choice list with the approved options", () => {
    expect(buildScreenView(readyModel())).toMatchObject({
      focus: "options",
      options: [
        "Create Digest",
        "Get Transcript",
        "Browse Library",
        "Setup & Settings",
        "Diagnostics",
      ],
      preview: null,
      title: "Video Digest",
    });
  });

  test("first-run onboarding asks only for the Artifact Library", () => {
    expect(buildScreenView(initialModel({
      artifactLibrary: null,
      defaultArtifactLibrary: "/Users/test/Documents/Video Digest",
    }))).toMatchObject({
      focus: "input",
      input: {
        label: "Artifact Library folder",
        value: "/Users/test/Documents/Video Digest",
        secret: false,
      },
      options: [],
      title: "Choose your Artifact Library",
    });
  });

  test("creation gates and URL entry each expose one next action", () => {
    expect(buildScreenView(readyModel({
      creationMode: "transcript",
      runtimeReadiness: { remediation: "Run setup.", status: "missing" },
      screen: "runtime-required",
    }))).toMatchObject({
      body: [
        "Setup may install an isolated Python 3.12 runtime and locked Transcript dependencies in Video Digest's application data.",
        "Run setup.",
      ],
      focus: "options",
      options: ["Confirm Runtime Setup"],
      title: "Transcript runtime required",
    });

    expect(buildScreenView(readyModel({
      creationMode: "digest",
      credentialConfigured: false,
      screen: "credential-required",
    }))).toMatchObject({
      focus: "input",
      input: expect.objectContaining({ label: "OpenCode API key", secret: true }),
      title: "OpenCode credential required",
    });

    expect(buildScreenView(readyModel({ creationMode: "digest", screen: "enter-url" }))).toMatchObject({
      focus: "input",
      input: expect.objectContaining({ label: "YouTube URL", secret: false }),
      title: "Create Digest",
    });
  });

  test("Settings reuses the persisted absolute Library path as its editable value", () => {
    const chooser = {
      ...readyModel(),
      librarySelectionOrigin: "settings" as const,
      screen: "choose-library" as const,
    };
    expect(buildScreenView(chooser).input?.value).toBe("/library");
  });

  test("progress reports one safe status without choices", () => {
    expect(buildScreenView(readyModel({
      creationMode: "transcript",
      message: "Getting transcript…",
      progress: "Fetching\u001b[2J transcript",
      screen: "progress",
    }))).toMatchObject({
      focus: "none",
      options: [],
      status: { text: "Fetching transcript", tone: "pending" },
      title: "Getting Transcript",
    });
  });

  test("result keeps content behind Open and exposes transcript actions", () => {
    const view = buildScreenView(readyModel({ result: transcriptResult, screen: "result" }));

    expect(view).toMatchObject({
      body: ["Example video — Example Channel"],
      focus: "options",
      options: ["Open Artifact", "Copy Transcript", "Print Transcript", "Reveal in Finder", "Return Home"],
      preview: null,
      title: "Transcript ready",
    });
    expect(view.body.join(" ")).not.toContain("A clean transcript.");
  });

  test("result action errors replace the static saved status", () => {
    expect(buildScreenView(readyModel({
      message: "Could not copy the Transcript.",
      result: transcriptResult,
      screen: "result",
    })).status).toEqual({ text: "Could not copy the Transcript.", tone: "error" });
  });

  test("digest results expose Copy and Print whenever clean transcript text is available", () => {
    expect(buildScreenView(readyModel({
      result: { cleanText: "Digest transcript text", entry, kind: "digest" },
      screen: "result",
    })).options).toEqual([
      "Open Artifact", "Copy Transcript", "Print Transcript", "Reveal in Finder", "Return Home",
    ]);

    expect(buildScreenView(readyModel({
      result: { cleanText: null, entry, kind: "digest" },
      screen: "result",
    })).options).toEqual(["Open Artifact", "Reveal in Finder", "Return Home"]);
  });

  test("reader is the only screen that exposes scrollable content", () => {
    const view = buildScreenView(readyModel({
      reader: {
        content: "# Heading\n\nBody\u001b[31m",
        displayPath: "transcripts/abc123_DEF4.md",
        title: "Example\u0000 title",
      },
      readerOrigin: "result",
      screen: "reader",
    }));

    expect(view).toMatchObject({
      body: ["# Heading\n\nBody"],
      bodyKind: "document",
      focus: "body",
      scrollable: true,
      title: "Example title",
    });
  });

  test("reader preserves complete sanitized document content without display truncation", () => {
    const source = [
      `Long ${"x".repeat(500)}`,
      "second line",
      "before\u001b[31mred\u001b[0mafter\u202Eunsafe\u202C",
      "TAIL",
    ].join("\n");
    const view = buildScreenView(readyModel({
      reader: { content: source, displayPath: "entry.md", title: "Entry" },
      readerOrigin: "library",
      screen: "reader",
    }), { height: 18, width: 60 });

    expect(view.bodyKind).toBe("document");
    expect(view.body.join("\n")).toBe([
      `Long ${"x".repeat(500)}`,
      "second line",
      "beforeredafterunsafe",
      "TAIL",
    ].join("\n"));
    expect(view.body.join("\n")).not.toContain("…");
  });

  test("library lists sanitized entries and a clear empty state", () => {
    expect(buildScreenView(readyModel({ entries: [entry], screen: "library" }))).toMatchObject({
      focus: "options",
      options: ["Example video — Example Channel"],
      title: "Artifact Library",
    });
    expect(buildScreenView(readyModel({ entries: [], screen: "library" }))).toMatchObject({
      body: ["No Library Entries yet."],
      focus: "none",
      options: [],
    });
  });

  test("settings, doctor, and Agent Skill pages keep copy centralized and review-first", () => {
    expect(buildScreenView(readyModel({ screen: "settings" })).options).toEqual([
      "Change Artifact Library",
      "Set Up Transcript Runtime",
      "Configure OpenCode Credential",
      "Agent Skill",
    ]);

    const report: DoctorReport = {
      checks: [{
        capability: "transcript",
        id: "python-runtime",
        message: "Runtime\u001b[31m ready",
        remediation: null,
        status: "pass",
      }],
      ok: true,
    };
    expect(buildScreenView(readyModel({ doctorReport: report, screen: "doctor" }))).toMatchObject({
      body: ["PASS  Runtime ready"],
      focus: "none",
      title: "Diagnostics",
    });

    const skill = buildScreenView(readyModel({ screen: "agent-skill" }));
    expect(skill.body).toContain("gh skill preview miguelgarglez/personal-video-digest video-digest");
    expect(skill.body).toContain("gh skill install miguelgarglez/personal-video-digest video-digest");
    expect(skill.body.join(" ")).toContain("Review the skill before installing it");
    expect(skill.options).toEqual(["Copy Preview Command", "Copy Install Command"]);
  });

  test("uses a clear fallback below the supported terminal size", () => {
    const view = buildScreenView(readyModel(), {
      height: MIN_TERMINAL_SIZE.height - 1,
      width: MIN_TERMINAL_SIZE.width,
    });

    expect(view).toMatchObject({
      focus: "none",
      kind: "small-terminal",
      options: [],
      title: "Terminal too small",
    });
    expect(view.body[0]).toContain(`${MIN_TERMINAL_SIZE.width}×${MIN_TERMINAL_SIZE.height}`);
  });

  test("shows a pending state and prevents duplicate input or selection", () => {
    const view = buildScreenView(readyModel({
      pending: { kind: "save-library", requestId: 3 },
      screen: "choose-library",
    }));

    expect(view.focus).toBe("none");
    expect(view.input?.disabled).toBe(true);
    expect(view.status).toEqual({ text: "Working…", tone: "pending" });

    expect(buildScreenView(readyModel({
      pending: { kind: "copy", requestId: 4 },
      result: transcriptResult,
      screen: "result",
    })).status).toEqual({ text: "Working…", tone: "pending" });

    expect(buildScreenView(readyModel({
      message: "Earlier copy failed.",
      pending: { kind: "copy", requestId: 5 },
      result: transcriptResult,
      screen: "result",
    })).status).toEqual({ text: "Working…", tone: "pending" });
  });
});

describe("terminal text safety", () => {
  test("removes control characters without collapsing readable structure", () => {
    expect(sanitizeTerminalText("Hello\u001b]8;;https://evil.invalid\u0007\nworld\t!\u0000")).toBe("Hello\nworld\t!");
    expect(sanitizeTerminalText("safe\u001bPmalicious\u001b\\text\u009B31mend")).toBe("safetextend");
    expect(sanitizeTerminalText("one\rtwo\r\nthree")).toBe("one\ntwo\nthree");
  });

  test("removes bidirectional and unsafe format controls while preserving intentional joiners", () => {
    expect(sanitizeTerminalText("safe\u202Eevil\u202C \u2066isolate\u2069 a\u200Db e\u0301")).toBe(
      "safeevil isolate a\u200Db e\u0301",
    );
  });

  test("bounds every untrusted display line for the current terminal width", () => {
    const longTitle = `Title ${"界".repeat(100)}`;
    const view = buildScreenView(readyModel({
      entries: [{ ...entry, channel: "channel", title: longTitle }],
      screen: "library",
    }), { height: 20, width: 60 });

    expect(view.options[0]?.endsWith("…")).toBe(true);
    expect(Bun.stringWidth(view.options[0] ?? "")).toBeLessThanOrEqual(52);

    const combiningFlood = `a${"\u0301".repeat(1_000)}`;
    const flooded = buildScreenView(readyModel({
      entries: [{ ...entry, title: combiningFlood }],
      screen: "library",
    })).options[0] ?? "";
    expect(Array.from(flooded).length).toBeLessThanOrEqual(160);
    expect(flooded.endsWith("…")).toBe(true);
  });
});
