import { basename } from "node:path";
import type { RuntimeReadiness } from "../cli/runtime-manager";
import type { Effect, Event, Model, RequestId } from "./model";
import type { TuiPorts } from "./ports";
import { update } from "./update";

export type TuiControllerOptions = Readonly<{
  onEvent?(event: Event): void;
  onModelChange?(model: Model): void;
}>;

export type TuiController = Readonly<{
  dispatch(event: Event): Promise<void>;
  getModel(): Model;
  runEffect(effect: Effect): Promise<void>;
}>;

export function createTuiController(
  initial: Model,
  ports: TuiPorts,
  options: TuiControllerOptions = {},
): TuiController {
  let model = clone(initial);
  const operations = new Map<RequestId, AbortController>();

  const applyEvent = async (event: Event, observable: boolean): Promise<void> => {
    if (observable) options.onEvent?.(clone(event));
    const transition = update(model, event);
    model = clone(transition.model);
    options.onModelChange?.(clone(model));
    await Promise.all(transition.effects.map(runEffect));
  };

  const emit = (event: Event): Promise<void> => applyEvent(event, true);

  async function runEffect(effect: Effect): Promise<void> {
    switch (effect.type) {
      case "save-library":
        try {
          await ports.config.saveArtifactLibrary(effect.path);
          await emit({ path: effect.path, requestId: effect.requestId, type: "library-saved" });
        } catch {
          await emit({
            message: "Could not save the Artifact Library. Choose another folder and try again.",
            requestId: effect.requestId,
            type: "library-save-failed",
          });
        }
        return;
      case "prepare-runtime":
        await prepareRuntime(effect.requestId);
        return;
      case "save-credential":
        await saveCredential(effect.requestId, effect.value);
        return;
      case "ingest":
      case "transcript":
        await runCreateOperation(effect);
        return;
      case "copy":
      case "open":
      case "reveal":
      case "print":
        await runSystemAction(effect);
        return;
      case "read":
        try {
          const content = await ports.reader.read(effect.path);
          await emit({
            content,
            path: effect.path,
            requestId: effect.requestId,
            title: basename(effect.path),
            type: "reader-loaded",
          });
        } catch {
          await emit({
            message: "Could not read this file. Check that it still exists and try again.",
            requestId: effect.requestId,
            type: "reader-failed",
          });
        }
        return;
      case "load-library":
        try {
          const entries = clone(await ports.library.list());
          await emit({ entries, requestId: effect.requestId, type: "library-loaded" });
        } catch {
          await emit({
            message: "Could not load the Artifact Library. Check the folder and try again.",
            requestId: effect.requestId,
            type: "library-failed",
          });
        }
        return;
      case "run-doctor":
        try {
          const report = clone(await ports.doctor.run());
          await emit({ report, requestId: effect.requestId, type: "doctor-completed" });
        } catch {
          await emit({
            message: "Diagnostics could not be completed. Try again.",
            requestId: effect.requestId,
            type: "doctor-failed",
          });
        }
        return;
      case "cancel-operation": {
        const controller = operations.get(effect.requestId);
        if (!controller) return;
        operations.delete(effect.requestId);
        controller.abort();
        return;
      }
      case "quit":
        await ports.lifecycle.quit();
        return;
      default:
        return assertNever(effect);
    }
  }

  async function prepareRuntime(requestId: RequestId): Promise<void> {
    try {
      await ports.runtime.prepare();
      const readiness = clone(await ports.runtime.readiness());
      if (readiness.status === "ready") {
        await emit({ requestId, type: "runtime-ready" });
      } else {
        await emit({
          message: "The managed runtime is not ready. Run setup again.",
          readiness: safeReadiness(readiness),
          requestId,
          type: "runtime-failed",
        });
      }
    } catch {
      let readiness: Exclude<RuntimeReadiness, { status: "ready" }> = {
        remediation: "Run video-digest setup.",
        status: "missing",
      };
      try {
        const inspected = await ports.runtime.readiness();
        if (inspected.status !== "ready") readiness = safeReadiness(inspected);
      } catch {
        // The fixed fallback intentionally does not expose service error details.
      }
      await emit({
        message: "Could not prepare the managed runtime. Run setup again.",
        readiness,
        requestId,
        type: "runtime-failed",
      });
    }
  }

  async function saveCredential(requestId: RequestId, value: string): Promise<void> {
    try {
      await ports.credential.saveOpenCodeApiKey(value);
      await emit({ requestId, type: "credential-saved" });
    } catch {
      await emit({
        message: "Could not save the OpenCode API key. Try again.",
        requestId,
        type: "credential-failed",
      });
    }
  }

  async function runCreateOperation(
    effect: Extract<Effect, { type: "ingest" | "transcript" }>,
  ): Promise<void> {
    if (operations.has(effect.requestId)) return;
    const controller = new AbortController();
    operations.set(effect.requestId, controller);
    const isCurrent = () => operations.get(effect.requestId) === controller && !controller.signal.aborted;

    try {
      const create = effect.type === "ingest" ? ports.create.ingest : ports.create.transcript;
      const result = await create(effect.url, {
        onProgress: (message) => {
          if (isCurrent()) void emit({ message, requestId: effect.requestId, type: "operation-progress" });
        },
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      operations.delete(effect.requestId);
      await emit({ requestId: effect.requestId, result: clone(result), type: "operation-succeeded" });
    } catch {
      if (!isCurrent()) return;
      operations.delete(effect.requestId);
      await emit({
        message: effect.type === "ingest"
          ? "Could not create the Digest. Check the URL and setup, then try again."
          : "Could not get the Transcript. Check the URL and setup, then try again.",
        requestId: effect.requestId,
        type: "operation-failed",
      });
    }
  }

  async function runSystemAction(
    effect: Extract<Effect, { type: "copy" | "open" | "reveal" | "print" }>,
  ): Promise<void> {
    try {
      switch (effect.type) {
        case "copy":
          await ports.system.copy(effect.text);
          break;
        case "open":
          await ports.system.open(effect.path);
          break;
        case "reveal":
          await ports.system.reveal(effect.path);
          break;
        case "print":
          await ports.output.print(effect.text);
          break;
        default:
          assertNever(effect);
      }
      await emit({ requestId: effect.requestId, type: "system-action-completed" });
    } catch {
      await emit({
        message: systemActionFailure(effect.type),
        requestId: effect.requestId,
        type: "system-action-failed",
      });
    }
  }

  return {
    dispatch: (event) => applyEvent(clone(event), false),
    getModel: () => clone(model),
    runEffect,
  };
}

function safeReadiness(
  readiness: Exclude<RuntimeReadiness, { status: "ready" }>,
): Exclude<RuntimeReadiness, { status: "ready" }> {
  return { remediation: "Run video-digest setup.", status: readiness.status };
}

function systemActionFailure(type: "copy" | "open" | "reveal" | "print"): string {
  switch (type) {
    case "copy": return "Could not copy the text. Try again.";
    case "open": return "Could not open the file. Open it from the Artifact Library instead.";
    case "reveal": return "Could not reveal the file. Open its parent folder manually.";
    case "print": return "Could not print the text to the terminal. Try again.";
    default: return assertNever(type);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled TUI effect: ${JSON.stringify(value)}`);
}
