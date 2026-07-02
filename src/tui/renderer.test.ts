import { describe, expect, test } from "bun:test";
import { initialModel, type Event, type Model } from "./model";
import {
  createTuiRenderer,
  type OpenTuiFacade,
  type RenderFrame,
  type RendererKey,
} from "./renderer";
import { createTheme } from "./theme";
import { FEEDBACK_EMAIL, buildFeedbackLinks } from "./feedback";

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

function fakeFacade(dimensions = { height: 30, width: 100 }): OpenTuiFacade & {
  destroyCalls: number;
  frame: RenderFrame | null;
} {
  return {
    destroyCalls: 0,
    dimensions,
    frame: null,
    destroy() { this.destroyCalls += 1; },
    async print() {},
    render(frame) { this.frame = frame; },
  };
}

describe("createTuiRenderer", () => {
  test("renders a pure view without initializing a native terminal", () => {
    const facade = fakeFacade();
    const renderer = createTuiRenderer({ dispatch: async () => undefined, facade });

    renderer.render(readyModel());

    expect(facade.frame?.view).toMatchObject({ kind: "home", title: "Video Digest" });
  });

  test("translates selection and input callbacks into controller events", async () => {
    const facade = fakeFacade();
    const events: Event[] = [];
    let model = readyModel();
    const renderer = createTuiRenderer({
      dispatch: async (event) => { events.push(event); },
      facade,
      getModel: () => model,
    });

    renderer.render(model);
    await facade.frame?.onSelect(1);
    expect(events).toEqual([{ type: "choose-transcript" }]);

    model = readyModel({ creationMode: "transcript", screen: "enter-url" });
    renderer.render(model);
    await facade.frame?.onSubmit(" https://youtu.be/abc123_DEF4 ");
    expect(events.at(-1)).toEqual({ type: "submit-url", url: " https://youtu.be/abc123_DEF4 " });
  });

  test("opens a selected Library Entry through correlated controller events", async () => {
    const events: Event[] = [];
    const entry = {
      channel: null,
      paths: {
        digestPath: null,
        emailPreviewPath: null,
        metadataPath: "/library/metadata/abc123_DEF4.json",
        transcriptJsonPath: "/library/transcripts/abc123_DEF4.json",
        transcriptMarkdownPath: "/library/transcripts/abc123_DEF4.md",
        transcriptTextPath: "/library/transcripts/abc123_DEF4.txt",
      },
      title: null,
      updatedAt: "2026-06-22T10:00:00.000Z",
      videoId: "abc123_DEF4",
    };
    const model = readyModel({ entries: [entry], screen: "library" });
    const facade = fakeFacade();
    const renderer = createTuiRenderer({
      dispatch: async (event) => { events.push(event); },
      facade,
      getModel: () => model,
    });

    renderer.render(model);
    await facade.frame?.onSelect(0);

    expect(events).toEqual([
      { type: "select-entry", videoId: "abc123_DEF4" },
      { type: "read-entry" },
    ]);
  });

  test("maps Escape, Ctrl-C, and q with safe global semantics", async () => {
    const facade = fakeFacade();
    const events: Event[] = [];
    let model = readyModel();
    const renderer = createTuiRenderer({
      dispatch: async (event) => { events.push(event); },
      facade,
      getModel: () => model,
    });
    renderer.render(model);

    const escapeHandled = facade.frame?.onKey(key("escape"));
    expect(escapeHandled).toBe(true);
    await Promise.resolve();
    await facade.frame?.onKey(key("c", { ctrl: true }));
    await facade.frame?.onKey(key("q"));
    expect(events).toEqual([{ type: "back" }, { type: "quit" }, { type: "quit" }]);

    model = readyModel({ creationMode: "transcript", screen: "enter-url" });
    renderer.render(model);
    await facade.frame?.onKey(key("q"));
    expect(events).toHaveLength(3);
  });

  test("dispatches F1 help and every feedback action", async () => {
    const facade = fakeFacade();
    const events: Event[] = [];
    let model = readyModel({ message: "Creation failed.", screen: "enter-url" });
    const renderer = createTuiRenderer({
      dispatch: async (event) => { events.push(event); },
      facade,
      getModel: () => model,
    });

    renderer.render(model);
    expect(facade.frame?.onKey(key("f1"))).toBe(true);
    await Promise.resolve();
    expect(events).toEqual([{ type: "open-help" }]);

    const supportContext = { appVersion: "1.0.0", architecture: "arm64", macOSVersion: "26.5.1" };
    const links = buildFeedbackLinks(supportContext, "failed-workflow");
    model = readyModel({ helpOrigin: "failed-workflow", screen: "help-feedback", supportContext });
    renderer.render(model);
    for (let index = 0; index < 4; index += 1) await facade.frame?.onSelect(index);

    expect(events.slice(1)).toEqual([
      { type: "open-external-url", url: links.email },
      { type: "open-external-url", url: links.githubIssue },
      { type: "copy-text", text: FEEDBACK_EMAIL },
      { type: "copy-text", text: links.githubIssue },
    ]);
  });

  test("does not duplicate submissions while a request is pending", async () => {
    const facade = fakeFacade();
    const events: Event[] = [];
    const model = readyModel({
      creationMode: "transcript",
      pending: { kind: "transcript", requestId: 1 },
      screen: "progress",
    });
    const renderer = createTuiRenderer({
      dispatch: async (event) => { events.push(event); },
      facade,
      getModel: () => model,
    });

    renderer.render(model);
    await facade.frame?.onSelect(0);
    await facade.frame?.onSubmit("https://youtu.be/abc123_DEF4");
    expect(events).toEqual([]);
  });

  test("re-renders on resize and delegates the small-terminal fallback", () => {
    const facade = fakeFacade({ height: 10, width: 40 });
    const renderer = createTuiRenderer({ dispatch: async () => undefined, facade });

    renderer.render(readyModel());
    expect(facade.frame?.view.kind).toBe("small-terminal");

    facade.dimensions = { height: 30, width: 100 };
    facade.frame?.onResize();
    expect(facade.frame?.view.kind).toBe("home");
  });

  test("cleanup is idempotent and fences late callbacks", async () => {
    const facade = fakeFacade();
    const events: Event[] = [];
    const renderer = createTuiRenderer({
      dispatch: async (event) => { events.push(event); },
      facade,
    });
    renderer.render(readyModel());
    const frame = facade.frame;

    renderer.destroy();
    renderer.destroy();
    await frame?.onKey(key("c", { ctrl: true }));

    expect(facade.destroyCalls).toBe(1);
    expect(events).toEqual([]);
  });
});

describe("theme", () => {
  test("honors NO_COLOR without embedding ANSI sequences", () => {
    const monochrome = createTheme({ NO_COLOR: "1" });
    const color = createTheme({});

    expect(monochrome).toMatchObject({ colorEnabled: false });
    expect(monochrome).toMatchObject({
      accent: undefined,
      background: undefined,
      danger: undefined,
      foreground: undefined,
      muted: undefined,
      success: undefined,
      surface: undefined,
    });
    expect(Object.values(monochrome).join("")).not.toContain("\u001b");
    expect(Object.values(color).join("")).not.toContain("\u001b");
    expect(color.colorEnabled).toBe(true);
  });
});

function key(name: string, overrides: Partial<RendererKey> = {}): RendererKey {
  return { ctrl: false, meta: false, name, shift: false, ...overrides };
}
