import type { RuntimeReadiness } from "../cli/runtime-manager";
import type {
  Effect,
  Event,
  LibraryEntrySnapshot,
  LibraryTarget,
  Model,
  RequestId,
  ResultData,
} from "./model";
import type { LibraryReadResult, TuiPorts } from "./ports";
import { update } from "./update";

export type TuiControllerOptions = Readonly<{
  onEvent?(event: Event): unknown;
  onModelChange?(model: Model): unknown;
  onObserverError?(error: Error): unknown;
}>;

export type TuiController = Readonly<{
  dispatch(event: Event): Promise<void>;
  dispose(): Promise<void>;
  getModel(): Model;
  runEffect(effect: Effect): Promise<void>;
}>;

type Operation = {
  controller: AbortController;
  effectType: "ingest" | "transcript";
  requestId: RequestId;
  started: boolean;
};

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function createTuiController(
  initial: Model,
  ports: TuiPorts,
  options: TuiControllerOptions = {},
): TuiController {
  let disposed = false;
  let model = clone(initial);
  let shutdownPromise: Promise<void> | null = null;
  const operations = new Map<RequestId, Operation>();
  const cancelledOperations = new Set<RequestId>();

  const reportObserverFailure = (): void => {
    try {
      const result = options.onObserverError?.(new Error("A TUI observer callback failed."));
      if (isPromiseLike(result)) void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Observer diagnostics must never affect application state or create a loop.
    }
  };

  const notify = (callback: (() => unknown) | undefined): void => {
    if (!callback || disposed) return;
    try {
      const result = callback();
      if (isPromiseLike(result)) void Promise.resolve(result).catch(reportObserverFailure);
    } catch {
      reportObserverFailure();
    }
  };

  const applyEvent = async (event: Event, observable: boolean): Promise<void> => {
    if (disposed) return;
    const transition = update(model, event);
    const nextModel = clone(transition.model);

    // Cancellation ownership exists before observers see the pending model. A
    // synchronous reentrant Back/Home can therefore abort or tombstone the work.
    for (const effect of transition.effects) preRegisterOperation(effect, nextModel);
    model = nextModel;

    // Quit is an irreversible lifecycle boundary, not an observable background
    // effect. Fence the controller before any observer can reenter it.
    if (transition.effects.some((effect) => effect.type === "quit")) {
      await shutdown();
      return;
    }

    if (observable) notify(() => options.onEvent?.(clone(event)));
    notify(() => options.onModelChange?.(clone(model)));
    if (disposed) return;

    await Promise.all(transition.effects.map(runEffect));
  };

  const emit = (event: Event): Promise<void> => applyEvent(event, true);

  function preRegisterOperation(effect: Effect, prospectiveModel: Model = model): void {
    if ((effect.type !== "ingest" && effect.type !== "transcript") || operations.has(effect.requestId)) return;
    if (!operationMatchesPending(effect, prospectiveModel)) return;
    operations.set(effect.requestId, {
      controller: new AbortController(),
      effectType: effect.type,
      requestId: effect.requestId,
      started: false,
    });
  }

  async function runEffect(effect: Effect): Promise<void> {
    if (effect.type === "quit") {
      await shutdown();
      return;
    }
    if (disposed) return;
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
      case "transcript": {
        const operation = claimOperation(effect);
        if (!operation) return;
        await runCreateOperation(effect, operation);
        return;
      }
      case "copy":
      case "print":
        await runTextAction(effect);
        return;
      case "open":
      case "reveal":
        await runLibraryAction(effect);
        return;
      case "read":
        await readLibraryTarget(effect);
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
      case "cancel-operation":
        cancelOperation(effect.requestId);
        return;
      default:
        return assertNever(effect);
    }
  }

  function cancelOperation(requestId: RequestId): void {
    const operation = operations.get(requestId);
    if (!operation) return;
    operations.delete(requestId);
    cancelledOperations.add(requestId);
    operation.controller.abort();
  }

  function claimOperation(
    effect: Extract<Effect, { type: "ingest" | "transcript" }>,
  ): Operation | null {
    if (cancelledOperations.delete(effect.requestId)) return null;
    preRegisterOperation(effect);
    const operation = operations.get(effect.requestId);
    if (!operation || operation.effectType !== effect.type || operation.started) return null;
    operation.started = true;
    return operation;
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
        // The fixed fallback intentionally excludes service error details.
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
    operation: Operation,
  ): Promise<void> {
    if (operation.controller.signal.aborted || disposed) return;
    const isCurrent = () => !disposed && operations.get(effect.requestId) === operation &&
      !operation.controller.signal.aborted;

    const work = Promise.resolve().then(() => effect.type === "ingest"
      ? ports.create.ingest(effect.url, {
          onProgress: (message) => emitProgress(operation, message),
          signal: operation.controller.signal,
        })
      : ports.create.transcript(effect.url, {
          onProgress: (message) => emitProgress(operation, message),
          signal: operation.controller.signal,
        }));
    // The service may ignore AbortSignal. This handler absorbs a rejection after
    // cancellation while the abort race lets dispatch settle immediately.
    void work.catch(() => undefined);

    try {
      const outcome = await raceAbort(work, operation.controller.signal);
      if (outcome.aborted || !isCurrent()) {
        cancelledOperations.delete(effect.requestId);
        return;
      }
      const result = validateResult(outcome.value, effect.type === "ingest" ? "digest" : "transcript");
      if (!result) {
        await settleOperation(operation, operationFailure(effect.type, effect.requestId));
        return;
      }
      await settleOperation(operation, {
        requestId: effect.requestId,
        result,
        type: "operation-succeeded",
      });
    } catch {
      if (!isCurrent()) {
        cancelledOperations.delete(effect.requestId);
        return;
      }
      await settleOperation(operation, operationFailure(effect.type, effect.requestId));
    }
  }

  function emitProgress(operation: Operation, message: string): void {
    if (typeof message !== "string" || operations.get(operation.requestId) !== operation ||
      operation.controller.signal.aborted || disposed) return;
    void emit({ message, requestId: operation.requestId, type: "operation-progress" }).catch(() => undefined);
  }

  async function settleOperation(
    operation: Operation,
    event: Extract<Event, { type: "operation-failed" | "operation-succeeded" }>,
  ): Promise<void> {
    if (operations.get(operation.requestId) !== operation || disposed) return;
    const eligible = model.pending?.requestId === operation.requestId &&
      (model.pending.kind === "ingest" || model.pending.kind === "transcript");
    if (!eligible) {
      cancelOperation(operation.requestId);
      return;
    }
    await emit(event);
    if (operations.get(operation.requestId) === operation && model.pending?.requestId !== operation.requestId) {
      operations.delete(operation.requestId);
    }
  }

  async function readLibraryTarget(effect: Extract<Effect, { type: "read" }>): Promise<void> {
    try {
      if (!isLibraryTarget(effect.target)) throw new Error("invalid-target");
      const result = validateReadResult(await ports.library.read(clone(effect.target)));
      if (!result) throw new Error("invalid-result");
      await emit({ ...result, requestId: effect.requestId, type: "reader-loaded" });
    } catch {
      await emit({
        message: "Could not read this Library Entry. Check that it still exists and try again.",
        requestId: effect.requestId,
        type: "reader-failed",
      });
    }
  }

  async function runLibraryAction(
    effect: Extract<Effect, { type: "open" | "reveal" }>,
  ): Promise<void> {
    try {
      if (!isLibraryTarget(effect.target)) throw new Error("invalid-target");
      if (effect.type === "open") await ports.library.open(clone(effect.target));
      else await ports.library.reveal(clone(effect.target));
      await emit({ requestId: effect.requestId, type: "system-action-completed" });
    } catch {
      await emit({
        message: effect.type === "open"
          ? "Could not open this Library Entry. Open the Artifact Library and try again."
          : "Could not reveal this Library Entry. Open the Artifact Library manually.",
        requestId: effect.requestId,
        type: "system-action-failed",
      });
    }
  }

  async function runTextAction(
    effect: Extract<Effect, { type: "copy" | "print" }>,
  ): Promise<void> {
    try {
      if (effect.type === "copy") await ports.system.copy(effect.text);
      else await ports.output.print(effect.text);
      await emit({ requestId: effect.requestId, type: "system-action-completed" });
    } catch {
      await emit({
        message: effect.type === "copy"
          ? "Could not copy the text. Try again."
          : "Could not print the text to the terminal. Try again.",
        requestId: effect.requestId,
        type: "system-action-failed",
      });
    }
  }

  function shutdown(): Promise<void> {
    if (!shutdownPromise) {
      disposed = true;
      let resolveShutdown!: () => void;
      let rejectShutdown!: (reason: unknown) => void;
      shutdownPromise = new Promise<void>((resolve, reject) => {
        resolveShutdown = resolve;
        rejectShutdown = reject;
      });
      for (const operation of operations.values()) operation.controller.abort();
      operations.clear();
      cancelledOperations.clear();
      void Promise.resolve()
        .then(() => ports.lifecycle.quit())
        .then(resolveShutdown, rejectShutdown);
    }
    return shutdownPromise;
  }

  async function dispose(): Promise<void> {
    await shutdown();
  }

  return {
    dispatch: (event) => applyEvent(clone(event), false),
    dispose,
    getModel: () => clone(model),
    runEffect,
  };
}

