import {
  humanReadablePath,
  resultReadablePath,
  type CreationMode,
  type Effect,
  type Event,
  type Model,
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
        ? transition(model, [{ type: "prepare-runtime" }])
        : unchanged(model);
    case "runtime-ready": {
      if (model.screen !== "runtime-required") return unchanged(model);
      const ready = { ...model, message: null, runtimeReadiness: { status: "ready" } as const };
      if (model.gateOrigin === "settings") return transition({ ...ready, screen: "settings" });
      return transition(continueCreation(ready));
    }
    case "runtime-failed":
      return model.screen === "runtime-required"
        ? transition({ ...model, message: event.message, runtimeReadiness: event.readiness })
        : unchanged(model);
    case "save-credential":
      return model.screen === "credential-required" && event.value.trim().length > 0
        ? transition(model, [{ type: "save-credential", value: event.value }])
        : unchanged(model);
    case "credential-saved": {
      if (model.screen !== "credential-required") return unchanged(model);
      const configured = { ...model, credentialConfigured: true, message: null };
      return transition({
        ...configured,
        screen: model.gateOrigin === "settings" ? "settings" : "enter-url",
      });
    }
    case "credential-failed":
      return model.screen === "credential-required"
        ? transition({ ...model, message: event.message })
        : unchanged(model);
    case "submit-url": {
      if (model.screen !== "enter-url" || model.creationMode === null) return unchanged(model);
      const url = event.url.trim();
      if (url.length === 0) {
        return transition({ ...model, message: "Enter a YouTube URL." });
      }
      const effect: Effect = model.creationMode === "digest"
        ? { type: "ingest", url }
        : { type: "transcript", url };
      return transition(
        {
          ...model,
          message: model.creationMode === "digest" ? "Creating digest…" : "Getting transcript…",
          progress: null,
          screen: "progress",
          submittedUrl: url,
        },
        [effect],
      );
    }
    case "operation-progress":
      return model.screen === "progress"
        ? transition({ ...model, progress: event.message })
        : unchanged(model);
    case "operation-succeeded":
      return model.screen === "progress"
        ? transition({
            ...model,
            message: null,
            progress: null,
            reader: null,
            readerOrigin: null,
            result: event.result,
            screen: "result",
          })
        : unchanged(model);
    case "operation-failed":
      return model.screen === "progress"
        ? transition({ ...model, message: event.message, progress: null, screen: "enter-url" })
        : unchanged(model);
    case "copy-result":
      return resultTextEffect(model, "copy");
    case "print-result":
      return resultTextEffect(model, "print");
    case "reveal-result":
      return resultPathEffect(model, "reveal");
    case "read-result":
      return readResult(model);
    case "browse-library":
      return model.screen === "home"
        ? transition({ ...model, entries: [], message: null, screen: "library", selectedEntry: null }, [
            { type: "load-library" },
          ])
        : unchanged(model);
    case "library-loaded":
      return model.screen === "library"
        ? transition({ ...model, entries: event.entries, message: null, selectedEntry: null })
        : unchanged(model);
    case "library-failed":
      return model.screen === "library"
        ? transition({ ...model, message: event.message })
        : unchanged(model);
    case "select-entry":
      return model.screen === "library" && model.entries.some((item) => item.videoId === event.entry.videoId)
        ? transition({ ...model, selectedEntry: event.entry })
        : unchanged(model);
    case "read-entry":
      return readEntry(model);
    case "open-entry-externally":
      return selectedEntryPathEffect(model, "open");
    case "reader-loaded": {
      if (model.screen !== "result" && model.screen !== "library") return unchanged(model);
      const origin = model.readerOrigin ?? model.screen;
      return transition({
        ...model,
        message: null,
        reader: { content: event.content, path: event.path, title: event.title },
        readerOrigin: origin,
        screen: "reader",
      });
    }
    case "reader-failed":
      return model.screen === "result" || model.screen === "library"
        ? transition({ ...model, message: event.message })
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
        ? transition(model, [{ path, type: "save-library" }])
        : transition({ ...model, message: "Choose an Artifact Library folder." });
    }
    case "library-saved":
      return model.screen === "choose-library"
        ? transition({
            ...model,
            config: { artifactLibrary: event.path },
            message: null,
            screen: model.librarySelectionOrigin === "onboarding" ? "home" : "settings",
          })
        : unchanged(model);
    case "library-save-failed":
      return model.screen === "choose-library"
        ? transition({ ...model, message: event.message })
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
      return transition(
        {
          ...model,
          doctorOrigin: model.screen,
          doctorReport: null,
          message: null,
          screen: "doctor",
        },
        [{ type: "run-doctor" }],
      );
    }
    case "doctor-completed":
      return model.screen === "doctor"
        ? transition({ ...model, doctorReport: event.report, message: null })
        : unchanged(model);
    case "doctor-failed":
      return model.screen === "doctor"
        ? transition({ ...model, message: event.message })
        : unchanged(model);
    case "open-agent-skill":
      return model.screen === "settings"
        ? transition({ ...model, message: null, screen: "agent-skill" })
        : unchanged(model);
    case "copy-text":
      return event.text.length > 0
        ? transition(model, [{ text: event.text, type: "copy" }])
        : unchanged(model);
    case "back":
      return navigateBack(model);
    case "go-home":
      if (model.config.artifactLibrary === null) return unchanged(model);
      return transition(
        goHome(model),
        model.screen === "progress" ? [{ type: "cancel-operation" }] : [],
      );
    default:
      return assertNever(event);
  }
}

