import { describe, expect, test } from "bun:test";
import { initialModel, type Model } from "./model";
import type { TuiPorts } from "./ports";
import type { OpenTuiFacade, RenderFrame, TuiRenderer } from "./renderer";
import { startTui, type TuiSignalSource } from "./start";

function model(): Model {
  return initialModel({
    artifactLibrary: "/library",
    credentialConfigured: true,
    runtimeReadiness: { status: "ready" },
  });
}

function ports(quit: () => void | Promise<void>): TuiPorts {
  return {
    config: { saveArtifactLibrary: async (path) => path, saveModel: async () => {}, saveProvider: async () => {} },
    create: {
      ingest: async () => { throw new Error("unused"); },
      transcript: async () => { throw new Error("unused"); },
    },
    credential: { deleteApiKey: async () => {}, saveApiKey: async () => undefined },
    doctor: { run: async () => ({ checks: [], ok: true }) },
    library: {
      list: async () => [],
      open: async () => undefined,
      read: async () => ({ content: "", displayPath: "", title: "" }),
      reveal: async () => undefined,
    },
    lifecycle: { quit },
    output: { print: () => undefined },
    runtime: {
      prepare: async () => undefined,
      readiness: async () => ({ status: "ready" }),
    },
    system: { copy: async () => undefined },
  };
}

function facade(overrides: Partial<OpenTuiFacade> = {}): OpenTuiFacade & {
  destroyCalls: number;
  frame: RenderFrame | null;
  printCalls: string[];
} {
  return {
    destroyCalls: 0,
    dimensions: { height: 30, width: 100 },
    frame: null,
    printCalls: [],
    destroy() { this.destroyCalls += 1; },
    async print(text) { this.printCalls.push(text); },
    render(frame) { this.frame = frame; },
    ...overrides,
  };
}

function renderer(onRender?: () => void): TuiRenderer & { destroyCalls: number; renderCalls: number } {
  return {
    destroyCalls: 0,
    renderCalls: 0,
    destroy() { this.destroyCalls += 1; },
    render() { this.renderCalls += 1; onRender?.(); },
  };
}

