import type { DoctorCheck } from "../cli/doctor";
import type { LibraryEntrySnapshot, Model, Screen } from "./model";

export const MIN_TERMINAL_SIZE = Object.freeze({ height: 18, width: 60 });
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const TUI_COPY = Object.freeze({
  agentSkill: {
    install: "gh skill install miguelgarglez/personal-video-digest video-digest",
    preview: "gh skill preview miguelgarglez/personal-video-digest video-digest",
  },
  footer: {
    back: "Esc Back",
    choose: "↑/↓ Move  Enter Choose  Esc Back",
    input: "Enter Continue  Esc Back",
    quit: "Ctrl-C Quit",
    reader: "↑/↓ Scroll  Esc Back  Ctrl-C Quit",
  },
  working: "Working…",
});

export type ScreenFocus = "body" | "input" | "none" | "options";
export type ScreenStatusTone = "error" | "info" | "pending" | "success";

export type ScreenInput = Readonly<{
  disabled: boolean;
  label: string;
  placeholder: string;
  secret: boolean;
}>;

export type AccessibilityKey = Readonly<{
  key: string;
  label: string;
}>;

export type ScreenAction =
  | { type: "choose-digest" }
  | { type: "choose-transcript" }
  | { type: "browse-library" }
  | { type: "open-settings" }
  | { type: "open-doctor" }
  | { type: "prepare-runtime" }
  | { type: "read-result" }
  | { type: "copy-result" }
  | { type: "print-result" }
  | { type: "reveal-result" }
  | { type: "go-home" }
  | { type: "select-entry"; videoId: string }
  | { type: "change-library" }
  | { type: "open-runtime-setup" }
  | { type: "open-credential-setup" }
  | { type: "open-agent-skill" }
  | { type: "copy-text"; text: string };

export type ScreenView = Readonly<{
  actions: readonly ScreenAction[];
  body: readonly string[];
  focus: ScreenFocus;
  footer: string;
  input: ScreenInput | null;
  keys: readonly AccessibilityKey[];
  kind: Screen | "small-terminal";
  options: readonly string[];
  preview: null;
  scrollable: boolean;
  status: Readonly<{ text: string; tone: ScreenStatusTone }> | null;
  subtitle?: string;
  title: string;
}>;

export type ScreenDimensions = Readonly<{ height: number; width: number }>;

type MutableView = {
  actions?: ScreenAction[];
  body?: string[];
  focus?: ScreenFocus;
  footer?: string;
  input?: Omit<ScreenInput, "disabled">;
  keys?: AccessibilityKey[];
  options?: string[];
  scrollable?: boolean;
  status?: ScreenView["status"];
  subtitle?: string;
  title: string;
};

export function buildScreenView(model: Model, dimensions?: ScreenDimensions): ScreenView {
  if (dimensions && isSmallTerminal(dimensions)) return smallTerminalView();

  const pending = model.pending !== null;
  const lineLimit = dimensions ? Math.max(12, Math.min(160, dimensions.width - 8)) : 160;
  const source = viewForScreen(model);
  const messageStatus = model.message
    ? { text: sanitizeLine(model.message), tone: "error" as const }
    : null;
  const status = model.screen === "progress"
    ? source.status
    : pending
      ? { text: TUI_COPY.working, tone: "pending" as const }
      : messageStatus ?? source.status;
  const input = source.input ? { ...source.input, disabled: pending } : null;
  const focus = pending ? "none" : source.focus ?? inferFocus(source, input);

  return Object.freeze({
    actions: Object.freeze(source.actions ?? []),
    body: Object.freeze((source.body ?? []).map((text) => sanitizeDisplayText(text, lineLimit))),
    focus,
    footer: source.footer ?? defaultFooter(focus),
    input,
    keys: Object.freeze(source.keys ?? defaultKeys(focus)),
    kind: model.screen,
    options: Object.freeze((source.options ?? []).map((text) => boundLine(sanitizeLine(text), lineLimit))),
    preview: null,
    scrollable: source.scrollable ?? false,
    status: status ? { ...status, text: boundLine(sanitizeLine(status.text), lineLimit) } : null,
    ...(source.subtitle ? { subtitle: boundLine(sanitizeLine(source.subtitle), lineLimit) } : {}),
    title: boundLine(sanitizeLine(source.title), lineLimit),
  });
}

