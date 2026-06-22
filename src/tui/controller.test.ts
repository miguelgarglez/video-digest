import { describe, expect, test } from "bun:test";
import type { DoctorReport } from "../cli/doctor";
import type { LibraryEntry } from "../cli/artifacts";
import { createTuiController } from "./controller";
import { initialModel, type Event, type Model, type ResultData } from "./model";
import type { TuiPorts } from "./ports";

const entry: LibraryEntry = {
  channel: "Example Channel",
  paths: {
    digestPath: "/library/digests/abc123_DEF4.md",
    emailPreviewPath: null,
    metadataPath: "/library/metadata/abc123_DEF4.json",
    transcriptJsonPath: "/library/transcripts/abc123_DEF4.json",
    transcriptMarkdownPath: "/library/transcripts/abc123_DEF4.md",
    transcriptTextPath: "/library/transcripts/abc123_DEF4.txt",
  },
  title: "Example video",
  updatedAt: "2026-06-22T10:00:00.000Z",
  videoId: "abc123_DEF4",
};

const result: ResultData = { cleanText: "A clean transcript.", entry, kind: "transcript" };

function homeModel(overrides: Partial<Model> = {}): Model {
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
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fakePorts(overrides: Partial<TuiPorts> = {}): TuiPorts {
  return {
    config: { saveArtifactLibrary: async (path) => path },
    create: {
      ingest: async () => ({ ...result, kind: "digest" }),
      transcript: async () => result,
    },
    credential: { saveOpenCodeApiKey: async () => undefined },
    doctor: { run: async () => ({ checks: [], ok: true }) },
    library: {
      list: async () => [entry],
      open: async () => undefined,
      read: async () => ({ content: "contents", displayPath: "entry.md", title: "Entry" }),
      reveal: async () => undefined,
    },
    lifecycle: { quit: () => undefined },
    output: { print: () => undefined },
    runtime: {
      prepare: async () => undefined,
      readiness: async () => ({ status: "ready" }),
    },
    system: {
      copy: async () => undefined,
    },
    ...overrides,
  };
}

async function beginTranscript(controller: ReturnType<typeof createTuiController>): Promise<void> {
  await controller.dispatch({ type: "choose-transcript" });
  await controller.dispatch({ type: "submit-url", url: "https://youtu.be/abc123_DEF4" });
}

describe("TUI controller", () => {
  test("persists library selection and correlates completion", async () => {
    const saved: string[] = [];
    const events: Event[] = [];
    const controller = createTuiController(initialModel({ artifactLibrary: null }), fakePorts({
      config: { saveArtifactLibrary: async (path) => { saved.push(path); return "/normalized/library"; } },
    }), { onEvent: (event) => events.push(event) });

    await controller.dispatch({ type: "save-library", path: "/tmp/library" });

    expect(saved).toEqual(["/tmp/library"]);
    expect(events).toContainEqual({ type: "library-saved", path: "/normalized/library", requestId: 1 });
    expect(controller.getModel().screen).toBe("home");
    expect(controller.getModel().config.artifactLibrary).toBe("/normalized/library");
  });

  test("forwards progress and completion with the operation request id", async () => {
    const events: Event[] = [];
    const controller = createTuiController(homeModel(), fakePorts({
      create: {
        ingest: async () => ({ ...result, kind: "digest" }),
        transcript: async (_url, options) => {
          options.onProgress("Fetching transcript…");
          return result;
        },
      },
    }), { onEvent: (event) => events.push(event) });

    await beginTranscript(controller);

    expect(events).toContainEqual({ type: "operation-progress", message: "Fetching transcript…", requestId: 1 });
    expect(events).toContainEqual({ type: "operation-succeeded", result, requestId: 1 });
    expect(controller.getModel()).toMatchObject({ pending: null, result, screen: "result" });
  });

  test("does not prepare the runtime until explicit confirmation and Back remains side-effect free", async () => {
    let prepares = 0;
    const controller = createTuiController(homeModel({
      runtimeReadiness: { remediation: "Run setup.", status: "missing" },
    }), fakePorts({
      runtime: {
        prepare: async () => { prepares += 1; },
        readiness: async () => ({ status: "ready" }),
      },
    }));

    await controller.dispatch({ type: "choose-transcript" });
    expect(controller.getModel().screen).toBe("runtime-required");
    expect(prepares).toBe(0);
    await controller.dispatch({ type: "back" });
    expect(prepares).toBe(0);

    await controller.dispatch({ type: "choose-transcript" });
    await controller.dispatch({ type: "prepare-runtime" });
    expect(prepares).toBe(1);
  });

  test("cancels an operation idempotently and fences late callbacks", async () => {
    const operation = deferred<ResultData>();
    let signal: AbortSignal | undefined;
    let progress: ((message: string) => void) | undefined;
    const events: Event[] = [];
    const controller = createTuiController(homeModel(), fakePorts({
      create: {
        ingest: async () => ({ ...result, kind: "digest" }),
        transcript: async (_url, options) => {
          signal = options.signal;
          progress = options.onProgress;
          return operation.promise;
        },
      },
    }), { onEvent: (event) => events.push(event) });

    const running = beginTranscript(controller);
    while (!signal) await Promise.resolve();
    await controller.dispatch({ type: "back" });
    progress?.("Too late");
    operation.resolve(result);
    await running;

    expect(signal?.aborted).toBe(true);
    expect(events.some((event) => event.type === "operation-progress" && event.message === "Too late")).toBe(false);
    expect(events.some((event) => event.type === "operation-succeeded")).toBe(false);
    expect(controller.getModel()).toMatchObject({ pending: null, result: null, screen: "home" });
  });

  test("does not expose rejected error text or credentials", async () => {
    const secret = "sk-secret-value";
    const events: Event[] = [];
    const controller = createTuiController(homeModel({
      creationMode: "digest",
      credentialConfigured: false,
      screen: "credential-required",
    }), fakePorts({
      credential: { saveOpenCodeApiKey: async () => { throw new Error(`failed ${secret}`); } },
    }), { onEvent: (event) => events.push(event) });

    await controller.dispatch({ type: "save-credential", value: secret });

    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(controller.getModel())).not.toContain(secret);
    expect(controller.getModel().message).toBe("Could not save the OpenCode API key. Try again.");
  });

  test("maps asynchronous scrollback failures to a stable safe message", async () => {
    const controller = createTuiController(homeModel({ result, screen: "result" }), fakePorts({
      output: { print: async () => { throw new Error("EPIPE private terminal detail"); } },
    }));

    await controller.dispatch({ type: "print-result" });

    expect(controller.getModel().message).toBe("Could not print the text to the terminal. Try again.");
    expect(JSON.stringify(controller.getModel())).not.toContain("private terminal detail");
  });

  test("maps every persistent and dismissible service effect", async () => {
    const calls: string[] = [];
    const report: DoctorReport = { checks: [], ok: true };
    const ports = fakePorts({
      doctor: { run: async () => { calls.push("doctor"); return report; } },
      library: {
        list: async () => { calls.push("list"); return [entry]; },
        open: async (target) => { calls.push(`open:${target.videoId}`); },
        read: async (target) => {
          calls.push(`read:${target.videoId}`);
          return { content: "reader", displayPath: "entry.md", title: "Entry" };
        },
        reveal: async (target) => { calls.push(`reveal:${target.videoId}`); },
      },
      lifecycle: { quit: () => { calls.push("quit"); } },
      output: { print: (text) => { calls.push(`print:${text}`); } },
      runtime: {
        prepare: async () => { calls.push("prepare"); },
        readiness: async () => ({ status: "ready" }),
      },
      system: {
        copy: async (text) => { calls.push(`copy:${text}`); },
      },
    });
    const runtimeController = createTuiController(homeModel({
      runtimeReadiness: { remediation: "Run setup.", status: "missing" },
    }), ports);
    await runtimeController.dispatch({ type: "choose-transcript" });
    await runtimeController.dispatch({ type: "prepare-runtime" });

    const readerController = createTuiController(homeModel(), ports);
    await readerController.dispatch({ type: "browse-library" });
    await readerController.dispatch({ type: "select-entry", videoId: entry.videoId });
    await readerController.dispatch({ type: "read-entry" });

    const openController = createTuiController(homeModel(), ports);
    await openController.dispatch({ type: "browse-library" });
    await openController.dispatch({ type: "select-entry", videoId: entry.videoId });
    await openController.dispatch({ type: "open-entry-externally" });

    const doctorController = createTuiController(homeModel(), ports);
    await doctorController.dispatch({ type: "open-doctor" });

    const resultController = createTuiController(homeModel({ result, screen: "result" }), ports);
    await resultController.dispatch({ type: "copy-result" });
    await resultController.dispatch({ type: "reveal-result" });
    await resultController.dispatch({ type: "print-result" });

    const quitController = createTuiController(homeModel(), ports);
    await quitController.dispatch({ type: "back" });

    expect(calls).toEqual([
      "prepare", "list", "read:abc123_DEF4", "list", "open:abc123_DEF4", "doctor",
      "copy:A clean transcript.", "reveal:abc123_DEF4", "print:A clean transcript.", "quit",
    ]);
  });

  test("returns detached snapshots to callers and snapshots port results", async () => {
    const mutableEntry = structuredClone(entry);
    const controller = createTuiController(homeModel(), fakePorts({
      library: {
        list: async () => [mutableEntry],
        open: async () => undefined,
        read: async () => ({ content: "", displayPath: "", title: "" }),
        reveal: async () => undefined,
      },
    }));

    await controller.dispatch({ type: "browse-library" });
    mutableEntry.title = "Mutated by port";
    const snapshot = controller.getModel() as Model & { entries: LibraryEntry[] };
    snapshot.entries[0]!.title = "Mutated by caller";

    expect(controller.getModel().entries[0]?.title).toBe("Example video");
  });
});