function operationMatchesPending(
  effect: Extract<Effect, { type: "ingest" | "transcript" }>,
  candidate: Model,
): boolean {
  const pending = candidate.pending;
  if (!pending || pending.requestId !== effect.requestId) return true;
  return pending.kind === effect.type;
}

function operationFailure(
  type: "ingest" | "transcript",
  requestId: RequestId,
): Extract<Event, { type: "operation-failed" }> {
  return {
    message: type === "ingest"
      ? "Could not create the Digest. Check the URL and setup, then try again."
      : "Could not get the Transcript. Check the URL and setup, then try again.",
    requestId,
    type: "operation-failed",
  };
}

async function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (signal.aborted) return { aborted: true };
  let removeListener: () => void = () => {};
  const aborted = new Promise<{ aborted: true }>((resolve) => {
    const listener = () => resolve({ aborted: true });
    removeListener = () => signal.removeEventListener("abort", listener);
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([
      work.then((value) => ({ aborted: false as const, value })),
      aborted,
    ]);
  } finally {
    removeListener();
  }
}

function validateResult(value: unknown, expectedKind: ResultData["kind"]): ResultData | null {
  if (!isRecord(value) || value.kind !== expectedKind ||
    (typeof value.cleanText !== "string" && value.cleanText !== null)) return null;
  const entry = validateEntry(value.entry);
  return entry ? { cleanText: value.cleanText, entry, kind: expectedKind } : null;
}