function viewForScreen(model: Model): MutableView {
  switch (model.screen) {
    case "choose-library":
      return {
        body: ["Choose where Video Digest will keep Transcripts, Digests, and metadata."],
        input: { label: "Artifact Library folder", placeholder: "~/Documents/Video Digest", secret: false },
        title: "Choose your Artifact Library",
      };
    case "home":
      return {
        actions: [
          { type: "choose-digest" },
          { type: "choose-transcript" },
          { type: "browse-library" },
          { type: "open-settings" },
          { type: "open-doctor" },
        ],
        options: ["Create Digest", "Get Transcript", "Browse Library", "Setup & Settings", "Diagnostics"],
        subtitle: "Turn a YouTube video into useful, durable artifacts.",
        title: "Video Digest",
      };
    case "enter-url":
      return {
        input: { label: "YouTube URL", placeholder: "https://www.youtube.com/watch?v=…", secret: false },
        title: model.creationMode === "digest" ? "Create Digest" : "Get Transcript",
      };
    case "runtime-required":
      return {
        actions: [{ type: "prepare-runtime" }],
        body: [
          "Transcript support uses an isolated managed Python runtime.",
          runtimeRemediation(model),
        ],
        options: ["Set Up Transcript Runtime"],
        title: "Transcript runtime required",
      };
    case "credential-required":
      return {
        body: ["Digest creation needs an OpenCode API key. It is stored in macOS Keychain."],
        input: { label: "OpenCode API key", placeholder: "Paste API key", secret: true },
        title: "OpenCode credential required",
      };
    case "progress":
      return {
        body: ["You can press Esc to cancel and return home."],
        focus: "none",
        status: {
          text: sanitizeLine(model.progress ?? model.message ?? "Starting…"),
          tone: "pending",
        },
        title: model.creationMode === "digest" ? "Creating Digest" : "Getting Transcript",
      };
    case "result":
      return resultView(model);
    case "reader":
      return {
        body: model.reader ? [model.reader.content] : ["The artifact could not be loaded."],
        focus: "body",
        footer: TUI_COPY.footer.reader,
        keys: [
          { key: "Arrow keys", label: "Scroll" },
          { key: "Escape", label: "Back" },
          { key: "Ctrl-C", label: "Quit" },
        ],
        scrollable: true,
        subtitle: model.reader?.displayPath,
        title: model.reader?.title ?? "Artifact",
      };
    case "library":
      return libraryView(model);
    case "settings":
      return {
        actions: [
          { type: "change-library" },
          { type: "open-runtime-setup" },
          { type: "open-credential-setup" },
          { type: "open-agent-skill" },
        ],
        body: [`Artifact Library: ${model.config.artifactLibrary ?? "Not configured"}`],
        options: [
          "Change Artifact Library",
          "Set Up Transcript Runtime",
          "Configure OpenCode Credential",
          "Agent Skill",
        ],
        title: "Setup & Settings",
      };
    case "doctor":
      return doctorView(model);
    case "agent-skill":
      return {
        actions: [
          { text: TUI_COPY.agentSkill.preview, type: "copy-text" },
          { text: TUI_COPY.agentSkill.install, type: "copy-text" },
        ],
        body: [
          "The Video Digest Agent Skill teaches compatible agents to use the stable CLI safely.",
          "Review the skill before installing it. This screen never runs an installation command.",
          ".agents/skills/video-digest/SKILL.md",
          TUI_COPY.agentSkill.preview,
          TUI_COPY.agentSkill.install,
        ],
        options: ["Copy Preview Command", "Copy Install Command"],
        title: "Agent Skill",
      };
    default:
      return assertNever(model.screen);
  }
}

function resultView(model: Model): MutableView {
  const result = model.result;
  if (!result) return { body: ["The result is no longer available."], focus: "none", title: "Result unavailable" };

  const actions: ScreenAction[] = [{ type: "read-result" }];
  const options = ["Open Artifact"];
  if (result.kind === "transcript" && result.cleanText) {
    actions.push({ type: "copy-result" }, { type: "print-result" });
    options.push("Copy Transcript", "Print Transcript");
  }
  actions.push({ type: "reveal-result" }, { type: "go-home" });
  options.push("Reveal in Finder", "Return Home");

  return {
    actions,
    body: [entryLabel(result.entry)],
    options,
    status: { text: "Saved to the Artifact Library.", tone: "success" },
    title: result.kind === "digest" ? "Digest ready" : "Transcript ready",
  };
}

function libraryView(model: Model): MutableView {
  if (model.pending?.kind === "load-library") {
    return { body: ["Loading Library Entries…"], focus: "none", title: "Artifact Library" };
  }
  if (model.entries.length === 0) {
    return { body: ["No Library Entries yet."], focus: "none", title: "Artifact Library" };
  }
  return {
    actions: model.entries.map((entry) => ({ type: "select-entry", videoId: entry.videoId })),
    options: model.entries.map(entryLabel),
    subtitle: "Choose an entry to read its preferred artifact.",
    title: "Artifact Library",
  };
}

