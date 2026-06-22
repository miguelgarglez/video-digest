import { createTuiController, type TuiController, type TuiControllerOptions } from "./controller";
import type { Model } from "./model";
import type { TuiPorts } from "./ports";
import {
  createOpenTuiFacade,
  createTuiRenderer,
  type OpenTuiFacade,
  type TuiRenderer,
  type TuiRendererOptions,
} from "./renderer";

const LAUNCH_ERROR = "Video Digest could not start its terminal interface. Run video-digest doctor and try again.";
const RUNTIME_ERROR = "Video Digest encountered a terminal interface error. The terminal was restored safely.";

export type TuiLifecycle = Readonly<{
  print(text: string): void | Promise<void>;
  quit(): void;
}>;

export type TuiBootstrapResult = Readonly<{
  model: Model;
  ports: TuiPorts;
}>;

export type TuiSignalSource = Readonly<{
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}>;

export type StartTuiOptions = Readonly<{
  bootstrap?(lifecycle: TuiLifecycle): Promise<TuiBootstrapResult>;
  createController?(
    model: Model,
    ports: TuiPorts,
    options: TuiControllerOptions,
  ): TuiController;
  createFacade?(): Promise<OpenTuiFacade>;
  createRenderer?(options: TuiRendererOptions): TuiRenderer;
  onError?(message: string): void;
  signal?: AbortSignal;
  signals?: TuiSignalSource;
}>;

/**
 * Owns the complete terminal lifecycle. Every exit path converges on one cleanup
 * block, including controller quit, OS signals, renderer failures, and bootstrap
 * failures. Service construction is injected to keep tests free of native effects.
 */
export async function startTui(options: StartTuiOptions = {}): Promise<number> {
  const createFacade = options.createFacade ?? createOpenTuiFacade;
  const createController = options.createController ?? createTuiController;
  const createRenderer = options.createRenderer ?? createTuiRenderer;
  const signalSource = options.signals ?? processSignalSource;
  let facade: OpenTuiFacade | null = null;
  let renderer: TuiRenderer | null = null;
  let controller: TuiController | null = null;
  let exitCode = 0;
  let settled = false;
  let initialized = false;
  let reported = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => { resolveExit = resolve; });

  const report = (message: string): void => {
    if (reported) return;
    reported = true;
    try {
      options.onError?.(message);
    } catch {
      // Reporting must not prevent terminal restoration.
    }
  };
  const requestExit = (code = 0): void => {
    if (code !== 0) exitCode = 1;
    if (settled) return;
    settled = true;
    resolveExit();
  };
  const requestRuntimeFailure = (): void => {
    report(RUNTIME_ERROR);
    requestExit(1);
  };
  const requestQuit = (): void => requestExit(0);
  const dispatchQuit = (): void => {
    const current = controller;
    if (!current) {
      requestQuit();
      return;
    }
    void current.dispatch({ type: "quit" }).catch(requestRuntimeFailure);
  };
  const abortListener = (): void => dispatchQuit();
  const signalListener = (): void => dispatchQuit();

  signalSource.on("SIGINT", signalListener);
  signalSource.on("SIGTERM", signalListener);
  options.signal?.addEventListener("abort", abortListener, { once: true });

  try {
    facade = await createFacade();
    const bootstrap = options.bootstrap ?? defaultBootstrap;
    const session = await bootstrap({
      print: (text) => facade!.print(text),
      quit: requestQuit,
    });
    controller = createController(session.model, session.ports, {
      onModelChange: (model) => renderer?.render(model),
      onObserverError: requestRuntimeFailure,
    });
    renderer = createRenderer({
      dispatch: controller.dispatch,
      facade,
      getModel: controller.getModel,
    });
    // From this point failures belong to the live terminal lifecycle, even if the
    // first frame itself fails before it becomes visible.
    initialized = true;
    renderer.render(controller.getModel());

    if (options.signal?.aborted) dispatchQuit();
    await exit;
  } catch {
    report(initialized ? RUNTIME_ERROR : LAUNCH_ERROR);
    exitCode = 1;
  } finally {
    signalSource.off("SIGINT", signalListener);
    signalSource.off("SIGTERM", signalListener);
    options.signal?.removeEventListener("abort", abortListener);

    try {
      await controller?.dispose();
    } catch {
      report(RUNTIME_ERROR);
      exitCode = 1;
    }
    try {
      if (renderer) renderer.destroy();
      else facade?.destroy();
    } catch {
      report(RUNTIME_ERROR);
      exitCode = 1;
    }
  }

  return exitCode;
}

async function defaultBootstrap(lifecycle: TuiLifecycle): Promise<TuiBootstrapResult> {
  const { createDefaultTuiSession } = await import("./default-ports");
  return createDefaultTuiSession(lifecycle);
}

const processSignalSource: TuiSignalSource = {
  off: (signal, listener) => process.off(signal, listener),
  on: (signal, listener) => process.on(signal, listener),
};
