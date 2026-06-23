import { describe, expect, test } from "bun:test";
import type { LibraryEntry } from "../cli/artifacts";
import { createTuiController } from "./controller";
import { initialModel, type Model, type ResultData } from "./model";
import type { TuiPorts } from "./ports";

const entry: LibraryEntry = {
  channel: "Channel",
  paths: {
    digestPath: "/library/digests/abc123_DEF4.md",
    emailPreviewPath: null,
    metadataPath: "/library/metadata/abc123_DEF4.json",
    transcriptJsonPath: "/library/transcripts/abc123_DEF4.json",
    transcriptMarkdownPath: "/library/transcripts/abc123_DEF4.md",
    transcriptTextPath: "/library/transcripts/abc123_DEF4.txt",
  },
  title: "Video",
  updatedAt: "2026-06-22T10:00:00.000Z",
  videoId: "abc123_DEF4",
};

const transcriptResult: ResultData = { cleanText: "Text", entry, kind: "transcript" };

function ready(overrides: Partial<Model> = {}): Model {
  return {
    ...initialModel({
      artifactLibrary: "/library",
      credentialConfigured: true,
      runtimeReadiness: { status: "ready" },
    }),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, reject, resolve };
}

function ports(overrides: Record<string, unknown> = {}): TuiPorts {
  return {
    config: { saveArtifactLibrary: async (path: string) => path },
    create: {
      ingest: async () => ({ ...transcriptResult, kind: "digest" }),
      transcript: async () => transcriptResult,
    },
    credential: { saveOpenCodeApiKey: async () => undefined },
    doctor: { run: async () => ({ checks: [], ok: true }) },
    library: {
      list: async () => [entry],
      open: async () => undefined,
      read: async () => ({ content: "reader", displayPath: "abc123_DEF4.md", title: "Video" }),
      reveal: async () => undefined,
    },
    lifecycle: { quit: async () => undefined },
    output: { print: async () => undefined },
    runtime: { prepare: async () => undefined, readiness: async () => ({ status: "ready" }) },
    system: { copy: async () => undefined },
    ...overrides,
  } as unknown as TuiPorts;
}

async function startTranscript(controller: ReturnType<typeof createTuiController>): Promise<void> {
  await controller.dispatch({ type: "choose-transcript" });
  await controller.dispatch({ type: "submit-url", url: "https://youtu.be/abc123_DEF4" });
}

