import { homedir } from "node:os";
import { relative } from "node:path";
import {
  listLibraryEntries,
  readLibraryOpenTarget,
  resolveLibraryArtifact,
  revalidateLibraryOpenTarget,
  type LibraryEntry,
  type LibraryFileOperations,
} from "../cli/artifacts";
import { resolveAppPaths, type AppPaths } from "../cli/app-paths";
import { resolveArtifactLibrary } from "../cli/artifact-library";
import { FileConfigStore, type AppConfig } from "../cli/config-store";
import {
  MacOSKeychainCredentialStore,
  resolveOpenCodeApiKey,
  type CredentialStore,
} from "../cli/credentials";
import { defaultDoctor, type DoctorReport } from "../cli/doctor";
import { resolvePackageResources } from "../cli/package-resources";
import {
  inspectRuntime,
  prepareRuntime,
  resolveUvExecutable,
  type RuntimeReadiness,
} from "../cli/runtime-manager";
import { createMacOSSystemActions, type SystemActions } from "../cli/system-actions";
import { ingestVideo, type IngestVideoInput, type IngestVideoResult } from "../ingestion/ingest-video";
import {
  fetchTranscriptOnly,
  type FetchTranscriptOnlyInput,
  type FetchTranscriptOnlyResult,
} from "../ingestion/transcript-only";
import { withRecoveredOutputLibrary } from "../output/output-writer";
import { OpenCodeSummarizer } from "../summarizer/opencode-summarizer";
import type { Summarizer } from "../summarizer/summarizer";
import { PythonYoutubeTranscriptSource } from "../transcript/python-youtube-transcript-source";
import type { TranscriptSource } from "../transcript/transcript-source";
import { YouTubeOEmbedMetadataSource } from "../video/youtube-oembed-metadata-source";
import type { VideoMetadataSource } from "../video/video-metadata-source";
import { parseYouTubeVideoUrl } from "../video/youtube-url";
import { initialModel } from "./model";
import type { TuiLibraryPort, TuiPorts } from "./ports";
import type { TuiBootstrapResult, TuiLifecycle } from "./start";

type RuntimeManager = Readonly<{
  inspect(): Promise<RuntimeReadiness>;
  prepare(): Promise<void>;
}>;

type ConfigStore = Readonly<{
  load(): Promise<AppConfig | null>;
  save(config: AppConfig): Promise<void>;
}>;

type LibraryFactory = (getOutputDir: () => string) => TuiLibraryPort;

export type DefaultTuiDependencies = Readonly<{
  appPaths?: AppPaths;
  configStore?: ConfigStore;
  credentialStore?: CredentialStore;
  doctor?(outputDir: string): Promise<DoctorReport>;
  env?: Record<string, string | undefined>;
  ingest?(input: IngestVideoInput): Promise<IngestVideoResult>;
  libraryFactory?: LibraryFactory;
  metadataSourceFactory?(): VideoMetadataSource;
  resolveCreatedEntry?(outputDir: string, videoId: string): Promise<LibraryEntry>;
  runtimeManager?: RuntimeManager;
  summarizerFactory?(apiKey: string): Summarizer;
  systemActions?: SystemActions;
  transcript?(input: FetchTranscriptOnlyInput): Promise<FetchTranscriptOnlyResult>;
  transcriptSourceFactory?(): TranscriptSource;
  withRecoveredLibrary?<T>(outputDir: string, operation: () => Promise<T>): Promise<T>;
}>;

export type ArtifactLibraryPortOptions = Readonly<{
  fileOperations?: Partial<LibraryFileOperations>;
  getOutputDir(): string;
  systemActions: SystemActions;
  withRecoveredLibrary?<T>(outputDir: string, operation: () => Promise<T>): Promise<T>;
}>;

/**
 * Builds the production session without touching the network. YouTube metadata is
 * instantiated only inside an explicit create operation.
 */