function doctorView(model: Model): MutableView {
  if (!model.doctorReport) {
    return { body: ["Running diagnostics…"], focus: "none", title: "Diagnostics" };
  }
  return {
    body: model.doctorReport.checks.flatMap(formatDoctorCheck),
    focus: "none",
    status: {
      text: model.doctorReport.ok ? "Core diagnostics passed." : "Some checks need attention.",
      tone: model.doctorReport.ok ? "success" : "error",
    },
    title: "Diagnostics",
  };
}

function formatDoctorCheck(check: Readonly<DoctorCheck>): string[] {
  const status = check.status.toUpperCase().padEnd(5);
  const lines = [`${status} ${sanitizeLine(check.message)}`];
  if (check.remediation) lines.push(`      ${sanitizeLine(check.remediation)}`);
  return lines;
}

function entryLabel(entry: LibraryEntrySnapshot): string {
  const title = sanitizeLine(entry.title ?? entry.videoId);
  const channel = entry.channel ? sanitizeLine(entry.channel) : null;
  return channel ? `${title} — ${channel}` : title;
}

function runtimeRemediation(model: Model): string {
  return model.runtimeReadiness.status === "ready"
    ? "The runtime is ready."
    : model.runtimeReadiness.remediation;
}

function inferFocus(source: MutableView, input: ScreenInput | null): ScreenFocus {
  if (input) return "input";
  if ((source.options?.length ?? 0) > 0) return "options";
  if (source.scrollable) return "body";
  return "none";
}

function defaultFooter(focus: ScreenFocus): string {
  if (focus === "options") return TUI_COPY.footer.choose;
  if (focus === "input") return TUI_COPY.footer.input;
  return `${TUI_COPY.footer.back}  ${TUI_COPY.footer.quit}`;
}

function defaultKeys(focus: ScreenFocus): AccessibilityKey[] {
  const keys: AccessibilityKey[] = [];
  if (focus === "options") keys.push({ key: "Arrow keys", label: "Move" }, { key: "Enter", label: "Choose" });
  if (focus === "input") keys.push({ key: "Enter", label: "Continue" });
  keys.push({ key: "Escape", label: "Back" }, { key: "Ctrl-C", label: "Quit" });
  return keys;
}

function isSmallTerminal(dimensions: ScreenDimensions): boolean {
  return dimensions.width < MIN_TERMINAL_SIZE.width || dimensions.height < MIN_TERMINAL_SIZE.height;
}

function smallTerminalView(): ScreenView {
  return Object.freeze({
    actions: Object.freeze([]),
    body: Object.freeze([
      `Video Digest needs at least ${MIN_TERMINAL_SIZE.width}×${MIN_TERMINAL_SIZE.height} characters. Enlarge the terminal to continue.`,
    ]),
    focus: "none",
    footer: TUI_COPY.footer.quit,
    input: null,
    keys: Object.freeze([{ key: "Ctrl-C", label: "Quit" }]),
    kind: "small-terminal",
    options: Object.freeze([]),
    preview: null,
    scrollable: false,
    status: null,
    title: "Terminal too small",
  });
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0090\u009D-\u009F][\s\S]*?(?:\u0007|\u009C|\u001B\\)/g, "")
    .replace(/\u001B[P^_X][\s\S]*?\u001B\\/g, "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u009B[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/\p{Cf}/gu, (character) => character === "\u200C" || character === "\u200D" ? character : "");
}

function sanitizeLine(value: string): string {
  return sanitizeTerminalText(value).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function sanitizeDisplayText(value: string, limit: number): string {
  return sanitizeTerminalText(value)
    .split(/\r?\n/)
    .map((line) => boundLine(line, limit))
    .join("\n");
}

function boundLine(value: string, limit: number): string {
  const hardLimit = 160;
  const targetWidth = Math.max(1, limit - 1);
  const codePoints = Array.from(value);
  let truncated = codePoints.length > hardLimit;
  const hardBounded = truncated
    ? codePoints.slice(0, hardLimit - 1).join("").replace(/[\u200C\u200D]+$/u, "")
    : value;
  const segments = GRAPHEME_SEGMENTER.segment(hardBounded);
  let bounded = "";
  let graphemes = 0;
  let width = 0;
  for (const { segment } of segments) {
    const segmentWidth = Bun.stringWidth(segment);
    if (graphemes >= targetWidth || width + segmentWidth > targetWidth) {
      truncated = true;
      break;
    }
    bounded += segment;
    graphemes += 1;
    width += segmentWidth;
  }
  return truncated ? `${bounded}…` : bounded;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled screen: ${String(value)}`);
}