describe("TUI controller hardening", () => {
  test("exposes Events, never an effect-injection surface", async () => {
    let ingestCalls = 0;
    let transcriptCalls = 0;
    const controller = createTuiController(ready(), ports({
      create: {
        ingest: async () => { ingestCalls += 1; return { ...transcriptResult, kind: "digest" }; },
        transcript: async () => { transcriptCalls += 1; return transcriptResult; },
      },
    }));

    expect("runEffect" in controller).toBe(false);
    if (false) {
      // @ts-expect-error Effects are controller-owned and cannot be injected from Home.
      await controller.runEffect({ requestId: 1, type: "ingest", url: "https://youtube.com/watch?v=abc123_DEF4" });
    }
    await startTranscript(controller);

    expect(ingestCalls).toBe(0);
    expect(transcriptCalls).toBe(1);
    expect(controller.getModel().screen).toBe("result");
  });

  test("uses only an opaque Library target even when model paths are forged", async () => {
    const targets: unknown[] = [];
    const forged = structuredClone(entry);
    forged.paths.digestPath = "/tmp/attacker-controlled.md";
    const controller = createTuiController(ready({ screen: "library", selectedEntry: forged }), ports({
      library: {
        list: async () => [],
        open: async (target: unknown) => { targets.push(target); },
        read: async (target: unknown) => {
          targets.push(target);
          return { content: "safe", displayPath: "digests/abc123_DEF4.md", title: "Video" };
        },
        reveal: async (target: unknown) => { targets.push(target); },
      },
    }));

    await controller.dispatch({ type: "read-entry" });

    expect(targets).toEqual([{ preference: "digest", videoId: "abc123_DEF4" }]);
    expect(JSON.stringify(targets)).not.toContain("attacker-controlled");
  });

  test("contains observer failures without converting successful work into failure", async () => {
    const observerErrors: unknown[] = [];
    const controller = createTuiController(ready(), ports({
      create: {
        ingest: async () => ({ ...transcriptResult, kind: "digest" }),
        transcript: async (_url: string, options: { onProgress(message: string): void }) => {
          options.onProgress("Fetching…");
          return transcriptResult;
        },
      },
    }), {
      onEvent: () => { throw new Error("observer exploded /secret/path"); },
      onModelChange: () => { throw new Error("renderer exploded"); },
      onObserverError: (error) => { observerErrors.push(error); },
    });

    await startTranscript(controller);

    expect(controller.getModel()).toMatchObject({ pending: null, screen: "result" });
    expect(observerErrors.length).toBeGreaterThan(0);
  });

  test("registers cancellation before a reentrant model observer navigates Back", async () => {
    let controller!: ReturnType<typeof createTuiController>;
    let calls = 0;
    let signal: AbortSignal | null = null;
    controller = createTuiController(ready(), ports({
      create: {
        ingest: async () => ({ ...transcriptResult, kind: "digest" }),
        transcript: async (_url: string, options: { signal: AbortSignal }) => {
          calls += 1;
          signal = options.signal;
          return new Promise<ResultData>(() => undefined);
        },
      },
    }), {
      onModelChange: (model) => {
        if (model.screen === "progress") void controller.dispatch({ type: "back" });
      },
    });

    await Promise.race([
      startTranscript(controller),
      Bun.sleep(50).then(() => { throw new Error("operation remained running"); }),
    ]);

    expect(calls === 0 || (signal !== null && (signal as AbortSignal).aborted)).toBe(true);
    expect(controller.getModel().screen).toBe("home");
  });

  test("rejects mismatched and malformed operation results with a stable failure", async () => {
    for (const invalid of [
      { ...transcriptResult, kind: "digest" },
      { cleanText: "Text", entry: { ...entry, paths: { ...entry.paths, digestPath: 42 } }, kind: "transcript" },
    ]) {
      const controller = createTuiController(ready(), ports({
        create: {
          ingest: async () => ({ ...transcriptResult, kind: "digest" }),
          transcript: async () => invalid,
        },
      }));

      await startTranscript(controller);

      expect(controller.getModel()).toMatchObject({
        message: "Could not get the Transcript. Check the URL and setup, then try again.",
        pending: null,
        screen: "enter-url",
      });
    }
  });

  test("cancels non-cooperative work promptly and absorbs its late rejection", async () => {
    const work = deferred<ResultData>();
    let signal: AbortSignal | undefined;
    const controller = createTuiController(ready(), ports({
      create: {
        ingest: async () => ({ ...transcriptResult, kind: "digest" }),
        transcript: async (_url: string, options: { signal: AbortSignal }) => {
          signal = options.signal;
          return work.promise;
        },
      },
    }));

    const running = startTranscript(controller);
    while (!signal) await Promise.resolve();
    await controller.dispatch({ type: "back" });
    await Promise.race([running, Bun.sleep(50).then(() => { throw new Error("cancel did not settle"); })]);
    work.reject(new Error("late secret rejection"));
    await Bun.sleep(0);

    expect(signal.aborted).toBe(true);
    expect(controller.getModel()).toMatchObject({ pending: null, result: null, screen: "home" });
  });

  test("dispose aborts all work, fences events, and cleans up exactly once", async () => {
    const signals: AbortSignal[] = [];
    let quits = 0;
    const controller = createTuiController(ready(), ports({
      create: {
        ingest: async (_url: string, options: { signal: AbortSignal }) => {
          signals.push(options.signal);
          return new Promise<ResultData>(() => undefined);
        },
        transcript: async (_url: string, options: { signal: AbortSignal }) => {
          signals.push(options.signal);
          return new Promise<ResultData>(() => undefined);
        },
      },
      lifecycle: { quit: async () => { quits += 1; } },
    }));

    const running = startTranscript(controller);
    while (signals.length < 1) await Promise.resolve();
    await Promise.all([controller.dispose(), controller.dispose(), running]);
    await controller.dispatch({ type: "go-home" });

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(quits).toBe(1);
  });

  test("quit fences a late dismissible result and every later dispatch", async () => {
    const listing = deferred<LibraryEntry[]>();
    const observed: Model[] = [];
    let quits = 0;
    const controller = createTuiController(ready(), ports({
      library: {
        list: async () => listing.promise,
        open: async () => undefined,
        read: async () => ({ content: "", displayPath: "", title: "" }),
        reveal: async () => undefined,
      },
      lifecycle: { quit: async () => { quits += 1; } },
    }), { onModelChange: (model) => { observed.push(model); } });

    const loading = controller.dispatch({ type: "browse-library" });
    await Promise.resolve();
    await controller.dispatch({ type: "back" });
    await controller.dispatch({ type: "back" });
    const countAtQuit = observed.length;
    listing.resolve([entry]);
    await loading;
    await controller.dispatch({ type: "go-home" });

    expect(observed).toHaveLength(countAtQuit);
    expect(controller.getModel()).toMatchObject({ pending: null, screen: "home" });
    expect(quits).toBe(1);
  });

  test("does not notify observers for a dismissed request's stale completion", async () => {
    const listing = deferred<LibraryEntry[]>();
    const observed: Model[] = [];
    const controller = createTuiController(ready(), ports({
      library: {
        list: async () => listing.promise,
        open: async () => undefined,
        read: async () => ({ content: "", displayPath: "", title: "" }),
        reveal: async () => undefined,
      },
    }), { onModelChange: (model) => { observed.push(model); } });

    const loading = controller.dispatch({ type: "browse-library" });
    await Promise.resolve();
    await controller.dispatch({ type: "back" });
    const countAtDismissal = observed.length;
    listing.resolve([entry]);
    await loading;

    expect(observed).toHaveLength(countAtDismissal);
    expect(controller.getModel().screen).toBe("home");
  });

  test("shares and preserves one lifecycle rejection across quit and dispose", async () => {
    const failure = new Error("cleanup failed");
    let quits = 0;
    const controller = createTuiController(ready(), ports({
      lifecycle: { quit: async () => { quits += 1; throw failure; } },
    }));

    await expect(controller.dispatch({ type: "back" })).rejects.toBe(failure);
    await expect(controller.dispose()).rejects.toBe(failure);
    await expect(controller.dispose()).rejects.toBe(failure);
    expect(quits).toBe(1);
  });

  test("publishes the shared shutdown before abort listeners can reenter disposal", async () => {
    let controller!: ReturnType<typeof createTuiController>;
    let started = false;
    let quits = 0;
    controller = createTuiController(ready(), ports({
      create: {
        ingest: async () => ({ ...transcriptResult, kind: "digest" }),
        transcript: async (_url: string, options: { signal: AbortSignal }) => {
          options.signal.addEventListener("abort", () => { void controller.dispose(); }, { once: true });
          started = true;
          return new Promise<ResultData>(() => undefined);
        },
      },
      lifecycle: { quit: async () => { quits += 1; } },
    }));

    const running = startTranscript(controller);
    while (!started) await Promise.resolve();
    await controller.dispose();
    await running;

    expect(quits).toBe(1);
  });

  test("deduplicates reentrant operation submissions through Events", async () => {
    let controller!: ReturnType<typeof createTuiController>;
    let calls = 0;
    let resubmitted = false;
    controller = createTuiController(ready(), ports({
      create: {
        ingest: async () => ({ ...transcriptResult, kind: "digest" }),
        transcript: async () => { calls += 1; return transcriptResult; },
      },
    }), {
      onModelChange: (model) => {
        if (model.screen === "progress" && !resubmitted) {
          resubmitted = true;
          void controller.dispatch({ type: "submit-url", url: "https://youtu.be/abc123_DEF4" });
        }
      },
    });

    await startTranscript(controller);

    expect(calls).toBe(1);
  });
});
