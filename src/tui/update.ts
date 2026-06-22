import { parseYouTubeVideoUrl } from "../video/youtube-url";
import type { DoctorReport } from "../cli/doctor";
import type { RuntimeReadiness } from "../cli/runtime-manager";
import {
  type CreationMode,
  type Effect,
  type Event,
  type Model,
  type LibraryEntrySnapshot,
  type LibraryTarget,
  type PendingKind,
  type PendingPolicy,
  type RequestId,
  type ResultData,
  type Screen,
  type Transition,
} from "./model";

const unchanged = (model: Model): Transition => ({ effects: [], model });
const transition = (model: Model, effects: Effect[] = []): Transition => ({ effects, model });

export function update(model: Model, event: Event): Transition {
  switch (event.type) {
    case "choose-digest":
      return beginCreation(model, "digest");
    case "choose-transcript":
      return beginCreation(model, "transcript");
    case "prepare-runtime":
      return model.screen === "runtime-required"
        ? startRequest(model, "prepare-runtime", (requestId) => ({ requestId, type: "prepare-runtime" }))
        : unchanged(model);
    case "runtime-ready": {
      if (!matchesPending(model, "prepare-runtime", event.requestId) || model.screen !== "runtime-required") {
        return unchanged(model);
      }
      const ready = clearPending({ ...model, message: null, runtimeReadiness: { status: "ready" } as const });
      return model.gateOrigin === "settings"
        ? transition({ ...ready, screen: "settings" })
        : transition(continueCreation(ready));
    }
    case "runtime-failed":
      return matchesPending(model, "prepare-runtime", event.requestId) && model.screen === "runtime-required"
        ? transition(clearPending({
            ...model,
            message: event.message,
            runtimeReadiness: cloneRuntimeReadiness(event.readiness),
          }))
        : unchanged(model);
    case "save-credential": {
      if (model.screen !== "credential-required") return unchanged(model);
      const value = event.value.trim();
      if (value.length === 0) return transition({ ...model, message: "Enter an OpenCode API key." });
      return startRequest(model, "save-credential", (requestId) => ({
        requestId,
        type: "save-credential",
        value,
      }));
    }
    case "credential-saved": {
      if (!matchesPending(model, "save-credential", event.requestId) || model.screen !== "credential-required") {
        return unchanged(model);
      }
      return transition(clearPending({
        ...model,
        credentialConfigured: true,
        message: null,
        screen: model.gateOrigin === "settings" ? "settings" : "enter-url",
      }));
    }
    case "credential-failed":
      return matchesPending(model, "save-credential", event.requestId) && model.screen === "credential-required"
        ? transition(clearPending({ ...model, message: event.message }))
        : unchanged(model);
    case "submit-url":
      return submitUrl(model, event.url);
    case "operation-progress":
      return matchesOperation(model, event.requestId) && model.screen === "progress"
        ? transition({ ...model, progress: event.message })
        : unchanged(model);
    case "operation-succeeded": {
      if (
        !matchesOperation(model, event.requestId) ||
        model.screen !== "progress" ||
        !resultMatchesOperation(model.pending!.kind, event.result.kind)
      ) {
        return unchanged(model);
      }
      return transition(clearPending({
        ...model,
        message: null,
        progress: null,
        reader: null,
        readerOrigin: null,
        result: cloneResult(event.result),
        screen: "result",
      }));
    }
    case "operation-failed":
      return matchesOperation(model, event.requestId) && model.screen === "progress"
        ? transition(clearPending({ ...model, message: event.message, progress: null, screen: "enter-url" }))
        : unchanged(model);
    case "copy-result":
      return resultTextEffect(model, "copy");
    case "print-result":
      return resultTextEffect(model, "print");
    case "reveal-result":
      return resultPathEffect(model, "reveal");
    case "read-result":
      return readResult(model);
    case "browse-library": {
      if (model.screen !== "home") return unchanged(model);
      const libraryModel = { ...model, entries: [], message: null, screen: "library" as const, selectedEntry: null };
      return startRequest(libraryModel, "load-library", (requestId) => ({ requestId, type: "load-library" }));
    }
    case "library-loaded":
      return matchesPending(model, "load-library", event.requestId) && model.screen === "library"
        ? transition(clearPending({
            ...model,
            entries: event.entries.map(cloneLibraryEntry),
            message: null,
            selectedEntry: null,
          }))
        : unchanged(model);
    case "library-failed":
      return matchesPending(model, "load-library", event.requestId) && model.screen === "library"
        ? transition(clearPending({ ...model, message: event.message }))
        : unchanged(model);
    case "select-entry": {
      if (model.screen !== "library") return unchanged(model);
      const selectedEntry = model.entries.find((item) => item.videoId === event.videoId);
      return selectedEntry ? transition({ ...model, selectedEntry: cloneLibraryEntry(selectedEntry) }) : unchanged(model);
    }
    case "read-entry":
      return readEntry(model);
    case "open-entry-externally":
      return selectedEntryPathEffect(model, "open");
    case "reader-loaded": {
      if (
        !matchesPending(model, "read", event.requestId) ||
        (model.screen !== "result" && model.screen !== "library")
      ) {
        return unchanged(model);
      }
      const origin = model.readerOrigin ?? model.screen;
      return transition(clearPending({
        ...model,
        message: null,
        reader: { content: event.content, displayPath: event.displayPath, title: event.title },
        readerOrigin: origin,
        screen: "reader",
      }));
    }
    case "reader-failed":
      return matchesPending(model, "read", event.requestId) &&
        (model.screen === "result" || model.screen === "library")
        ? transition(clearPending({ ...model, message: event.message }))
        : unchanged(model);
    case "open-settings":
      return model.screen === "home"
        ? transition({ ...model, message: null, screen: "settings" })
        : unchanged(model);
    case "change-library":
      return model.screen === "settings"
        ? transition({ ...model, librarySelectionOrigin: "settings", message: null, screen: "choose-library" })
        : unchanged(model);
    case "save-library": {
      if (model.screen !== "choose-library") return unchanged(model);
      const path = event.path.trim();
      return path.length > 0
        ? startRequest(model, "save-library", (requestId) => ({ path, requestId, type: "save-library" }))
        : transition({ ...model, message: "Choose an Artifact Library folder." });
    }
    case "library-saved":
      return matchesPending(model, "save-library", event.requestId) && model.screen === "choose-library"
        ? transition(clearPending({
            ...model,
            config: { artifactLibrary: event.path },
            message: null,
            screen: model.librarySelectionOrigin === "onboarding" ? "home" : "settings",
          }))
        : unchanged(model);
    case "library-save-failed":
      return matchesPending(model, "save-library", event.requestId) && model.screen === "choose-library"
        ? transition(clearPending({ ...model, message: event.message }))
        : unchanged(model);
    case "open-runtime-setup":
      return model.screen === "settings"
        ? transition({ ...model, gateOrigin: "settings", message: null, screen: "runtime-required" })
        : unchanged(model);
    case "open-credential-setup":
      return model.screen === "settings"
        ? transition({ ...model, gateOrigin: "settings", message: null, screen: "credential-required" })
        : unchanged(model);
    case "open-doctor": {
      if (model.screen !== "home" && model.screen !== "settings") return unchanged(model);
      const doctorModel = {
        ...model,
        doctorOrigin: model.screen,
        doctorReport: null,
        message: null,
        screen: "doctor" as const,
      };
      return startRequest(doctorModel, "run-doctor", (requestId) => ({ requestId, type: "run-doctor" }));
    }
    case "doctor-completed":
      return matchesPending(model, "run-doctor", event.requestId) && model.screen === "doctor"
        ? transition(clearPending({ ...model, doctorReport: cloneDoctorReport(event.report), message: null }))
        : unchanged(model);
    case "doctor-failed":
      return matchesPending(model, "run-doctor", event.requestId) && model.screen === "doctor"
        ? transition(clearPending({ ...model, message: event.message }))
        : unchanged(model);
    case "open-agent-skill":
      return model.screen === "settings"
        ? transition({ ...model, message: null, screen: "agent-skill" })
        : unchanged(model);
    case "copy-text":
      return event.text.length > 0
        ? startRequest(model, "copy", (requestId) => ({ requestId, text: event.text, type: "copy" }))
        : unchanged(model);
    case "system-action-completed":
      return matchesSystemAction(model, event.requestId)
        ? transition(clearPending({ ...model, message: null }))
        : unchanged(model);
    case "system-action-failed":
      return matchesSystemAction(model, event.requestId)
        ? transition(clearPending({ ...model, message: event.message }))
        : unchanged(model);
    case "back":
      return navigateBackWithPendingPolicy(model);
    case "go-home": {
      if (model.config.artifactLibrary === null) return unchanged(model);
      return navigateHomeWithPendingPolicy(model);
    }
    default:
      return assertNever(event);
  }
}

