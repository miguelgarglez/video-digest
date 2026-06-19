import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Digest } from "../digest/digest";
import type { Transcript } from "../transcript/transcript-source";
import type { TranscriptQuality } from "../transcript/transcript-quality";
import type { YouTubeVideo } from "../video/youtube-url";
import type { VideoMetadata } from "../video/video-metadata-source";
import { renderTranscriptMarkdown, renderTranscriptText } from "./transcript-renderer";
import { withProcessLock } from "../storage/process-lock";

const TRANSACTION_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type IngestionOutputInput = {
  digest: Digest;
  emailPreview: boolean;
  metadata?: VideoMetadata;
  outputDir: string;
  transcript: Transcript;
  transcriptQuality: TranscriptQuality;
  video: YouTubeVideo;
};

export type IngestionOutputPaths = {
  digestPath: string;
  emailPreviewPath: string | null;
  metadataPath: string;
  transcriptJsonPath: string;
  transcriptMarkdownPath: string;
  transcriptTextPath: string;
};

export type TranscriptOnlyOutputInput = {
  metadata?: VideoMetadata;
  outputDir: string;
  transcript: Transcript;
  transcriptQuality: TranscriptQuality;
  video: YouTubeVideo;
};

export type TranscriptOnlyOutputPaths = {
  metadataPath: string;
  transcriptJsonPath: string;
  transcriptMarkdownPath: string;
  transcriptTextPath: string;
};

