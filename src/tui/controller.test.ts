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
    config: { saveArtifactLibrary: async () => undefined },
    create: {
      ingest: async () => ({ ...result, kind: "digest" }),
      transcript: async () => result,
    },
    credential: { saveOpenCodeApiKey: async () => undefined },
    doctor: { run: async () => ({ checks: [], ok: true }) },
    library: { list: async () => [entry] },
    lifecycle: { quit: () => undefined },
    output: { print: () => undefined },
    reader: { read: async () => "contents" },
    runtime: {
      prepare: async () => undefined,
      readiness: async () => ({ status: "ready" }),
    },
    system: {
      copy: async () => undefined,
      open: async () => undefined,
      reveal: async () => undefined,
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
      config: { saveArtifactLibrary: async (path) => { saved.push(path); } },
    }), { onEvent: (event) => events.push(event) });

    await controller.dispatch({ type: "save-library", path: "/tmp/library" });

    expect(saved).toEqual(["/tmp/library"]);
    expect(events).toContainEqual({ type: "library-saved", path: "/tmp/library", requestId: 1 });
    expect(controller.getModel().screen).toBe("home");
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
    await controller.runEffect({ type: "cancel-operation", requestId: 1 });
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

  test("maps every persistent and dismissible service effect", async () => {
    const calls: string[] = [];
    const report: DoctorReport = { checks: [], ok: true };
    const ports = fakePorts({
      doctor: { run: async () => { calls.push("doctor"); return report; } },
      library: { list: async () => { calls.push("list"); return [entry]; } },
      lifecycle: { quit: () => { calls.push("quit"); } },
      output: { print: (text) => { calls.push(`print:${text}`); } },
      reader: { read: async (path) => { calls.push(`read:${path}`); return "reader"; } },
      runtime: {
        prepare: async () => { calls.push("prepare"); },
        readiness: async () => ({ status: "ready" }),
      },
      system: {
        copy: async (text) => { calls.push(`copy:${text}`); },
        open: async (path) => { calls.push(`open:${path}`); },
        reveal: async (path) => { calls.push(`reveal:${path}`); },
      },
    });
    const controller = createTuiController(homeModel(), ports);

    await controller.runEffect({ requestId: 10, type: "prepare-runtime" });
    await controller.runEffect({ requestId: 11, type: "load-library" });
    await controller.runEffect({ path: "/a.md", requestId: 12, type: "read" });
    await controller.runEffect({ requestId: 13, type: "run-doctor" });
    await controller.runEffect({ requestId: 14, text: "copy", type: "copy" });
    await controller.runEffect({ path: "/a.md", requestId: 15, type: "open" });
    await controller.runEffect({ path: "/a.md", requestId: 16, type: "reveal" });
    await controller.runEffect({ requestId: 17, text: "stdout", type: "print" });
    await controller.runEffect({ type: "quit" });

    expect(calls).toEqual([
      "prepare", "list", "read:/a.md", "doctor", "copy:copy", "open:/a.md",
      "reveal:/a.md", "print:stdout", "quit",
    ]);
  });

  test("returns detached snapshots to callers and snapshots port results", async () => {
    const mutableEntry = structuredClone(entry);
    const controller = createTuiController(homeModel(), fakePorts({
      library: { list: async () => [mutableEntry] },
    }));

    await controller.dispatch({ type: "browse-library" });
    mutableEntry.title = "Mutated by port";
    const snapshot = controller.getModel() as Model & { entries: LibraryEntry[] };
    snapshot.entries[0]!.title = "Mutated by caller";

    expect(controller.getModel().entries[0]?.title).toBe("Example video");
  });
});