function submitUrl(model: Model, input: string): Transition {
  if (model.screen !== "enter-url" || model.creationMode === null || model.pending) return unchanged(model);
  const candidate = input.trim();
  if (candidate.length === 0) return transition({ ...model, message: "Enter a YouTube URL." });

  let canonicalUrl: string;
  try {
    canonicalUrl = parseYouTubeVideoUrl(candidate).canonicalUrl;
  } catch {
    return transition({ ...model, message: "Enter a supported YouTube URL." });
  }

  const kind = model.creationMode === "digest" ? "ingest" : "transcript";
  const progressModel = {
    ...model,
    message: model.creationMode === "digest" ? "Creating digest…" : "Getting transcript…",
    progress: null,
    screen: "progress" as const,
    submittedUrl: canonicalUrl,
  };
  return startRequest(progressModel, kind, (requestId) => ({
    requestId,
    type: kind,
    url: canonicalUrl,
  }));
}

function beginCreation(model: Model, creationMode: CreationMode): Transition {
  if (model.screen !== "home" || model.pending) return unchanged(model);
  return transition(continueCreation({
    ...model,
    creationMode,
    gateOrigin: "creation",
    message: null,
    result: null,
    submittedUrl: null,
  }));
}

function continueCreation(model: Model): Model {
  if (model.runtimeReadiness.status !== "ready") return { ...model, screen: "runtime-required" };
  if (model.creationMode === "digest" && !model.credentialConfigured) {
    return { ...model, screen: "credential-required" };
  }
  return { ...model, screen: "enter-url" };
}