export async function createDefaultTuiSession(
  lifecycle: TuiLifecycle,
  dependencies: DefaultTuiDependencies = {},
): Promise<TuiBootstrapResult> {
  const env = dependencies.env ?? process.env;
  const appPaths = dependencies.appPaths ?? resolveAppPaths(homedir());
  const configStore = dependencies.configStore ?? new FileConfigStore(appPaths.configPath);
  const credentialStore = dependencies.credentialStore ?? new MacOSKeychainCredentialStore();
  const runtime = dependencies.runtimeManager ?? defaultRuntimeManager(appPaths, env);
  const withRecovered = dependencies.withRecoveredLibrary ?? withRecoveredOutputLibrary;
  const systemActions = dependencies.systemActions ?? createMacOSSystemActions();
  const transcriptSourceFactory = dependencies.transcriptSourceFactory ?? (() => new PythonYoutubeTranscriptSource());
  const metadataSourceFactory = dependencies.metadataSourceFactory ?? (() => new YouTubeOEmbedMetadataSource());
  const config = await configStore.load();
  let savedArtifactLibrary = config?.artifactLibrary ?? null;

  const getOutputDir = (): string => resolveArtifactLibrary({
    defaultArtifactLibrary: appPaths.defaultArtifactLibrary,
    envOutputDir: env.VIDEO_DIGEST_OUTPUT_DIR,
    savedArtifactLibrary: savedArtifactLibrary ?? undefined,
  }).path;

  const [runtimeReadiness, credentialConfigured] = await Promise.all([
    safeRuntimeReadiness(runtime),
    safeCredentialConfigured(env, credentialStore),
  ]);

  const library = dependencies.libraryFactory?.(getOutputDir) ?? createArtifactLibraryPort({
    getOutputDir,
    systemActions,
    withRecoveredLibrary: withRecovered,
  });
  const resolveCreatedEntry = dependencies.resolveCreatedEntry ?? (async (outputDir, videoId) => {
    const resolved = (await listLibraryEntries(outputDir)).find((item) => item.videoId === videoId);
    if (!resolved) throw new Error("The created Library Entry could not be resolved.");
    return resolved;
  });

  const resolveEntryAfterWrite = async (outputDir: string, videoId: string): Promise<LibraryEntry> =>
    withRecovered(outputDir, () => resolveCreatedEntry(outputDir, videoId));

  const ports: TuiPorts = {
    config: {
      saveArtifactLibrary: async (path) => {
        const next = { artifactLibrary: path, schemaVersion: "config.v0" } as const;
        await configStore.save(next);
        // Mutate the effective resolver only after persistence succeeds.
        savedArtifactLibrary = next.artifactLibrary;
      },
    },
    create: {
      ingest: async (url, options) => {
        options.signal.throwIfAborted();
        const parsed = parseYouTubeVideoUrl(url);
        const credential = await resolveOpenCodeApiKey({ env, store: credentialStore });
        if (!credential.value) throw new Error("Digest credential is unavailable.");
        options.signal.throwIfAborted();
        const outputDir = getOutputDir();
        const result = await (dependencies.ingest ?? ingestVideo)({
          emailPreview: false,
          metadataSource: metadataSourceFactory(),
          onProgress: (event) => {
            if (!options.signal.aborted) options.onProgress(progressMessage(event.stage));
          },
          outputDir,
          signal: options.signal,
          summarizer: (dependencies.summarizerFactory ?? ((apiKey) => new OpenCodeSummarizer({ apiKey })))(credential.value),
          transcriptSource: transcriptSourceFactory(),
          video: parsed,
        });
        options.signal.throwIfAborted();
        if (result.status !== "completed") throw new Error("Digest generation did not complete.");
        const entry = await resolveEntryAfterWrite(outputDir, parsed.videoId);
        return { cleanText: result.cleanText ?? null, entry, kind: "digest" };
      },
      transcript: async (url, options) => {
        options.signal.throwIfAborted();
        const parsed = parseYouTubeVideoUrl(url);
        const outputDir = getOutputDir();
        const result = await (dependencies.transcript ?? fetchTranscriptOnly)({
          metadataSource: metadataSourceFactory(),
          onProgress: (event) => {
            if (!options.signal.aborted) options.onProgress(progressMessage(event.stage));
          },
          outputDir,
          signal: options.signal,
          transcriptSource: transcriptSourceFactory(),
          video: parsed,
        });
        options.signal.throwIfAborted();
        const entry = await resolveEntryAfterWrite(outputDir, parsed.videoId);
        return { cleanText: result.cleanText, entry, kind: "transcript" };
      },
    },
    credential: {
      saveOpenCodeApiKey: (value) => credentialStore.setOpenCodeApiKey(value),
    },
    doctor: {
      run: () => dependencies.doctor?.(getOutputDir()) ?? defaultDoctor(credentialStore, getOutputDir()),
    },
    library,
    lifecycle: { quit: lifecycle.quit },
    output: { print: lifecycle.print },
    runtime: {
      prepare: () => runtime.prepare(),
      readiness: () => runtime.inspect(),
    },
    system: { copy: systemActions.copy },
  };

  return {
    model: initialModel({
      artifactLibrary: savedArtifactLibrary,
      credentialConfigured,
      runtimeReadiness,
    }),
    ports,
  };
}