export type OutputFileOperations = {
  lstat(path: string): Promise<{ dev: number; ino: number; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  pathExists(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  readDirectory(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
};

const defaultFileOperations: OutputFileOperations = {
  lstat,
  pathExists: async (path) => {
    try {
      await access(path);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  },
  realpath,
  readDirectory: readdir,
  readFile: (path) => readFile(path, "utf8"),
  rename,
  unlink,
  writeFile,
};

export class OutputRecoveryError extends Error {
  constructor(
    public readonly preservedBackupPaths: string[],
    cause: unknown,
    message = `Artifact rollback could not restore every previous file. Preserved backup paths: ${preservedBackupPaths.join(", ")}. Restore these files manually before retrying.`,
  ) {
    super(message, { cause });
    this.name = "OutputRecoveryError";
  }
}

export type FailedIngestionMetadataInput = {
  error: {
    code: string;
    message: string;
  };
  outputDir: string;
  metadata?: VideoMetadata;
  transcriptQuality: TranscriptQuality;
  video: YouTubeVideo;
};

export async function writeIngestionOutputs(
  input: IngestionOutputInput,
  fileOperations: Partial<OutputFileOperations> = {},
): Promise<IngestionOutputPaths> {
  return withOutputLibraryLock(input.outputDir, async () =>
    writeIngestionOutputsLocked(input, fileOperations));
}

async function writeIngestionOutputsLocked(
  input: IngestionOutputInput,
  fileOperations: Partial<OutputFileOperations>,
): Promise<IngestionOutputPaths> {
  await recoverPendingOutputTransactionsLocked(input.outputDir, fileOperations);
  const paths = outputPaths(input.outputDir, input.video.videoId, input.emailPreview);

  await Promise.all([
    mkdir(join(input.outputDir, "digests"), { recursive: true }),
    mkdir(join(input.outputDir, "metadata"), { recursive: true }),
    mkdir(join(input.outputDir, "transcripts"), { recursive: true }),
    input.emailPreview ? mkdir(join(input.outputDir, "emails"), { recursive: true }) : undefined,
  ]);

  const entries = [
    { contents: `${JSON.stringify(input.transcript, null, 2)}\n`, path: paths.transcriptJsonPath },
    { contents: renderTranscriptMarkdown(input), path: paths.transcriptMarkdownPath },
    { contents: renderTranscriptText(input.transcript), path: paths.transcriptTextPath },
    { contents: renderDigestMarkdown(input), path: paths.digestPath },
    ...(paths.emailPreviewPath
      ? [{ contents: renderEmailPreview(input), path: paths.emailPreviewPath }]
      : []),
    { contents: `${JSON.stringify(buildMetadata(input), null, 2)}\n`, path: paths.metadataPath },
  ];

  const stalePaths = input.emailPreview
    ? []
    : [join(input.outputDir, "emails", `${input.video.videoId}.md`)];
  await replaceArtifactsTransactionally(
    input.outputDir,
    input.video.videoId,
    entries,
    stalePaths,
    fileOperations,
  );

  return paths;
}

export async function writeTranscriptOnlyOutputs(
  input: TranscriptOnlyOutputInput,
  fileOperations: Partial<OutputFileOperations> = {},
): Promise<TranscriptOnlyOutputPaths> {
  return withOutputLibraryLock(input.outputDir, async () =>
    writeTranscriptOnlyOutputsLocked(input, fileOperations));
}

async function writeTranscriptOnlyOutputsLocked(
  input: TranscriptOnlyOutputInput,
  fileOperations: Partial<OutputFileOperations>,
): Promise<TranscriptOnlyOutputPaths> {
  await recoverPendingOutputTransactionsLocked(input.outputDir, fileOperations);
  const paths = {
    metadataPath: join(input.outputDir, "metadata", `${input.video.videoId}.json`),
    transcriptJsonPath: join(input.outputDir, "transcripts", `${input.video.videoId}.json`),
    transcriptMarkdownPath: join(input.outputDir, "transcripts", `${input.video.videoId}.md`),
    transcriptTextPath: join(input.outputDir, "transcripts", `${input.video.videoId}.txt`),
  };

  await Promise.all([
    mkdir(join(input.outputDir, "metadata"), { recursive: true }),
    mkdir(join(input.outputDir, "transcripts"), { recursive: true }),
  ]);

  await replaceArtifactsTransactionally(
    input.outputDir,
    input.video.videoId,
    [
      { contents: `${JSON.stringify(input.transcript, null, 2)}\n`, path: paths.transcriptJsonPath },
      { contents: renderTranscriptMarkdown(input), path: paths.transcriptMarkdownPath },
      { contents: renderTranscriptText(input.transcript), path: paths.transcriptTextPath },
      {
        contents: `${JSON.stringify(buildTranscriptOnlyMetadata(input), null, 2)}\n`,
        path: paths.metadataPath,
      },
    ],
    [
      join(input.outputDir, "digests", `${input.video.videoId}.md`),
      join(input.outputDir, "emails", `${input.video.videoId}.md`),
    ],
    fileOperations,
  );

  return paths;
}

export async function writeFailedIngestionMetadata(
  input: FailedIngestionMetadataInput,
  fileOperations: Partial<OutputFileOperations> = {},
): Promise<string> {
  return withOutputLibraryLock(input.outputDir, async () =>
    writeFailedIngestionMetadataLocked(input, fileOperations));
}

async function writeFailedIngestionMetadataLocked(
  input: FailedIngestionMetadataInput,
  fileOperations: Partial<OutputFileOperations>,
): Promise<string> {
  await recoverPendingOutputTransactionsLocked(input.outputDir, fileOperations);
  const metadataPath = join(input.outputDir, "metadata", `${input.video.videoId}.json`);

  await mkdir(join(input.outputDir, "metadata"), { recursive: true });
  await replaceArtifactsTransactionally(
    input.outputDir,
    input.video.videoId,
    [
      {
        contents: `${JSON.stringify(
          {
            error: input.error,
            metadataSchemaVersion: "metadata.v0",
            processedAt: new Date().toISOString(),
            transcriptQuality: input.transcriptQuality,
            video: buildVideoMetadata(input.video, input.transcriptQuality, input.metadata),
          },
          null,
          2,
        )}\n`,
        path: metadataPath,
      },
    ],
    [
      join(input.outputDir, "digests", `${input.video.videoId}.md`),
      join(input.outputDir, "emails", `${input.video.videoId}.md`),
      join(input.outputDir, "transcripts", `${input.video.videoId}.json`),
      join(input.outputDir, "transcripts", `${input.video.videoId}.md`),
      join(input.outputDir, "transcripts", `${input.video.videoId}.txt`),
    ],
    fileOperations,
  );

  return metadataPath;
}

function buildTranscriptOnlyMetadata(input: TranscriptOnlyOutputInput) {
  return {
    metadataSchemaVersion: "metadata.v0",
    mode: "transcript-only",
    processedAt: new Date().toISOString(),
    transcriptQuality: input.transcriptQuality,
    video: buildVideoMetadata(input.video, input.transcriptQuality, input.metadata),
  };
}

function buildVideoMetadata(
  video: YouTubeVideo,
  transcriptQuality: TranscriptQuality,
  metadata?: VideoMetadata,
) {
  return {
    canonicalUrl: video.canonicalUrl,
    channel: metadata?.channel ?? null,
    durationSeconds: transcriptQuality.durationSeconds,
    videoId: video.videoId,
    videoTitle: metadata?.title ?? null,
  };
}

function outputPaths(outputDir: string, videoId: string, emailPreview: boolean): IngestionOutputPaths {
  return {
    digestPath: join(outputDir, "digests", `${videoId}.md`),
    emailPreviewPath: emailPreview ? join(outputDir, "emails", `${videoId}.md`) : null,
    metadataPath: join(outputDir, "metadata", `${videoId}.json`),
    transcriptJsonPath: join(outputDir, "transcripts", `${videoId}.json`),
    transcriptMarkdownPath: join(outputDir, "transcripts", `${videoId}.md`),
    transcriptTextPath: join(outputDir, "transcripts", `${videoId}.txt`),
  };
}

type OutputTransactionArtifact = {
  backupPath: string;
  hadOriginal: boolean;
  targetPath: string;
  tempPath: string;
};

type OutputTransactionManifest = {
  artifacts: OutputTransactionArtifact[];
  schemaVersion: "output-transaction.v0";
  state: "committed" | "prepared";
  token: string;
  videoId: string;
};

export async function recoverPendingOutputTransactions(
  outputDir: string,
  operationOverrides: Partial<OutputFileOperations> = {},
): Promise<void> {
  await withRecoveredOutputLibrary(outputDir, async () => {}, operationOverrides);
}

export async function withRecoveredOutputLibrary<T>(
  outputDir: string,
  operation: () => Promise<T>,
  operationOverrides: Partial<OutputFileOperations> = {},
): Promise<T> {
  return withOutputLibraryLock(outputDir, async () => {
    await recoverPendingOutputTransactionsLocked(outputDir, operationOverrides);
    return operation();
  });
}

async function recoverPendingOutputTransactionsLocked(
  outputDir: string,
  operationOverrides: Partial<OutputFileOperations> = {},
): Promise<void> {
  const fileOperations = { ...defaultFileOperations, ...operationOverrides };
  const transactionDir = join(outputDir, ".transactions");
  let directoryNames: string[];

  try {
    directoryNames = await fileOperations.readDirectory(transactionDir);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  const manifestNames = directoryNames.filter((name) => name.endsWith(".json")).sort();

  const manifests = await Promise.all(
    manifestNames.map(async (name) => {
      const manifestPath = join(transactionDir, name);
      try {
        const parsed = JSON.parse(await fileOperations.readFile(manifestPath));
        return {
          manifest: validateManifest(parsed, outputDir, name),
          manifestPath,
        };
      } catch (error) {
        throw new OutputRecoveryError(
          [],
          error,
          `Cannot recover unsafe output transaction manifest ${manifestPath}. No artifact paths were changed; inspect or remove the manifest manually.`,
        );
      }
    }),
  );

  const safeParents = await validateRecoveryPathsSafe(
    outputDir,
    manifests.map(({ manifest }) => manifest),
    fileOperations,
  );
  const manifestNameSet = new Set(manifestNames);
  for (const name of directoryNames) {
    const match = name.match(/^([0-9a-f-]{36})\.json(?:\.commit)?\.tmp$/i);
    if (match && !TRANSACTION_TOKEN_PATTERN.test(match[1]!)) continue;
    if (!match || manifestNameSet.has(`${match[1]}.json`)) continue;
    await unlinkIfPresent(join(transactionDir, name), fileOperations);
  }
  await cleanupOrphanArtifactTemps(outputDir, new Set(manifests.map(({ manifest }) => manifest.token)), fileOperations);

  for (const { manifest, manifestPath } of manifests) {
    const recoveryFailures: string[] = [];
    let recoveryFailed = false;
    for (const artifact of manifest.artifacts) {
      try {
        if (manifest.state === "committed") {
            await safeUnlinkIfPresent(artifact.backupPath, safeParents, fileOperations);
        } else {
          if (artifact.hadOriginal) {
            if (await fileOperations.pathExists(artifact.backupPath)) {
              await safeUnlinkIfPresent(artifact.targetPath, safeParents, fileOperations);
              await safeRename(artifact.backupPath, artifact.targetPath, safeParents, fileOperations);
            }
          } else {
            await safeUnlinkIfPresent(artifact.targetPath, safeParents, fileOperations);
          }
        }
      } catch (error) {
        recoveryFailed = true;
        const preserved = await fileOperations.pathExists(artifact.backupPath)
          ? [artifact.backupPath]
          : [];
        recoveryFailures.push(...preserved);
      } finally {
        await safeUnlinkIfPresent(artifact.tempPath, safeParents, fileOperations);
      }
    }
    if (recoveryFailed) {
      throw new OutputRecoveryError(recoveryFailures, new Error("Output recovery incomplete"));
    }
    await unlinkIfPresent(`${manifestPath}.commit.tmp`, fileOperations);
    await fileOperations.unlink(manifestPath);
  }
}

async function replaceArtifactsTransactionally(
  outputDir: string,
  videoId: string,
  entries: Array<{ contents: string; path: string }>,
  removalPaths: string[],
  operationOverrides: Partial<OutputFileOperations>,
): Promise<void> {
  const fileOperations = { ...defaultFileOperations, ...operationOverrides };
  const operationId = randomUUID();
  const temporaryEntries = entries.map((entry) => ({
    ...entry,
    temporaryPath: `${entry.path}.${operationId}.tmp`,
  }));
  const destinations = [...entries.map((entry) => entry.path), ...removalPaths];
  const backups: Array<{ backupPath: string; path: string }> = [];
  const transactionDir = join(outputDir, ".transactions");
  const manifestPath = join(transactionDir, `${operationId}.json`);
  const manifestTempPath = `${manifestPath}.tmp`;
  const committedManifestTempPath = `${manifestPath}.commit.tmp`;
  let manifestPublished = false;

  try {
    const safeParents = await validateRecoveryPathsSafe(
      outputDir,
      [{
        artifacts: destinations.map((targetPath) => ({
          backupPath: `${targetPath}.${operationId}.backup`,
          hadOriginal: false,
          targetPath,
          tempPath: `${targetPath}.${operationId}.tmp`,
        })),
        schemaVersion: "output-transaction.v0",
        state: "prepared",
        token: operationId,
        videoId,
      }],
      fileOperations,
    );
    const writeResults = await Promise.allSettled(
      temporaryEntries.map((entry) => safeWriteFile(
        entry.temporaryPath,
        entry.contents,
        safeParents,
        fileOperations,
      )),
    );
    const failedWrite = writeResults.find((result) => result.status === "rejected");
    if (failedWrite?.status === "rejected") {
      throw failedWrite.reason;
    }

    const manifest: OutputTransactionManifest = {
      artifacts: await Promise.all(
        destinations.map(async (targetPath) => ({
          backupPath: `${targetPath}.${operationId}.backup`,
          hadOriginal: await fileOperations.pathExists(targetPath),
          targetPath,
          tempPath: `${targetPath}.${operationId}.tmp`,
        })),
      ),
      schemaVersion: "output-transaction.v0",
      state: "prepared",
      token: operationId,
      videoId,
    };
    await mkdir(transactionDir, { recursive: true });
    await fileOperations.writeFile(manifestTempPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await fileOperations.rename(manifestTempPath, manifestPath);
    manifestPublished = true;

    for (const artifact of manifest.artifacts) {
      if (!artifact.hadOriginal) continue;
      await safeRename(artifact.targetPath, artifact.backupPath, safeParents, fileOperations);
      backups.push({ backupPath: artifact.backupPath, path: artifact.targetPath });
    }

    for (const entry of temporaryEntries) {
      await safeRename(entry.temporaryPath, entry.path, safeParents, fileOperations);
    }

    const committedManifest: OutputTransactionManifest = {
      ...manifest,
      state: "committed",
    };
    await fileOperations.writeFile(
      committedManifestTempPath,
      `${JSON.stringify(committedManifest, null, 2)}\n`,
    );
    await fileOperations.rename(committedManifestTempPath, manifestPath);

    const cleanupResults = await Promise.allSettled(
      backups.map(({ backupPath }) => safeUnlinkIfPresent(backupPath, safeParents, fileOperations)),
    );
    const preservedBackupPaths = backups
      .filter((_, index) => cleanupResults[index]?.status === "rejected")
      .map(({ backupPath }) => backupPath);
    if (preservedBackupPaths.length > 0) {
      throw new OutputRecoveryError(preservedBackupPaths, cleanupResults);
    }
    await Promise.allSettled(
      temporaryEntries.map((entry) => safeUnlinkIfPresent(entry.temporaryPath, safeParents, fileOperations)),
    );
    await fileOperations.unlink(manifestPath);
  } catch (error) {
    if (error instanceof OutputRecoveryError) throw error;

    if (manifestPublished) {
      try {
        await recoverPendingOutputTransactionsLocked(outputDir, fileOperations);
      } catch (recoveryError) {
        throw recoveryError;
      }
      throw error;
    }

    await Promise.allSettled(
      [
        ...temporaryEntries.map((entry) => fileOperations.unlink(entry.temporaryPath)),
        fileOperations.unlink(manifestTempPath),
        fileOperations.unlink(committedManifestTempPath),
      ],
    );
    throw error;
  }
}

async function withOutputLibraryLock<T>(outputDir: string, operation: () => Promise<T>): Promise<T> {
  const transactionDir = join(outputDir, ".transactions");
  await mkdir(transactionDir, { recursive: true });
  const canonicalRoot = await realpath(outputDir);
  if ((await lstat(transactionDir)).isSymbolicLink()) {
    throw new OutputRecoveryError([], new Error("Symlinked transaction directory"));
  }
  const transactionRelative = relative(canonicalRoot, await realpath(transactionDir));
  if (transactionRelative.startsWith("..") || isAbsolute(transactionRelative)) {
    throw new OutputRecoveryError([], new Error("Transaction directory escapes output root"));
  }
  return withProcessLock({ lockDir: join(transactionDir, "library.lock") }, operation);
}

function validateManifest(
  value: unknown,
  outputDir: string,
  manifestName: string,
): OutputTransactionManifest {
  if (!isRecord(value)
    || !hasExactKeys(value, ["artifacts", "schemaVersion", "state", "token", "videoId"])
    || value.schemaVersion !== "output-transaction.v0"
    || (value.state !== "prepared" && value.state !== "committed")
    || typeof value.token !== "string"
    || !TRANSACTION_TOKEN_PATTERN.test(value.token)
    || manifestName !== `${value.token}.json`
    || typeof value.videoId !== "string"
    || !/^[A-Za-z0-9_-]{11}$/.test(value.videoId)
    || !Array.isArray(value.artifacts)
    || value.artifacts.length === 0
  ) {
    throw new Error("Unexpected output transaction manifest schema");
  }

  const seenTargets = new Set<string>();
  const videoId = value.videoId;
  const token = value.token;
  const artifacts = value.artifacts.map((artifact) => {
    if (!isRecord(artifact)
      || !hasExactKeys(artifact, ["backupPath", "hadOriginal", "targetPath", "tempPath"])
      || typeof artifact.backupPath !== "string"
      || typeof artifact.hadOriginal !== "boolean"
      || typeof artifact.targetPath !== "string"
      || typeof artifact.tempPath !== "string"
      || !isOwnedTargetPath(outputDir, videoId, artifact.targetPath)
      || artifact.backupPath !== `${artifact.targetPath}.${token}.backup`
      || artifact.tempPath !== `${artifact.targetPath}.${token}.tmp`
      || seenTargets.has(artifact.targetPath)
    ) {
      throw new Error("Unsafe output transaction artifact path");
    }
    seenTargets.add(artifact.targetPath);
    return artifact as OutputTransactionArtifact;
  });

  return { ...value, artifacts } as OutputTransactionManifest;
}

function isOwnedTargetPath(outputDir: string, videoId: string, targetPath: string): boolean {
  const relativePath = relative(resolve(outputDir), resolve(targetPath));
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return false;
  const normalized = relativePath.replaceAll("\\", "/");
  return new Set([
    `digests/${videoId}.md`,
    `emails/${videoId}.md`,
    `metadata/${videoId}.json`,
    `transcripts/${videoId}.json`,
    `transcripts/${videoId}.md`,
    `transcripts/${videoId}.txt`,
  ]).has(normalized);
}

async function validateRecoveryPathsSafe(
  outputDir: string,
  manifests: OutputTransactionManifest[],
  fileOperations: OutputFileOperations,
): Promise<Map<string, { dev: number; ino: number }>> {
  const canonicalRoot = await fileOperations.realpath(outputDir);
  const safeParents = new Map<string, { dev: number; ino: number }>();
  for (const manifest of manifests) {
    for (const artifact of manifest.artifacts) {
      for (const path of [artifact.targetPath, artifact.backupPath, artifact.tempPath]) {
        const parent = dirname(path);
        try {
          const stats = await fileOperations.lstat(parent);
          if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw new Error(`Symlinked artifact parent: ${parent}`);
          }
          const canonicalParent = await fileOperations.realpath(parent);
          const fromRoot = relative(canonicalRoot, canonicalParent);
          if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
            throw new Error(`Artifact parent escapes output root: ${parent}`);
          }
          safeParents.set(parent, { dev: stats.dev, ino: stats.ino });
        } catch (error) {
          if (isMissingPathError(error)) continue;
          throw new OutputRecoveryError(
            [],
            error,
            `Cannot recover unsafe output transaction path ${path}. No artifact paths were changed.`,
          );
        }
      }
    }
  }
  return safeParents;
}

// Node/Bun expose no unlinkat/renameat. We bind validation to mutation by checking the
// opened path's parent inode immediately before each syscall. Same-user swaps in the
// remaining syscall-sized window are outside this local-first application's threat model.
async function assertStableParent(
  path: string,
  safeParents: Map<string, { dev: number; ino: number }>,
  fileOperations: OutputFileOperations,
): Promise<void> {
  const parent = dirname(path);
  const expected = safeParents.get(parent);
  if (!expected) return;
  const current = await fileOperations.lstat(parent);
  if (current.isSymbolicLink() || !current.isDirectory()
    || current.dev !== expected.dev || current.ino !== expected.ino
  ) {
    throw new OutputRecoveryError([], new Error(`Artifact parent changed: ${parent}`));
  }
}

async function safeRename(
  from: string,
  to: string,
  safeParents: Map<string, { dev: number; ino: number }>,
  fileOperations: OutputFileOperations,
): Promise<void> {
  await assertStableParent(from, safeParents, fileOperations);
  await assertStableParent(to, safeParents, fileOperations);
  await fileOperations.rename(from, to);
}

async function safeWriteFile(
  path: string,
  contents: string,
  safeParents: Map<string, { dev: number; ino: number }>,
  fileOperations: OutputFileOperations,
): Promise<void> {
  await assertStableParent(path, safeParents, fileOperations);
  await fileOperations.writeFile(path, contents);
}

async function safeUnlinkIfPresent(
  path: string,
  safeParents: Map<string, { dev: number; ino: number }>,
  fileOperations: OutputFileOperations,
): Promise<void> {
  await assertStableParent(path, safeParents, fileOperations);
  await unlinkIfPresent(path, fileOperations);
}

async function cleanupOrphanArtifactTemps(
  outputDir: string,
  activeTokens: Set<string>,
  fileOperations: OutputFileOperations,
): Promise<void> {
  const layouts = [
    { directory: "digests", pattern: /^([A-Za-z0-9_-]{11})\.md\.([0-9a-f-]{36})\.tmp$/i },
    { directory: "emails", pattern: /^([A-Za-z0-9_-]{11})\.md\.([0-9a-f-]{36})\.tmp$/i },
    { directory: "metadata", pattern: /^([A-Za-z0-9_-]{11})\.json\.([0-9a-f-]{36})\.tmp$/i },
    { directory: "transcripts", pattern: /^([A-Za-z0-9_-]{11})\.(?:json|md|txt)\.([0-9a-f-]{36})\.tmp$/i },
  ];
  const canonicalRoot = await fileOperations.realpath(outputDir);
  for (const layout of layouts) {
    const directoryPath = join(outputDir, layout.directory);
    let names: string[];
    let directoryIdentity: { dev: number; ino: number };
    try {
      const directoryStats = await fileOperations.lstat(directoryPath);
      if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
        throw new OutputRecoveryError([], new Error(`Symlinked artifact directory: ${directoryPath}`));
      }
      const fromRoot = relative(canonicalRoot, await fileOperations.realpath(directoryPath));
      if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
        throw new OutputRecoveryError([], new Error(`Artifact directory escapes root: ${directoryPath}`));
      }
      directoryIdentity = { dev: directoryStats.dev, ino: directoryStats.ino };
      names = await fileOperations.readDirectory(directoryPath);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    for (const name of names) {
      const match = name.match(layout.pattern);
      const token = match?.[2];
      if (!token || !TRANSACTION_TOKEN_PATTERN.test(token) || activeTokens.has(token)) continue;
      const current = await fileOperations.lstat(directoryPath);
      if (current.isSymbolicLink() || current.dev !== directoryIdentity.dev
        || current.ino !== directoryIdentity.ino
      ) {
        throw new OutputRecoveryError([], new Error(`Artifact directory changed: ${directoryPath}`));
      }
      await unlinkIfPresent(join(directoryPath, name), fileOperations);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

async function unlinkIfPresent(path: string, fileOperations: OutputFileOperations): Promise<void> {
  try {
    await fileOperations.unlink(path);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function buildMetadata(input: IngestionOutputInput) {
  return {
    digest: input.digest,
    metadataSchemaVersion: "metadata.v0",
    processedAt: new Date().toISOString(),
    transcriptQuality: input.transcriptQuality,
    video: buildVideoMetadata(input.video, input.transcriptQuality, input.metadata),
  };
}

function renderDigestMarkdown(input: IngestionOutputInput): string {
  const sections = [
    `# ${input.digest.digestTitle}`,
    "",
    `URL: ${input.video.canonicalUrl}`,
    `Video ID: ${input.video.videoId}`,
    `Transcript source: ${input.transcript.source}`,
    `Transcript quality: ${input.transcriptQuality.status}`,
    "",
    renderWarnings(input.transcriptQuality),
    "## TL;DR",
    renderList(input.digest.tldr),
    "## Key ideas",
    renderList(input.digest.keyIdeas),
    "## Relevant timestamps",
    renderTimestampList(input.digest.relevantTimestamps),
    "## Actionable ideas",
    renderList(input.digest.actionableIdeas),
    "## Concepts to investigate",
    renderList(input.digest.conceptsToInvestigate),
    "## Connections",
    renderList(input.digest.connections),
    "## Verdict",
    input.digest.verdict,
    "",
  ];

  return sections.filter((section) => section !== null).join("\n");
}

function renderEmailPreview(input: IngestionOutputInput): string {
  return [
    `Subject: ${input.digest.digestTitle}`,
    "",
    renderDigestMarkdown(input),
  ].join("\n");
}

function renderWarnings(quality: TranscriptQuality): string | null {
  if (quality.warnings.length === 0) {
    return null;
  }

  return ["## Transcript warnings", renderList(quality.warnings), ""].join("\n");
}

function renderList(items: string[]): string {
  if (items.length === 0) {
    return "- None\n";
  }

  return `${items.map((item) => `- ${item}`).join("\n")}\n`;
}

function renderTimestampList(items: Digest["relevantTimestamps"]): string {
  if (items.length === 0) {
    return "- None\n";
  }

  return `${items.map((item) => `- ${item.timestamp}: ${item.note}`).join("\n")}\n`;
}