function validateEntry(value: unknown): LibraryEntrySnapshot | null {
  if (!isRecord(value) || !VIDEO_ID_PATTERN.test(asString(value.videoId)) ||
    !isNullableString(value.channel) || !isNullableString(value.title) ||
    typeof value.updatedAt !== "string" || !isRecord(value.paths)) return null;
  const paths = value.paths;
  if (typeof paths.metadataPath !== "string" ||
    !isNullableString(paths.digestPath) || !isNullableString(paths.emailPreviewPath) ||
    !isNullableString(paths.transcriptJsonPath) || !isNullableString(paths.transcriptMarkdownPath) ||
    !isNullableString(paths.transcriptTextPath)) return null;
  return {
    channel: value.channel,
    paths: {
      digestPath: paths.digestPath,
      emailPreviewPath: paths.emailPreviewPath,
      metadataPath: paths.metadataPath,
      transcriptJsonPath: paths.transcriptJsonPath,
      transcriptMarkdownPath: paths.transcriptMarkdownPath,
      transcriptTextPath: paths.transcriptTextPath,
    },
    title: value.title,
    updatedAt: value.updatedAt,
    videoId: asString(value.videoId),
  };
}

function validateReadResult(value: unknown): LibraryReadResult | null {
  return isRecord(value) && typeof value.content === "string" &&
      typeof value.displayPath === "string" && typeof value.title === "string"
    ? { content: value.content, displayPath: value.displayPath, title: value.title }
    : null;
}

function isLibraryTarget(value: unknown): value is LibraryTarget {
  return isRecord(value) && VIDEO_ID_PATTERN.test(asString(value.videoId)) &&
    (value.preference === "digest" || value.preference === "transcript");
}

function safeReadiness(
  readiness: Exclude<RuntimeReadiness, { status: "ready" }>,
): Exclude<RuntimeReadiness, { status: "ready" }> {
  return { remediation: "Run video-digest setup.", status: readiness.status };
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null || typeof value === "function") &&
    "then" in value && typeof (value as { then?: unknown }).then === "function";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled TUI effect: ${JSON.stringify(value)}`);
}
