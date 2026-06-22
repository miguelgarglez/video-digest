import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import type { Event, Model } from "./model";
import { buildScreenView, type ScreenAction, type ScreenView } from "./screens";
import { createTheme, type TuiTheme } from "./theme";

export type RendererKey = Readonly<{
  ctrl: boolean;
  meta: boolean;
  name: string;
  shift: boolean;
}>;

export type RenderFrame = Readonly<{
  onKey(key: RendererKey): boolean;
  onResize(): void;
  onSelect(index: number): Promise<void>;
  onSubmit(value: string): Promise<void>;
  view: ScreenView;
}>;

export interface OpenTuiFacade {
  dimensions: { height: number; width: number };
  destroy(): void;
  render(frame: RenderFrame): void;
}

export type TuiRenderer = Readonly<{
  destroy(): void;
  render(model: Model): void;
}>;

export type TuiRendererOptions = Readonly<{
  dispatch(event: Event): Promise<void>;
  facade: OpenTuiFacade;
  getModel?(): Model;
}>;

export function createTuiRenderer(options: TuiRendererOptions): TuiRenderer {
  let destroyed = false;
  let lastModel: Model | null = null;
  let renderGeneration = 0;

  const currentModel = (): Model | null => options.getModel?.() ?? lastModel;

  const render = (model: Model): void => {
    if (destroyed) return;
    lastModel = model;
    const generation = ++renderGeneration;
    const view = buildScreenView(model, options.facade.dimensions);

    options.facade.render({
      onKey: (key) => {
        if (destroyed || generation !== renderGeneration) return false;
        return handleKey(key, view, currentModel(), options.dispatch);
      },
      onResize: () => {
        if (destroyed) return;
        const latest = currentModel();
        if (latest) render(latest);
      },
      onSelect: async (index) => {
        if (destroyed || generation !== renderGeneration) return;
        const latest = currentModel();
        if (!latest || latest.pending) return;
        const action = view.actions[index];
        if (action) await dispatchAction(action, options.dispatch);
      },
      onSubmit: async (value) => {
        if (destroyed || generation !== renderGeneration) return;
        const latest = currentModel();
        if (!latest || latest.pending) return;
        const event = inputEvent(latest, value);
        if (event) await options.dispatch(event);
      },
      view,
    });
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    renderGeneration += 1;
    lastModel = null;
    options.facade.destroy();
  };

  return Object.freeze({ destroy, render });
}

function handleKey(
  key: RendererKey,
  view: ScreenView,
  model: Model | null,
  dispatch: (event: Event) => Promise<void>,
): boolean {
  const name = key.name.toLowerCase();
  if (key.ctrl && name === "c") {
    void dispatch({ type: "quit" }).catch(() => undefined);
    return true;
  }
  if (!key.ctrl && !key.meta && (name === "escape" || name === "esc")) {
    void dispatch({ type: "back" }).catch(() => undefined);
    return true;
  }
  if (!key.ctrl && !key.meta && !key.shift && name === "q" &&
    (view.kind === "home" || view.kind === "small-terminal") && model?.pending === null) {
    void dispatch({ type: "quit" }).catch(() => undefined);
    return true;
  }
  return false;
}

async function dispatchAction(action: ScreenAction, dispatch: (event: Event) => Promise<void>): Promise<void> {
  if (action.type === "select-entry") {
    await dispatch(action);
    await dispatch({ type: "read-entry" });
    return;
  }
  await dispatch(action);
}

function inputEvent(model: Model, value: string): Event | null {
  switch (model.screen) {
    case "choose-library":
      return { path: value, type: "save-library" };
    case "credential-required":
      return { type: "save-credential", value };
    case "enter-url":
      return { type: "submit-url", url: value };
    default:
      return null;
  }
}

export type CreateOpenTuiFacadeOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
}>;

/**
 * The only native OpenTUI boundary. Importing renderer helpers in unit tests does
 * not create a renderer, switch screens, or attach process signal handlers.
 */
export async function createOpenTuiFacade(
  options: CreateOpenTuiFacadeOptions = {},
): Promise<OpenTuiFacade> {
  const core = await import("@opentui/core");
  const renderer = await core.createCliRenderer({
    autoFocus: true,
    clearOnShutdown: true,
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    useMouse: false,
  });
  const theme = createTheme(options.env ?? process.env);
  let destroyed = false;
  let currentRoot: Renderable | null = null;
  let currentFrame: RenderFrame | null = null;

  const keyHandler = (key: KeyEvent): void => {
    const frame = currentFrame;
    if (!frame || destroyed) return;
    if (frame.onKey({ ctrl: key.ctrl, meta: key.meta, name: key.name, shift: key.shift })) {
      key.preventDefault();
      key.stopPropagation();
    }
  };
  const resizeHandler = (): void => currentFrame?.onResize();
  renderer.keyInput.on("keypress", keyHandler);
  renderer.on(core.CliRenderEvents.RESIZE, resizeHandler);

  const facade: OpenTuiFacade = {
    get dimensions() {
      return { height: renderer.terminalHeight, width: renderer.terminalWidth };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      currentFrame = null;
      try {
        renderer.keyInput.off("keypress", keyHandler);
        renderer.off(core.CliRenderEvents.RESIZE, resizeHandler);
        destroyCurrentRoot(renderer, currentRoot);
        currentRoot = null;
      } finally {
        renderer.destroy();
      }
    },
    render(frame) {
      if (destroyed) return;
      currentFrame = frame;
      destroyCurrentRoot(renderer, currentRoot);
      currentRoot = renderOpenTuiFrame(core, renderer, frame, theme);
      renderer.root.add(currentRoot);
      renderer.requestRender();
    },
  };

  return facade;
}