function signals(): TuiSignalSource & { emit(signal: "SIGINT" | "SIGTERM"): void; listenerCount: number } {
  const listeners = new Map<"SIGINT" | "SIGTERM", Set<() => void>>([
    ["SIGINT", new Set()],
    ["SIGTERM", new Set()],
  ]);
  return {
    emit(signal) { for (const listener of [...listeners.get(signal)!]) listener(); },
    get listenerCount() { return [...listeners.values()].reduce((count, values) => count + values.size, 0); },
    off(signal, listener) { listeners.get(signal)!.delete(listener); },
    on(signal, listener) { listeners.get(signal)!.add(listener); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function promptly<T>(promise: Promise<T>): Promise<T | "timed-out"> {
  return Promise.race([
    promise,
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 30)),
  ]);
}

describe("startTui", () => {
  test("SIGINT stops a non-cooperative facade startup and destroys a late facade once", async () => {
    const pending = deferred<OpenTuiFacade>();
    const source = signals();
    const lateFacade = facade();
    const running = startTui({ createFacade: () => pending.promise, signals: source });

    source.emit("SIGINT");

    expect(await promptly(running)).toBe(0);
    expect(source.listenerCount).toBe(0);
    pending.resolve(lateFacade);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateFacade.destroyCalls).toBe(1);
  });

  test("SIGTERM stops a non-cooperative bootstrap and fences its late session", async () => {
    const pending = deferred<{ model: Model; ports: TuiPorts }>();
    const source = signals();
    const native = facade();
    let controllerCreations = 0;
    const running = startTui({
      bootstrap: () => pending.promise,
      createController: (...args) => {
        controllerCreations += 1;
        return {
          dispatch: async () => undefined,
          dispose: async () => undefined,
          getModel: () => args[0],
        };
      },
      createFacade: async () => native,
      signals: source,
    });
    while (source.listenerCount === 0) await Promise.resolve();

    source.emit("SIGTERM");

    expect(await promptly(running)).toBe(0);
    expect(native.destroyCalls).toBe(1);
    expect(source.listenerCount).toBe(0);
    pending.resolve({ model: model(), ports: ports(() => undefined) });
    await Promise.resolve();
    expect(controllerCreations).toBe(0);
  });

  test("AbortSignal stops facade startup and absorbs a late rejection", async () => {
    const pending = deferred<OpenTuiFacade>();
    const abort = new AbortController();
    const source = signals();
    const running = startTui({ createFacade: () => pending.promise, signal: abort.signal, signals: source });

    abort.abort();

    expect(await promptly(running)).toBe(0);
    expect(source.listenerCount).toBe(0);
    pending.reject(new Error("late private failure"));
    await Promise.resolve();
    await Promise.resolve();
  });

  test("an already-aborted signal never waits for facade startup", async () => {
    const abort = AbortSignal.abort();
    const source = signals();
    let facadeCalls = 0;

    expect(await promptly(startTui({
      createFacade: async () => {
        facadeCalls += 1;
        return facade();
      },
      signal: abort,
      signals: source,
    }))).toBe(0);
    expect(source.listenerCount).toBe(0);
    expect(facadeCalls).toBe(0);
  });

  test("routes Ctrl-C through the real controller and renderer before restoring the terminal", async () => {
    const native = facade();
    const running = startTui({
      bootstrap: async (lifecycle) => ({ model: model(), ports: ports(lifecycle.quit) }),
      createFacade: async () => native,
      signals: signals(),
    });

    while (!native.frame) await Promise.resolve();
    expect(native.frame.onKey({ ctrl: true, meta: false, name: "c", shift: false })).toBe(true);

    expect(await running).toBe(0);
    expect(native.destroyCalls).toBe(1);
  });

  test("renders the initialized model and cleans controller and renderer exactly once on quit", async () => {
    const native = facade();
    const view = renderer();
    let requestQuit: (() => void) | undefined;
    let disposeCalls = 0;
    const running = startTui({
      bootstrap: async (lifecycle) => {
        requestQuit = lifecycle.quit;
        return { model: model(), ports: ports(lifecycle.quit) };
      },
      createController: (initial, tuiPorts, options) => {
        let current = initial;
        return {
          dispatch: async (event) => {
            if (event.type === "quit") await tuiPorts.lifecycle.quit();
          },
          dispose: async () => { disposeCalls += 1; await tuiPorts.lifecycle.quit(); },
          getModel: () => current,
        };
      },
      createFacade: async () => native,
      createRenderer: () => view,
      signals: signals(),
    });

    while (!requestQuit || view.renderCalls === 0) await Promise.resolve();
    requestQuit();

    expect(await running).toBe(0);
    expect(view.renderCalls).toBe(1);
    expect(view.destroyCalls).toBe(1);
    expect(native.destroyCalls).toBe(0);
    expect(disposeCalls).toBe(1);
  });

  test("aborted launch dispatches quit and removes process signal handlers", async () => {
    const abort = new AbortController();
    const source = signals();
    const view = renderer();
    let quitDispatches = 0;
    const running = startTui({
      bootstrap: async (lifecycle) => ({ model: model(), ports: ports(lifecycle.quit) }),
      createController: (initial, tuiPorts) => ({
        dispatch: async (event) => {
          if (event.type === "quit") {
            quitDispatches += 1;
            await tuiPorts.lifecycle.quit();
          }
        },
        dispose: async () => undefined,
        getModel: () => initial,
      }),
      createFacade: async () => facade(),
      createRenderer: () => view,
      signal: abort.signal,
      signals: source,
    });

    while (view.renderCalls === 0) await Promise.resolve();
    abort.abort();

    expect(await running).toBe(0);
    expect(quitDispatches).toBe(1);
    expect(source.listenerCount).toBe(0);
    expect(view.destroyCalls).toBe(1);
  });

  test("reports a stable launch failure and destroys a facade when bootstrap fails", async () => {
    const native = facade();
    const errors: string[] = [];

    const exitCode = await startTui({
      bootstrap: async () => { throw new Error("secret provider detail"); },
      createFacade: async () => native,
      onError: (message) => errors.push(message),
      signals: signals(),
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(["Video Digest could not start its terminal interface. Run video-digest doctor and try again."]);
    expect(errors.join(" ")).not.toContain("secret provider detail");
    expect(native.destroyCalls).toBe(1);
  });

  test("cleans up exactly once when initial rendering or an observer fails", async () => {
    for (const failure of ["initial-render", "observer"] as const) {
      const native = facade();
      const errors: string[] = [];
      let observerFailure: (() => void) | undefined;
      const view = renderer(failure === "initial-render" ? () => { throw new Error("render detail"); } : undefined);

      const running = startTui({
        bootstrap: async (lifecycle) => ({ model: model(), ports: ports(lifecycle.quit) }),
        createController: (initial, _ports, options) => {
          observerFailure = () => options.onObserverError?.(new Error("observer detail"));
          return {
            dispatch: async () => undefined,
            dispose: async () => undefined,
            getModel: () => initial,
          };
        },
        createFacade: async () => native,
        createRenderer: () => view,
        onError: (message) => errors.push(message),
        signals: signals(),
      });

      if (failure === "observer") {
        while (!observerFailure) await Promise.resolve();
        observerFailure();
      }

      expect(await running).toBe(1);
      expect(view.destroyCalls).toBe(1);
      expect(native.destroyCalls).toBe(0);
      expect(errors).toEqual(["Video Digest encountered a terminal interface error. The terminal was restored safely."]);
    }
  });
});
