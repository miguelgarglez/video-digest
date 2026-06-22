import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import type { Event, Model } from "./model";
import { createSecretEditor, type SecretEditor } from "./secret-editor";
import { buildScreenView, type ScreenAction, type ScreenStatusTone, type ScreenView } from "./screens";
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
  ownsRenderer?: boolean;
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
  return bindOpenTuiFacade(core, renderer, { ...options, ownsRenderer: true });
}

export async function createOpenTuiFacadeFromRenderer(
  renderer: CliRenderer,
  options: CreateOpenTuiFacadeOptions = {},
): Promise<OpenTuiFacade> {
  const core = await import("@opentui/core");
  return bindOpenTuiFacade(core, renderer, options);
}

type OpenTuiModule = typeof import("@opentui/core");

function bindOpenTuiFacade(
  core: OpenTuiModule,
  renderer: CliRenderer,
  options: CreateOpenTuiFacadeOptions,
): OpenTuiFacade {
  const theme = createTheme(options.env ?? process.env);
  const ownsRenderer = options.ownsRenderer ?? false;
  let destroyed = false;
  let currentRoot: Renderable | null = null;
  let currentFrame: RenderFrame | null = null;
  let secretEditor: SecretEditor | null = null;
  const noColorPostProcess = theme.colorEnabled ? null : createNoColorPostProcess(core);

  const keyHandler = (key: KeyEvent): void => {
    const frame = currentFrame;
    if (!frame || destroyed) return;
    if (isTerminalExitKey(key)) secretEditor?.clear();
    if (frame.onKey({ ctrl: key.ctrl, meta: key.meta, name: key.name, shift: key.shift })) {
      key.preventDefault();
      key.stopPropagation();
    }
  };
  const resizeHandler = (): void => currentFrame?.onResize();
  renderer.keyInput.on("keypress", keyHandler);
  renderer.on(core.CliRenderEvents.RESIZE, resizeHandler);
  if (noColorPostProcess) renderer.addPostProcessFn(noColorPostProcess);

  const facade: OpenTuiFacade = {
    get dimensions() {
      return { height: renderer.terminalHeight, width: renderer.terminalWidth };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      currentFrame = null;
      secretEditor?.clear();
      secretEditor = null;
      try {
        renderer.keyInput.off("keypress", keyHandler);
        renderer.off(core.CliRenderEvents.RESIZE, resizeHandler);
        if (noColorPostProcess) renderer.removePostProcessFn(noColorPostProcess);
        destroyCurrentRoot(renderer, currentRoot);
        currentRoot = null;
      } finally {
        if (ownsRenderer) renderer.destroy();
      }
    },
    render(frame) {
      if (destroyed) return;
      currentFrame = frame;
      if (frame.view.input?.secret) {
        secretEditor ??= createSecretEditor();
      } else {
        secretEditor?.clear();
        secretEditor = null;
      }
      destroyCurrentRoot(renderer, currentRoot);
      currentRoot = renderOpenTuiFrame(core, renderer, frame, theme, secretEditor);
      renderer.root.add(currentRoot);
      renderer.requestRender();
    },
  };

  return facade;
}

function renderOpenTuiFrame(
  core: OpenTuiModule,
  renderer: CliRenderer,
  frame: RenderFrame,
  theme: TuiTheme,
  secretEditor: SecretEditor | null,
): Renderable {
  const root = new core.BoxRenderable(renderer, {
    flexDirection: "column",
    height: "100%",
    id: "video-digest-screen",
    padding: 1,
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

  if (frame.view.body.length > 0) {
    const scroll = new core.ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      flexShrink: 1,
      id: "screen-reader",
      marginTop: 1,
      minHeight: 1,
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
    scroll.focusable = frame.view.focus === "body";
    if (frame.view.focus === "body") scroll.focus();
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
    if (frame.view.input.secret) {
      if (!secretEditor) throw new Error("Secret editor is unavailable.");
      const mask = new core.TextRenderable(renderer, {
        content: secretEditor.mask,
        height: 1,
        id: "screen-secret-input",
        selectable: false,
        width: "100%",
        ...colorOption("fg", theme.foreground),
      });
      mask.focusable = !frame.view.input.disabled;
      mask.onKeyDown = (key) => secretEditor.handleKey(key, (value) => {
        void frame.onSubmit(value).catch(() => undefined);
      });
      mask.onPaste = (event) => secretEditor.handlePaste(event);
      secretEditor.attach(mask);
      root.add(mask);
      if (frame.view.focus === "input") mask.focus();
    } else {
      const input = new core.InputRenderable(renderer, {
        id: "screen-input",
        maxLength: 2048,
        placeholder: frame.view.input.placeholder,
        width: "100%",
        ...colorOption("backgroundColor", theme.surface),
        ...colorOption("focusedBackgroundColor", theme.surface),
        ...colorOption("focusedTextColor", theme.foreground),
        ...colorOption("textColor", theme.foreground),
      });
      input.on(core.InputRenderableEvents.ENTER, (value: string) => void frame.onSubmit(value).catch(() => undefined));
      input.focusable = !frame.view.input.disabled;
      root.add(input);
      if (frame.view.focus === "input") input.focus();
    }
  }

  if (frame.view.options.length > 0) {
    const selectHeight = availableSelectHeight(renderer, frame.view);
    const select = new core.SelectRenderable(renderer, {
      height: selectHeight,
      id: "screen-options",
      itemSpacing: 0,
      marginTop: 1,
      options: frame.view.options.map((name, index) => ({ description: "", name, value: index })),
      showDescription: false,
      showScrollIndicator: frame.view.options.length > selectHeight,
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
    content: frame.view.footer,
    height: 1,
    id: "screen-footer",
    marginTop: 1,
    ...colorOption("fg", theme.muted),
  }));
  return root;
}

function isTerminalExitKey(key: KeyEvent): boolean {
  const name = key.name.toLowerCase();
  return (key.ctrl && name === "c") || (!key.ctrl && !key.meta && (name === "escape" || name === "esc"));
}

function availableSelectHeight(renderer: CliRenderer, view: ScreenView): number {
  const reserved = 2 + 1 + (view.subtitle ? 2 : 0) + (view.body.length > 0 ? 2 : 0) +
    (view.status ? 2 : 0) + (view.input ? 3 : 0) + 1 + 2;
  const available = Math.max(1, renderer.terminalHeight - reserved);
  return Math.min(view.options.length, available);
}

function destroyCurrentRoot(renderer: CliRenderer, root: Renderable | null): void {
  if (!root) return;
  if (root.parent) root.parent.remove(root.id);
  if (!root.isDestroyed) root.destroyRecursively();
  renderer.requestRender();
}

function statusColor(tone: ScreenStatusTone, theme: TuiTheme): string | undefined {
  if (tone === "error") return theme.danger;
  if (tone === "success") return theme.success;
  if (tone === "pending") return theme.accent;
  return theme.foreground;
}

function colorOption<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as Record<K, string>;
}

function createNoColorPostProcess(core: OpenTuiModule): (buffer: import("@opentui/core").OptimizedBuffer) => void {
  const foreground = core.RGBA.defaultForeground().buffer;
  const background = core.RGBA.defaultBackground().buffer;
  return (buffer) => {
    const colors = buffer.buffers;
    for (let index = 0; index < colors.fg.length; index += 4) {
      colors.fg.set(foreground, index);
      colors.bg.set(background, index);
    }
  };
}