type OpenTuiModule = typeof import("@opentui/core");

function renderOpenTuiFrame(
  core: OpenTuiModule,
  renderer: CliRenderer,
  frame: RenderFrame,
  theme: TuiTheme,
): Renderable {
  const root = new core.BoxRenderable(renderer, {
    flexDirection: "column",
    height: "100%",
    id: "video-digest-screen",
    padding: frame.view.kind === "small-terminal" ? 1 : 2,
    width: "100%",
    ...colorOption("backgroundColor", theme.background),
  });

  root.add(new core.TextRenderable(renderer, {
    content: frame.view.title,
    height: 1,
    id: "screen-title",
    ...colorOption("fg", theme.accent),
  }));
  if (frame.view.subtitle) {
    root.add(new core.TextRenderable(renderer, {
      content: frame.view.subtitle,
      height: 1,
      id: "screen-subtitle",
      marginTop: 1,
      ...colorOption("fg", theme.muted),
    }));
  }

  if (frame.view.scrollable) {
    const scroll = new core.ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      id: "screen-reader",
      marginTop: 1,
      scrollY: true,
    });
    scroll.add(new core.TextRenderable(renderer, {
      content: frame.view.body.join("\n"),
      id: "screen-reader-content",
      width: "100%",
      wrapMode: "word",
      ...colorOption("fg", theme.foreground),
    }));
    root.add(scroll);
    scroll.focus();
  } else if (frame.view.body.length > 0) {
    root.add(new core.TextRenderable(renderer, {
      content: frame.view.body.join("\n\n"),
      id: "screen-body",
      marginTop: 1,
      wrapMode: "word",
      ...colorOption("fg", theme.foreground),
    }));
  }

  if (frame.view.status) {
    root.add(new core.TextRenderable(renderer, {
      content: frame.view.status.text,
      height: 1,
      id: "screen-status",
      marginTop: 1,
      ...colorOption("fg", statusColor(frame.view.status.tone, theme)),
    }));
  }

  if (frame.view.input) {
    root.add(new core.TextRenderable(renderer, {
      content: frame.view.input.label,
      height: 1,
      id: "screen-input-label",
      marginTop: 1,
      ...colorOption("fg", theme.muted),
    }));
    const input = new core.InputRenderable(renderer, {
      id: "screen-input",
      maxLength: frame.view.input.secret ? 512 : 2048,
      placeholder: frame.view.input.placeholder,
      width: "100%",
      ...colorOption("backgroundColor", theme.surface),
      ...colorOption("focusedBackgroundColor", theme.surface),
      ...colorOption("focusedTextColor", frame.view.input.secret ? "transparent" : theme.foreground),
      ...colorOption("textColor", frame.view.input.secret ? "transparent" : theme.foreground),
    });
    if (frame.view.input.secret) {
      const mask = new core.TextRenderable(renderer, {
        content: "",
        height: 1,
        id: "screen-input-mask",
        ...colorOption("fg", theme.foreground),
      });
      input.on(core.InputRenderableEvents.INPUT, (value: string) => {
        mask.content = "•".repeat(Array.from(value).length);
      });
      root.add(mask);
    }
    input.on(core.InputRenderableEvents.ENTER, (value: string) => void frame.onSubmit(value).catch(() => undefined));
    input.focusable = !frame.view.input.disabled;
    root.add(input);
    if (frame.view.focus === "input") input.focus();
  }

  if (frame.view.options.length > 0) {
    const select = new core.SelectRenderable(renderer, {
      height: Math.min(frame.view.options.length * 2, 12),
      id: "screen-options",
      itemSpacing: 1,
      marginTop: 1,
      options: frame.view.options.map((name, index) => ({ description: "", name, value: index })),
      showDescription: false,
      showScrollIndicator: frame.view.options.length > 6,
      width: "100%",
      wrapSelection: false,
      ...colorOption("backgroundColor", theme.background),
      ...colorOption("focusedBackgroundColor", theme.background),
      ...colorOption("focusedTextColor", theme.foreground),
      ...colorOption("selectedBackgroundColor", theme.surface),
      ...colorOption("selectedTextColor", theme.accent),
      ...colorOption("textColor", theme.foreground),
    });
    select.on(core.SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
      void frame.onSelect(index).catch(() => undefined);
    });
    select.focusable = frame.view.focus === "options";
    root.add(select);
    if (frame.view.focus === "options") select.focus();
  }

  root.add(new core.TextRenderable(renderer, {
    bottom: 1,
    content: frame.view.footer,
    height: 1,
    id: "screen-footer",
    position: "absolute",
    ...colorOption("fg", theme.muted),
  }));
  return root;
}

function destroyCurrentRoot(renderer: CliRenderer, root: Renderable | null): void {
  if (!root) return;
  if (root.parent) root.parent.remove(root.id);
  if (!root.isDestroyed) root.destroyRecursively();
  renderer.requestRender();
}

function statusColor(tone: ScreenView["status"] extends infer _T
  ? "error" | "info" | "pending" | "success"
  : never, theme: TuiTheme): string | undefined {
  if (tone === "error") return theme.danger;
  if (tone === "success") return theme.success;
  if (tone === "pending") return theme.accent;
  return theme.foreground;
}

function colorOption<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as Record<K, string>;
}