function resultTextEffect(model: Model, type: "copy" | "print"): Transition {
  const text = model.screen === "result" ? model.result?.cleanText : null;
  return text ? startRequest(model, type, (requestId) => ({ requestId, text, type })) : unchanged(model);
}

function resultPathEffect(model: Model, type: "reveal"): Transition {
  const target = resultTarget(model);
  return target ? startRequest(model, type, (requestId) => ({ requestId, target, type })) : unchanged(model);
}

function readResult(model: Model): Transition {
  if (model.pending) return unchanged(model);
  const target = resultTarget(model);
  return target
    ? startRequest({ ...model, readerOrigin: "result" }, "read", (requestId) => ({ requestId, target, type: "read" }))
    : unchanged(model);
}

function readEntry(model: Model): Transition {
  if (model.pending) return unchanged(model);
  const target = selectedEntryTarget(model);
  return target
    ? startRequest({ ...model, readerOrigin: "library" }, "read", (requestId) => ({ requestId, target, type: "read" }))
    : unchanged(model);
}

function selectedEntryPathEffect(model: Model, type: "open"): Transition {
  const target = selectedEntryTarget(model);
  return target ? startRequest(model, type, (requestId) => ({ requestId, target, type })) : unchanged(model);
}

function selectedEntryTarget(model: Model): LibraryTarget | null {
  return model.screen === "library" && model.selectedEntry
    ? { preference: "digest", videoId: model.selectedEntry.videoId }
    : null;
}

function resultTarget(model: Model): LibraryTarget | null {
  return model.screen === "result" && model.result
    ? {
        preference: model.result.kind === "transcript" ? "transcript" : "digest",
        videoId: model.result.entry.videoId,
      }
    : null;
}

function startRequest<K extends PendingKind>(
  model: Model,
  kind: K,
  effect: (requestId: RequestId) => Extract<Effect, { type: K }>,
): Transition {
  if (model.pending) return unchanged(model);
  const requestId = model.nextRequestId;
  return transition(
    { ...model, nextRequestId: requestId + 1, pending: { kind, requestId } },
    [effect(requestId)],
  );
}

function matchesPending(model: Model, kind: PendingKind, requestId: RequestId): boolean {
  return model.pending?.kind === kind && model.pending.requestId === requestId;
}

function matchesOperation(model: Model, requestId: RequestId): boolean {
  return (matchesPending(model, "ingest", requestId) || matchesPending(model, "transcript", requestId));
}

function matchesSystemAction(model: Model, requestId: RequestId): boolean {
  return model.pending?.requestId === requestId && isSystemActionKind(model.pending.kind);
}

function isSystemActionKind(kind: PendingKind): kind is "copy" | "open" | "reveal" | "print" {
  return kind === "copy" || kind === "open" || kind === "reveal" || kind === "print";
}

