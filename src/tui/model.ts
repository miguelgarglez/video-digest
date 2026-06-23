import type { LibraryEntry } from "../cli/artifacts";
import type { DoctorCheck, DoctorReport } from "../cli/doctor";
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
export type RequestId = number;
export type LibraryTarget = Readonly<{
  preference: "digest" | "transcript";
  videoId: string;
}>;
export type PendingKind =
  | "save-library"
  | "prepare-runtime"
  | "save-credential"
  | "ingest"
  | "transcript"
  | "copy"
  | "open"
  | "reveal"
  | "print"
  | "read"
  | "load-library"
  | "run-doctor";
export type PendingPolicy = "persistent-blocking" | "cancellable" | "dismissible";

export type PendingRequest = Readonly<{
  kind: PendingKind;
  requestId: RequestId;
}>;

export type TuiConfig = Readonly<{
  artifactLibrary: string | null;
  defaultArtifactLibrary: string;
}>;

export type LibraryEntrySnapshot = Readonly<
  Omit<LibraryEntry, "paths"> & { paths: Readonly<LibraryEntry["paths"]> }
>;

export type DoctorReportSnapshot = Readonly<{
  checks: readonly Readonly<DoctorCheck>[];
  ok: boolean;
}>;

export type ResultData = Readonly<{
  cleanText: string | null;
  entry: LibraryEntrySnapshot;
  kind: CreationMode;
}>;

export type ReaderData = Readonly<{
  content: string;
  displayPath: string;
  title: string;
}>;

export type Model = Readonly<{
  config: TuiConfig;
  credentialConfigured: boolean;
  creationMode: CreationMode | null;
  doctorOrigin: "home" | "settings";
  doctorReport: DoctorReportSnapshot | null;
  entries: readonly LibraryEntrySnapshot[];
  gateOrigin: GateOrigin;
  librarySelectionOrigin: LibrarySelectionOrigin;
  message: string | null;
  nextRequestId: RequestId;
  pending: PendingRequest | null;
  progress: string | null;
  reader: ReaderData | null;
  readerOrigin: ReaderOrigin | null;
  result: ResultData | null;
  runtimeReadiness: RuntimeReadiness;
  screen: Screen;
  selectedEntry: LibraryEntrySnapshot | null;
  submittedUrl: string | null;
}>;

export type InitialModelInput = {
  artifactLibrary: string | null;
  credentialConfigured?: boolean;
  defaultArtifactLibrary?: string;
  runtimeReadiness?: RuntimeReadiness;
};

export function initialModel(input: InitialModelInput): Model {
  const configured = input.artifactLibrary !== null;

  return {
    config: {
      artifactLibrary: input.artifactLibrary,
      defaultArtifactLibrary: input.defaultArtifactLibrary ?? input.artifactLibrary ?? "/Documents/Video Digest",
    },
    credentialConfigured: input.credentialConfigured ?? false,
    creationMode: null,
    doctorOrigin: "home",
    doctorReport: null,
    entries: [],
    gateOrigin: "creation",
    librarySelectionOrigin: configured ? "settings" : "onboarding",
    message: null,
    nextRequestId: 1,
    pending: null,
    progress: null,
    reader: null,
    readerOrigin: null,
    result: null,
    runtimeReadiness: input.runtimeReadiness
      ? { ...input.runtimeReadiness }
      : { remediation: "Run video-digest setup.", status: "missing" },
    screen: configured ? "home" : "choose-library",
    selectedEntry: null,
    submittedUrl: null,
  };
}

export type Event =
  | { type: "choose-digest" }
  | { type: "choose-transcript" }
  | { type: "prepare-runtime" }
  | { type: "runtime-ready"; requestId: RequestId }
  | { type: "runtime-failed"; message: string; readiness: Exclude<RuntimeReadiness, { status: "ready" }>; requestId: RequestId }
  | { type: "save-credential"; value: string }
  | { type: "credential-saved"; requestId: RequestId }
  | { type: "credential-failed"; message: string; requestId: RequestId }
  | { type: "submit-url"; url: string }
  | { type: "operation-progress"; message: string; requestId: RequestId }
  | { type: "operation-succeeded"; result: ResultData; requestId: RequestId }
  | { type: "operation-failed"; message: string; requestId: RequestId }
  | { type: "copy-result" }
  | { type: "print-result" }
  | { type: "reveal-result" }
  | { type: "read-result" }
  | { type: "browse-library" }
  | { type: "library-loaded"; entries: LibraryEntry[]; requestId: RequestId }
  | { type: "library-failed"; message: string; requestId: RequestId }
  | { type: "select-entry"; videoId: string }
  | { type: "read-entry" }
  | { type: "open-entry-externally" }
  | { type: "reader-loaded"; content: string; displayPath: string; title: string; requestId: RequestId }
  | { type: "reader-failed"; message: string; requestId: RequestId }
  | { type: "open-settings" }
  | { type: "change-library" }
  | { type: "save-library"; path: string }
  | { type: "library-saved"; path: string; requestId: RequestId }
  | { type: "library-save-failed"; message: string; requestId: RequestId }
  | { type: "open-runtime-setup" }
  | { type: "open-credential-setup" }
  | { type: "open-doctor" }
  | { type: "doctor-completed"; report: DoctorReport; requestId: RequestId }
  | { type: "doctor-failed"; message: string; requestId: RequestId }
  | { type: "open-agent-skill" }
  | { type: "copy-text"; text: string }
  | { type: "system-action-completed"; requestId: RequestId }
  | { type: "system-action-failed"; message: string; requestId: RequestId }
  | { type: "back" }
  | { type: "go-home" }
  | { type: "quit" };

export type Effect =
  | { type: "save-library"; path: string; requestId: RequestId }
  | { type: "prepare-runtime"; requestId: RequestId }
  | { type: "save-credential"; value: string; requestId: RequestId }
  | { type: "ingest"; url: string; requestId: RequestId }
  | { type: "transcript"; url: string; requestId: RequestId }
  | { type: "copy"; text: string; requestId: RequestId }
  | { type: "open"; target: LibraryTarget; requestId: RequestId }
  | { type: "reveal"; target: LibraryTarget; requestId: RequestId }
  | { type: "print"; text: string; requestId: RequestId }
  | { type: "read"; target: LibraryTarget; requestId: RequestId }
  | { type: "load-library"; requestId: RequestId }
  | { type: "run-doctor"; requestId: RequestId }
  | { type: "cancel-operation"; requestId: RequestId }
  | { type: "quit" };

export type Transition = {
  effects: Effect[];
  model: Model;
};
