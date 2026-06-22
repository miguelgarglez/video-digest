import { describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { SelectRenderable, type Renderable } from "@opentui/core";
import type { LibraryEntry } from "../cli/artifacts";
import { initialModel, type Event, type Model, type ResultData } from "./model";
import { createOpenTuiFacadeFromRenderer, createTuiRenderer } from "./renderer";

const entry: LibraryEntry = {
  channel: "Example Channel",
  paths: {
    digestPath: null,
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

const transcriptResult: ResultData = { cleanText: "Clean text", entry, kind: "transcript" };

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

describe("native OpenTUI adapter", () => {
  test("edits and submits a secret without putting real characters in renderables or spans", async () => {
    const setup = await createTestRenderer({ height: 20, kittyKeyboard: true, width: 70 });
    const events: Event[] = [];
    const model = readyModel({ credentialConfigured: false, screen: "credential-required" });
    const facade = await createOpenTuiFacadeFromRenderer(setup.renderer, { env: { NO_COLOR: "1" } });
    const tui = createTuiRenderer({
      dispatch: async (event) => { events.push(event); },
      facade,
      getModel: () => model,
    });

    try {
      tui.render(model);
      await setup.flush();
      await setup.mockInput.typeText("SECRET");
      setup.mockInput.pressArrow("left");
      setup.mockInput.pressArrow("left");
      setup.mockInput.pressArrow("left", { shift: true });
      await setup.mockInput.typeText("X");
      await setup.mockInput.pasteBracketedText("秘密🔐");
      setup.resize(72, 21);
      await setup.flush();

      assertSecretAbsent(setup, ["SECRET", "SEC", "秘密", "🔐", "X"]);
      expect(setup.captureCharFrame()).toContain("••••••••");

      setup.mockInput.pressEnter();
      await setup.flush();
      expect(events.at(-1)).toEqual({ type: "save-credential", value: "SECX秘密🔐ET" });
      expect(setup.captureCharFrame()).not.toContain("•");
      assertSecretAbsent(setup, ["SECRET", "SEC", "秘密", "🔐", "X"]);
    } finally {
      tui.destroy();
      setup.renderer.destroy();
    }
  });

  test("clears secret editor state immediately on Back and on a screen change", async () => {
    const setup = await createTestRenderer({ height: 20, width: 70 });
    let model = readyModel({ credentialConfigured: false, screen: "credential-required" });
    const facade = await createOpenTuiFacadeFromRenderer(setup.renderer, { env: { NO_COLOR: "1" } });
    const tui = createTuiRenderer({ dispatch: async () => undefined, facade, getModel: () => model });

    try {
      tui.render(model);
      await setup.mockInput.typeText("BACKSECRET");
      setup.mockInput.pressEscape();
      await setup.flush();
      expect(setup.captureCharFrame()).not.toContain("•");

      await setup.mockInput.typeText("SCREENSECRET");
      model = readyModel();
      tui.render(model);
      await setup.flush();
      expect(setup.captureCharFrame()).not.toContain("•");
      assertSecretAbsent(setup, ["BACKSECRET", "SCREENSECRET"]);
    } finally {
      tui.destroy();
      setup.renderer.destroy();
    }
  });

  test("renders a usable full result at 60x18 and falls back below either minimum", async () => {
    const setup = await createTestRenderer({ height: 17, width: 60 });
    const model = readyModel({ result: transcriptResult, screen: "result" });
    const facade = await createOpenTuiFacadeFromRenderer(setup.renderer, { env: { NO_COLOR: "1" } });
    const tui = createTuiRenderer({ dispatch: async () => undefined, facade, getModel: () => model });

    try {
      tui.render(model);
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Terminal too small");

      setup.resize(60, 18);
      await setup.flush();
      const minimum = setup.captureCharFrame();
      expect(minimum).toContain("Transcript ready");
      for (const option of ["Open Artifact", "Copy Transcript", "Print Transcript", "Reveal in Finder", "Return Home"]) {
        expect(minimum).toContain(option);
      }
      expect(minimum).toContain("Enter Choose");

      setup.resize(60, 19);
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Return Home");

      setup.resize(59, 19);
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Terminal too small");
    } finally {
      tui.destroy();
      setup.renderer.destroy();
    }
  });

  test("clips a long Library choice list above the reserved footer", async () => {
    const setup = await createTestRenderer({ height: 18, width: 60 });
    const entries = Array.from({ length: 20 }, (_, index) => ({
      ...entry,
      title: `Entry ${index + 1}`,
      videoId: `abc123_${String(index).padStart(3, "0")}`,
    }));
    const model = readyModel({ entries, screen: "library" });
    const facade = await createOpenTuiFacadeFromRenderer(setup.renderer, { env: { NO_COLOR: "1" } });
    const tui = createTuiRenderer({ dispatch: async () => undefined, facade, getModel: () => model });

    try {
      tui.render(model);
      await setup.flush();
      const select = setup.renderer.root.findDescendantById("screen-options");
      expect(select).toBeInstanceOf(SelectRenderable);
      expect(select?.height).toBe(10);
      expect((select as SelectRenderable).showScrollIndicator).toBe(true);
      expect(setup.captureCharFrame()).toContain("Enter Choose");
    } finally {
      tui.destroy();
      setup.renderer.destroy();
    }
  });

  test("scrolls a minimum-size reader to its complete tail while retaining the footer", async () => {
    const setup = await createTestRenderer({ height: 18, width: 60 });
    const content = `${Array.from({ length: 40 }, (_, index) => `Reader line ${index + 1}`).join("\n")}\nTAIL-SENTINEL`;
    const model = readyModel({
      reader: { content, displayPath: "transcripts/abc123_DEF4.md", title: "Reader" },
      readerOrigin: "library",
      screen: "reader",
    });
    const facade = await createOpenTuiFacadeFromRenderer(setup.renderer, { env: { NO_COLOR: "1" } });
    const tui = createTuiRenderer({ dispatch: async () => undefined, facade, getModel: () => model });

    try {
      tui.render(model);
      await setup.flush();
      expect(setup.captureCharFrame()).not.toContain("TAIL-SENTINEL");

      setup.mockInput.pressKey("END");
      await setup.flush();
      const tail = setup.captureCharFrame();
      expect(tail).toContain("TAIL-SENTINEL");
      expect(tail).toContain("Esc Back");
    } finally {
      tui.destroy();
      setup.renderer.destroy();
    }
  });

  test("uses renderer default color intents under NO_COLOR", async () => {
    const setup = await createTestRenderer({ height: 18, width: 60 });
    const model = readyModel();
    const facade = await createOpenTuiFacadeFromRenderer(setup.renderer, { env: { NO_COLOR: "" } });
    const tui = createTuiRenderer({ dispatch: async () => undefined, facade, getModel: () => model });

    try {
      tui.render(model);
      await setup.flush();
      const visibleSpans = setup.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.text.trim());
      expect(visibleSpans.length).toBeGreaterThan(0);
      expect(new Set(visibleSpans.map((span) => span.fg.intent))).toEqual(new Set(["default"]));
      expect(new Set(visibleSpans.map((span) => span.bg.intent))).toEqual(new Set(["default"]));
    } finally {
      tui.destroy();
      setup.renderer.destroy();
    }
  });
});

function assertSecretAbsent(setup: TestRendererSetup, forbidden: string[]): void {
  const frame = setup.captureCharFrame();
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans).map((span) => span.text).join("\n");
  const renderableText = collectRenderables(setup.renderer.root)
    .map((renderable) => "plainText" in renderable ? String((renderable as Renderable & { plainText: string }).plainText) : "")
    .join("\n");
  for (const value of forbidden) {
    expect(frame).not.toContain(value);
    expect(spans).not.toContain(value);
    expect(renderableText).not.toContain(value);
  }
}

function collectRenderables(root: Renderable): Renderable[] {
  const children = root.getChildren() as Renderable[];
  return [root, ...children.flatMap(collectRenderables)];
}
