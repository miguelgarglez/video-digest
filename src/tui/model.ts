import type { LibraryEntry } from "../cli/artifacts";
import type { DoctorReport } from "../cli/doctor";
import type { RuntimeReadiness } from "../cli/runtime-manager";

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
  | "doctor"
  | "agent-skill";

export type CreationMode = "digest" | "transcript";
export type ReaderOrigin = "result" | "library";
export type GateOrigin = "creation" | "settings";
export type LibrarySelectionOrigin = "onboarding" | "settings";

export type TuiConfig = {
  artifactLibrary: string | null;
};

export type ResultData = {
  cleanText: string | null;
  entry: LibraryEntry;
  kind: CreationMode;
};

export type ReaderData = {
  content: string;
  path: string;
  title: string;
};

export type Model = {
  config: TuiConfig;
  credentialConfigured: boolean;
  creationMode: CreationMode | null;
  doctorOrigin: "home" | "settings";
  doctorReport: DoctorReport | null;
  entries: LibraryEntry[];
  gateOrigin: GateOrigin;
  librarySelectionOrigin: LibrarySelectionOrigin;
  message: string | null;
  progress: string | null;
  reader: ReaderData | null;
  readerOrigin: ReaderOrigin | null;
  result: ResultData | null;
  runtimeReadiness: RuntimeReadiness;
  screen: Screen;
  selectedEntry: LibraryEntry | null;
  submittedUrl: string | null;
};

export type InitialModelInput = {
  artifactLibrary: string | null;
  credentialConfigured?: boolean;
  runtimeReadiness?: RuntimeReadiness;
};

export function initialModel(input: InitialModelInput): Model {
  const configured = input.artifactLibrary !== null;

  return {
    config: { artifactLibrary: input.artifactLibrary },
    credentialConfigured: input.credentialConfigured ?? false,
    creationMode: null,
    doctorOrigin: "home",
    doctorReport: null,
    entries: [],
    gateOrigin: "creation",
    librarySelectionOrigin: configured ? "settings" : "onboarding",
    message: null,
    progress: null,
    reader: null,
    readerOrigin: null,
    result: null,
    runtimeReadiness: input.runtimeReadiness ?? {
      remediation: "Run video-digest setup.",
      status: "missing",
    },
    screen: configured ? "home" : "choose-library",
    selectedEntry: null,
    submittedUrl: null,
  };
}

export type Event =
  | { type: "choose-digest" }
  | { type: "choose-transcript" }
  | { type: "prepare-runtime" }
  | { type: "runtime-ready" }
  | { type: "runtime-failed"; message: string; readiness: Exclude<RuntimeReadiness, { status: "ready" }> }
  | { type: "save-credential"; value: string }
  | { type: "credential-saved" }
  | { type: "credential-failed"; message: string }
  | { type: "submit-url"; url: string }
  | { type: "operation-progress"; message: string }
  | { type: "operation-succeeded"; result: ResultData }
  | { type: "operation-failed"; message: string }
  | { type: "copy-result" }
  | { type: "print-result" }
  | { type: "reveal-result" }
  | { type: "read-result" }
  | { type: "browse-library" }
  | { type: "library-loaded"; entries: LibraryEntry[] }
  | { type: "library-failed"; message: string }
  | { type: "select-entry"; entry: LibraryEntry }
  | { type: "read-entry" }
  | { type: "open-entry-externally" }
  | { type: "reader-loaded"; content: string; path: string; title: string }
  | { type: "reader-failed"; message: string }
  | { type: "open-settings" }
  | { type: "change-library" }
  | { type: "save-library"; path: string }
  | { type: "library-saved"; path: string }
  | { type: "library-save-failed"; message: string }
  | { type: "open-runtime-setup" }
  | { type: "open-credential-setup" }
  | { type: "open-doctor" }
  | { type: "doctor-completed"; report: DoctorReport }
  | { type: "doctor-failed"; message: string }
  | { type: "open-agent-skill" }
  | { type: "copy-text"; text: string }
  | { type: "back" }
  | { type: "go-home" };

export type Effect =
  | { type: "save-library"; path: string }
  | { type: "prepare-runtime" }
  | { type: "save-credential"; value: string }
  | { type: "ingest"; url: string }
  | { type: "transcript"; url: string }
  | { type: "copy"; text: string }
  | { type: "open"; path: string }
  | { type: "reveal"; path: string }
  | { type: "print"; text: string }
  | { type: "read"; path: string }
  | { type: "load-library" }
  | { type: "run-doctor" }
  | { type: "cancel-operation" }
  | { type: "quit" };

export type Transition = {
  effects: Effect[];
  model: Model;
};

export function humanReadablePath(entry: LibraryEntry): string | null {
  return entry.paths.digestPath ?? entry.paths.transcriptMarkdownPath;
}

export function resultReadablePath(result: ResultData): string | null {
  return result.kind === "transcript"
    ? result.entry.paths.transcriptMarkdownPath
    : result.entry.paths.digestPath ?? result.entry.paths.transcriptMarkdownPath;
}
