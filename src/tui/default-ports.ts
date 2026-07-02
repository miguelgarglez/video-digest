import { arch, homedir } from "node:os";
import { isAbsolute, join, normalize, relative } from "node:path";
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
  resolveProviderApiKey,
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
import { createProviderSummarizer } from "../summarizer/provider-summarizer";
import { DIGEST_PROVIDER_IDS, type DigestProviderId } from "../summarizer/providers";
import { resolveDigestSelection, type ResolvedDigestSelection } from "../cli/digest-config";
import type { Summarizer } from "../summarizer/summarizer";
import { PythonYoutubeTranscriptSource } from "../transcript/python-youtube-transcript-source";
import type { TranscriptSource } from "../transcript/transcript-source";
import { YouTubeOEmbedMetadataSource } from "../video/youtube-oembed-metadata-source";
import type { VideoMetadataSource } from "../video/video-metadata-source";
import { parseYouTubeVideoUrl } from "../video/youtube-url";
import { VIDEO_DIGEST_VERSION } from "../version";
import { resolveSupportContext } from "./feedback";
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
  homeDir?: string;
  ingest?(input: IngestVideoInput): Promise<IngestVideoResult>;
  libraryFactory?: LibraryFactory;
  metadataSourceFactory?(): VideoMetadataSource;
  resolveCreatedEntry?(outputDir: string, videoId: string): Promise<LibraryEntry>;
  runtimeManager?: RuntimeManager;
  summarizerFactory?(selection: ResolvedDigestSelection, apiKey: string): Summarizer;
  supportContextResolver?: typeof resolveSupportContext;
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
  const homeDir = dependencies.homeDir ?? homedir();
  const appPaths = dependencies.appPaths ?? resolveAppPaths(homeDir);
  const configStore = dependencies.configStore ?? new FileConfigStore(appPaths.configPath);
  const credentialStore = dependencies.credentialStore ?? new MacOSKeychainCredentialStore();
  const runtime = dependencies.runtimeManager ?? defaultRuntimeManager(appPaths, env);
  const withRecovered = dependencies.withRecoveredLibrary ?? withRecoveredOutputLibrary;
  const systemActions = dependencies.systemActions ?? createMacOSSystemActions();
  const transcriptSourceFactory = dependencies.transcriptSourceFactory ?? (() => new PythonYoutubeTranscriptSource());
  const metadataSourceFactory = dependencies.metadataSourceFactory ?? (() => new YouTubeOEmbedMetadataSource());
  let savedConfig = await configStore.load();
  let savedArtifactLibrary = savedConfig
    ? normalizeArtifactLibraryPath(savedConfig.artifactLibrary, homeDir)
    : null;

  const getOutputDir = (): string => resolveArtifactLibrary({
    defaultArtifactLibrary: appPaths.defaultArtifactLibrary,
    envOutputDir: env.VIDEO_DIGEST_OUTPUT_DIR,
    savedArtifactLibrary: savedArtifactLibrary ?? undefined,
  }).path;

  const [runtimeReadiness, credentials, supportContext] = await Promise.all([
    safeRuntimeReadiness(runtime),
    safeCredentials(env, credentialStore),
    (dependencies.supportContextResolver ?? resolveSupportContext)({
      appVersion: VIDEO_DIGEST_VERSION,
      architecture: arch(),
    }),
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
        const artifactLibrary = normalizeArtifactLibraryPath(path, homeDir);
        const next: AppConfig = {
          artifactLibrary,
          digest: savedConfig?.digest ?? { defaultProvider: "opencode", models: {} },
          schemaVersion: "config.v1",
        };
        await configStore.save(next);
        // Mutate the effective resolver only after persistence succeeds.
        savedConfig = next;
        savedArtifactLibrary = next.artifactLibrary;
        return next.artifactLibrary;
      },
      saveProvider: async (provider) => {
        const next: AppConfig = {
          artifactLibrary: savedConfig?.artifactLibrary ?? getOutputDir(),
          digest: { defaultProvider: provider, models: savedConfig?.digest.models ?? {} },
          schemaVersion: "config.v1",
        };
        await configStore.save(next);
        savedConfig = next;
      },
      saveModel: async (provider, model) => {
        const next: AppConfig = {
          artifactLibrary: savedConfig?.artifactLibrary ?? getOutputDir(),
          digest: {
            defaultProvider: savedConfig?.digest.defaultProvider ?? "opencode",
            models: { ...(savedConfig?.digest.models ?? {}), [provider]: model },
          },
          schemaVersion: "config.v1",
        };
        await configStore.save(next);
        savedConfig = next;
      },
    },
    create: {
      ingest: async (url, options) => {
        options.signal.throwIfAborted();
        const parsed = parseYouTubeVideoUrl(url);
        const selection = resolveDigestSelection({ config: savedConfig, env });
        const credential = await resolveProviderApiKey({ env, provider: selection.provider.effective, store: credentialStore });
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
          summarizer: (dependencies.summarizerFactory ?? createProviderSummarizer)(selection, credential.value),
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
      deleteApiKey: (provider) => credentialStore.deleteApiKey(provider),
      saveApiKey: (provider, value) => credentialStore.setApiKey(provider, value),
    },
    doctor: {
      run: () => dependencies.doctor?.(getOutputDir()) ?? defaultDoctor(
        credentialStore,
        getOutputDir(),
        resolveDigestSelection({ config: savedConfig, env }),
        env,
      ),
    },
    library,
    lifecycle: { quit: lifecycle.quit },
    output: { print: lifecycle.print },
    runtime: {
      prepare: () => runtime.prepare(),
      readiness: () => runtime.inspect(),
    },
    system: { copy: systemActions.copy, openExternal: systemActions.openExternal },
  };

  return {
    model: initialModel({
      artifactLibrary: savedArtifactLibrary,
      defaultArtifactLibrary: appPaths.defaultArtifactLibrary,
      credentials,
      digestModel: resolveDigestSelection({ config: savedConfig, env }).model.effective,
      digestProvider: resolveDigestSelection({ config: savedConfig, env }).provider.effective,
      runtimeReadiness,
      supportContext,
    }),
    ports,
  };
}

export function normalizeArtifactLibraryPath(input: string, homeDir: string): string {
  const value = input.trim();
  let expanded: string;
  if (value === "~") expanded = homeDir;
  else if (value.startsWith("~/")) expanded = join(homeDir, value.slice(2));
  else if (value.startsWith("~")) throw new Error("Artifact Library uses an unsupported home shorthand.");
  else expanded = value;

  if (!isAbsolute(expanded)) throw new Error("Artifact Library must be an absolute path.");
  return normalize(expanded);
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

async function safeCredentials(
  env: Record<string, string | undefined>,
  store: CredentialStore,
): Promise<Record<DigestProviderId, boolean>> {
  const entries = await Promise.all(DIGEST_PROVIDER_IDS.map(async (provider) => {
    try {
      return [provider, (await resolveProviderApiKey({ env, provider, store })).value !== null] as const;
    } catch {
      return [provider, false] as const;
    }
  }));
  return Object.fromEntries(entries) as Record<DigestProviderId, boolean>;
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