function resultMatchesOperation(kind: PendingKind, resultKind: CreationMode): boolean {
  return (kind === "ingest" && resultKind === "digest") ||
    (kind === "transcript" && resultKind === "transcript");
}

function cancellationEffect(model: Model): Extract<Effect, { type: "cancel-operation" }> | null {
  if (!model.pending || (model.pending.kind !== "ingest" && model.pending.kind !== "transcript")) return null;
  return { requestId: model.pending.requestId, type: "cancel-operation" };
}

function pendingPolicy(kind: PendingKind): PendingPolicy {
  switch (kind) {
    case "save-library":
    case "prepare-runtime":
    case "save-credential":
      return "persistent-blocking";
    case "ingest":
    case "transcript":
      return "cancellable";
    case "load-library":
    case "read":
    case "run-doctor":
    case "copy":
    case "open":
    case "reveal":
    case "print":
      return "dismissible";
    default:
      return assertNever(kind);
  }
}

function navigateBackWithPendingPolicy(model: Model): Transition {
  if (!model.pending) return navigateBack(model);

  const policy = pendingPolicy(model.pending.kind);
  switch (policy) {
    case "persistent-blocking":
      return unchanged(model);
    case "cancellable": {
      const cancellation = cancellationEffect(model);
      return transition(goHome(model), cancellation ? [cancellation] : []);
    }
    case "dismissible":
      return navigateBack(model);
    default:
      return assertNever(policy);
  }
}

function navigateHomeWithPendingPolicy(model: Model): Transition {
  if (!model.pending) return transition(goHome(model));

  const policy = pendingPolicy(model.pending.kind);
  switch (policy) {
    case "persistent-blocking":
      return unchanged(model);
    case "cancellable": {
      const cancellation = cancellationEffect(model);
      return transition(goHome(model), cancellation ? [cancellation] : []);
    }
    case "dismissible":
      return transition(goHome(model));
    default:
      return assertNever(policy);
  }
}

function cloneLibraryEntry(entry: LibraryEntrySnapshot): LibraryEntrySnapshot {
  return {
    channel: entry.channel,
    paths: { ...entry.paths },
    title: entry.title,
    updatedAt: entry.updatedAt,
    videoId: entry.videoId,
  };
}

function cloneResult(result: ResultData): ResultData {
  return {
    cleanText: result.cleanText,
    entry: cloneLibraryEntry(result.entry),
    kind: result.kind,
  };
}

function cloneDoctorReport(report: DoctorReport): DoctorReport {
  return {
    checks: report.checks.map((check) => ({ ...check })),
    ok: report.ok,
  };
}

function cloneRuntimeReadiness(readiness: RuntimeReadiness): RuntimeReadiness {
  return { ...readiness };
}

function navigateBack(model: Model): Transition {
  switch (model.screen) {
    case "choose-library":
      return model.librarySelectionOrigin === "settings"
        ? transition(clearPending({ ...model, message: null, screen: "settings" }))
        : transition(model, [{ type: "quit" }]);
    case "home":
      return transition(model, [{ type: "quit" }]);
    case "enter-url":
    case "result":
    case "library":
    case "settings":
      return transition(goHome(model));
    case "runtime-required":
    case "credential-required":
      return model.gateOrigin === "settings"
        ? transition(clearPending({ ...model, message: null, screen: "settings" }))
        : transition(goHome(model));
    case "progress": {
      const cancellation = cancellationEffect(model);
      return transition(goHome(model), cancellation ? [cancellation] : []);
    }
    case "reader":
      return transition(clearPending({
        ...model,
        message: null,
        reader: null,
        screen: model.readerOrigin ?? "home",
      }));
    case "doctor":
      return transition(clearPending({ ...model, message: null, screen: model.doctorOrigin }));
    case "agent-skill":
      return transition(clearPending({ ...model, message: null, screen: "settings" }));
    default:
      return assertNever(model.screen);
  }
}

function goHome(model: Model): Model {
  return {
    ...model,
    creationMode: null,
    gateOrigin: "creation",
    message: null,
    pending: null,
    progress: null,
    reader: null,
    readerOrigin: null,
    result: null,
    screen: "home",
    selectedEntry: null,
    submittedUrl: null,
  };
}

function clearPending(model: Model): Model {
  return { ...model, pending: null };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled TUI state: ${JSON.stringify(value)}`);
}
