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
    config: { saveArtifactLibrary: async () => undefined },
    create: {
      ingest: async () => { throw new Error("unused"); },
      transcript: async () => { throw new Error("unused"); },
    },
    credential: { saveOpenCodeApiKey: async () => undefined },
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
    print(text) { this.printCalls.push(text); },
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

function signals(): TuiSignalSource & { emit(): void; listenerCount: number } {
  const listeners = new Set<() => void>();
  return {
    emit() { for (const listener of [...listeners]) listener(); },
    get listenerCount() { return listeners.size; },
    off(_signal, listener) { listeners.delete(listener); },
    on(_signal, listener) { listeners.add(listener); },
  };
}

describe("startTui", () => {
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

    while (!requestQuit) await Promise.resolve();
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