export function createArtifactLibraryPort(options: ArtifactLibraryPortOptions): TuiLibraryPort {
  const withRecovered = options.withRecoveredLibrary ?? withRecoveredOutputLibrary;

  const insideLibrary = <T>(operation: (outputDir: string) => Promise<T>): Promise<T> => {
    const outputDir = options.getOutputDir();
    return withRecovered(outputDir, () => operation(outputDir));
  };
  const resolve = (outputDir: string, target: Parameters<TuiLibraryPort["read"]>[0]) =>
    resolveLibraryArtifact(outputDir, target.videoId, target.preference, options.fileOperations);

  return {
    list: () => insideLibrary((outputDir) => listLibraryEntries(outputDir, options.fileOperations)),
    open: (target) => insideLibrary(async (outputDir) => {
      const artifact = await resolve(outputDir, target);
      await revalidateLibraryOpenTarget(artifact.openTarget, options.fileOperations);
      await options.systemActions.open(artifact.openPath);
    }),
    read: (target) => insideLibrary(async (outputDir) => {
      const artifact = await resolve(outputDir, target);
      const content = await readLibraryOpenTarget(artifact.openTarget, options.fileOperations);
      return {
        content,
        displayPath: relative(outputDir, artifact.openPath),
        title: artifact.item.title ?? artifact.item.videoId,
      };
    }),
    reveal: (target) => insideLibrary(async (outputDir) => {
      const artifact = await resolve(outputDir, target);
      await revalidateLibraryOpenTarget(artifact.openTarget, options.fileOperations);
      await options.systemActions.reveal(artifact.openPath);
    }),
  };
}

async function safeRuntimeReadiness(runtime: RuntimeManager): Promise<RuntimeReadiness> {
  try {
    return await runtime.inspect();
  } catch {
    return { remediation: "Run video-digest setup.", status: "missing" };
  }
}

async function safeCredentialConfigured(
  env: Record<string, string | undefined>,
  store: CredentialStore,
): Promise<boolean> {
  try {
    return (await resolveOpenCodeApiKey({ env, store })).value !== null;
  } catch {
    return false;
  }
}

function defaultRuntimeManager(
  appPaths: AppPaths,
  env: Record<string, string | undefined>,
): RuntimeManager {
  const resources = resolvePackageResources(import.meta.url);
  const readLock = () => Bun.file(resources.uvLock).text();
  return {
    inspect: async () => inspectRuntime(appPaths.runtimeDir, await readLock()),
    prepare: async () => prepareRuntime({
      lockContents: await readLock(),
      pythonDir: resources.pythonDir,
      runtimeDir: appPaths.runtimeDir,
      uvPath: resolveUvExecutable(env),
    }),
  };
}

function progressMessage(stage: Parameters<NonNullable<IngestVideoInput["onProgress"]>>[0]["stage"]): string {
  switch (stage) {
    case "fetching-transcript": return "Fetching transcript…";
    case "scoring-transcript": return "Checking transcript quality…";
    case "generating-digest": return "Generating digest…";
    case "writing-outputs": return "Writing Library Entry…";
    case "completed": return "Completed.";
    case "unusable-transcript": return "Transcript quality is not usable.";
  }
}