function beginCreation(model: Model, creationMode: CreationMode): Transition {
  if (model.screen !== "home") return unchanged(model);
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
  return text ? transition(model, [{ text, type }]) : unchanged(model);
}

function resultPathEffect(model: Model, type: "reveal"): Transition {
  const path = model.screen === "result" && model.result
    ? resultReadablePath(model.result)
    : null;
  return path ? transition(model, [{ path, type }]) : unchanged(model);
}

function readResult(model: Model): Transition {
  const path = model.screen === "result" && model.result
    ? resultReadablePath(model.result)
    : null;
  return path
    ? transition({ ...model, readerOrigin: "result" }, [{ path, type: "read" }])
    : unchanged(model);
}

function readEntry(model: Model): Transition {
  const path = selectedEntryPath(model);
  return path
    ? transition({ ...model, readerOrigin: "library" }, [{ path, type: "read" }])
    : unchanged(model);
}

function selectedEntryPathEffect(model: Model, type: "open"): Transition {
  const path = selectedEntryPath(model);
  return path ? transition(model, [{ path, type }]) : unchanged(model);
}

function selectedEntryPath(model: Model): string | null {
  return model.screen === "library" && model.selectedEntry
    ? humanReadablePath(model.selectedEntry)
    : null;
}

function navigateBack(model: Model): Transition {
  switch (model.screen) {
    case "choose-library":
      return model.librarySelectionOrigin === "settings"
        ? transition({ ...model, message: null, screen: "settings" })
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
        ? transition({ ...model, message: null, screen: "settings" })
        : transition(goHome(model));
    case "progress":
      return transition(goHome(model), [{ type: "cancel-operation" }]);
    case "reader":
      return transition({
        ...model,
        message: null,
        reader: null,
        screen: model.readerOrigin ?? "home",
      });
    case "doctor":
      return transition({ ...model, message: null, screen: model.doctorOrigin });
    case "agent-skill":
      return transition({ ...model, message: null, screen: "settings" });
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
    progress: null,
    reader: null,
    readerOrigin: null,
    result: null,
    screen: "home",
    selectedEntry: null,
    submittedUrl: null,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled TUI state: ${JSON.stringify(value)}`);
}
