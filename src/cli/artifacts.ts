import { constants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const OPEN_READ_ONLY_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

type FileIdentity = { dev: number; ino: number };
type FileStats = FileIdentity & {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

export type LibraryFileHandle = {
  close(): Promise<void>;
  readFile(options: { encoding: "utf8" }): Promise<string>;
  stat(): Promise<FileStats>;
};

export type LibraryFileOperations = {
  lstat(path: string): Promise<FileStats>;
  open(path: string, flags: number): Promise<LibraryFileHandle>;
  readdir(path: string): Promise<string[]>;
  realpath(path: string): Promise<string>;
};

const defaultFileOperations: LibraryFileOperations = {
  lstat,
  open: (path, flags) => open(path, flags) as Promise<FileHandle & LibraryFileHandle>,
  readdir,
  realpath,
};

export type LibraryEntryPaths = {
  digestPath: string | null;
  emailPreviewPath: string | null;
  metadataPath: string;
  transcriptJsonPath: string | null;
  transcriptMarkdownPath: string | null;
  transcriptTextPath: string | null;
};

export type LibraryEntry = {
  channel: string | null;
  paths: LibraryEntryPaths;
  title: string | null;
  updatedAt: string;
  videoId: string;
};

export type LibraryOpenTarget = {
  fileIdentity: FileIdentity;
  parentIdentity: FileIdentity;
  parentPath: string;
  path: string;
  rootPath: string;
};

export type ResolvedLibraryEntry = {
  item: LibraryEntry;
  ok: true;
  openPath: string;
  openTarget: LibraryOpenTarget;
};

export type LibraryEntryErrorCode = "library-entry-not-found" | "library-entry-not-openable";

export type UnresolvedLibraryEntry = {
  errorCode: LibraryEntryErrorCode;
  message: string;
  ok: false;
};

type LibraryMetadata = {
  channel: string | null;
  processedAt: string;
  title: string | null;
};

type AvailableArtifact = {
  path: string;
  target: LibraryOpenTarget;
};

const entryOpenTargets = new WeakMap<LibraryEntry, Map<string, LibraryOpenTarget>>();

export class LibraryIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryIntegrityError";
  }
}

export async function listLibraryEntries(
  outputDir: string,
  fileOperations: Partial<LibraryFileOperations> = {},
): Promise<LibraryEntry[]> {
  const operations = { ...defaultFileOperations, ...fileOperations };
  const rootPath = await realpathIfPresent(outputDir, operations);
  if (!rootPath) return [];

  const metadataDir = join(outputDir, "metadata");
  const metadataParent = await captureDirectoryIfPresent(metadataDir, rootPath, operations);
  if (!metadataParent) return [];

  let files: string[];
  try {
    files = await operations.readdir(metadataDir);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const candidates = await Promise.all(
    files
      .filter((file) => extname(file) === ".json" && VIDEO_ID_PATTERN.test(basename(file, ".json")))
      .map((file) => readLibraryEntry(outputDir, rootPath, metadataParent, file, operations)),
  );

  return candidates
    .filter((entry): entry is LibraryEntry => entry !== null)
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.videoId.localeCompare(right.videoId));
}

export async function resolveLibraryEntry(
  outputDir: string,
  target: string,
  fileOperations: Partial<LibraryFileOperations> = {},
): Promise<ResolvedLibraryEntry | UnresolvedLibraryEntry> {
  const items = await listLibraryEntries(outputDir, fileOperations);
  const item = target === "latest"
    ? items[0]
    : items.find((candidate) => candidate.videoId === target);
  if (!item) {
    return {
      errorCode: "library-entry-not-found",
      message: target === "latest"
        ? "No Library Entries found."
        : `No Library Entry found for video ${target}.`,
      ok: false,
    };
  }

  const openPath = preferredOpenPath(item);
  const openTarget = openPath ? entryOpenTargets.get(item)?.get(openPath) : undefined;
  if (!openPath || !openTarget) {
    return {
      errorCode: "library-entry-not-openable",
      message: `Library Entry ${item.videoId} has no readable Digest or Transcript Markdown. Reprocess the video to restore it.`,
      ok: false,
    };
  }

  return { item, ok: true, openPath, openTarget };
}

/**
 * Revalidates the selected inode immediately before a path-based system opener is
 * invoked. A same-user process can still replace the path in the syscall-sized gap
 * between this check and `open(1)`; macOS does not offer an fd-based Finder opener.
 */
export async function revalidateLibraryOpenTarget(
  target: LibraryOpenTarget,
  fileOperations: Partial<LibraryFileOperations> = {},
): Promise<void> {
  const operations = { ...defaultFileOperations, ...fileOperations };
  await assertDirectoryIdentity(target.parentPath, target.rootPath, target.parentIdentity, operations);
  await assertFileIdentity(target.path, target.rootPath, target.fileIdentity, operations);
  await inspectOpenFile(target.path, target.fileIdentity, operations, async () => undefined);
}

async function readLibraryEntry(
  outputDir: string,
  rootPath: string,
  metadataParent: LibraryOpenTarget["parentIdentity"],
  metadataFile: string,
  operations: LibraryFileOperations,
): Promise<LibraryEntry | null> {
  const videoId = basename(metadataFile, ".json");
  const metadataPath = join(outputDir, "metadata", metadataFile);
  const metadataIdentity = await captureFileIfPresent(metadataPath, rootPath, operations);
  if (!metadataIdentity) return null;

  await assertDirectoryIdentity(dirname(metadataPath), rootPath, metadataParent, operations);
  const contents = await inspectOpenFile(
    metadataPath,
    metadataIdentity,
    operations,
    (handle) => handle.readFile({ encoding: "utf8" }),
  );

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const metadata = parseMetadata(value, videoId);
  if (!metadata) return null;

  const artifacts = await Promise.all([
    availableArtifact(outputDir, rootPath, "digests", `${videoId}.md`, operations),
    availableArtifact(outputDir, rootPath, "emails", `${videoId}.md`, operations),
    availableArtifact(outputDir, rootPath, "transcripts", `${videoId}.json`, operations),
    availableArtifact(outputDir, rootPath, "transcripts", `${videoId}.md`, operations),
    availableArtifact(outputDir, rootPath, "transcripts", `${videoId}.txt`, operations),
  ]);
  const [digest, email, transcriptJson, transcriptMarkdown, transcriptText] = artifacts;

  const entry: LibraryEntry = {
    channel: metadata.channel,
    paths: {
      digestPath: digest?.path ?? null,
      emailPreviewPath: email?.path ?? null,
      metadataPath,
      transcriptJsonPath: transcriptJson?.path ?? null,
      transcriptMarkdownPath: transcriptMarkdown?.path ?? null,
      transcriptTextPath: transcriptText?.path ?? null,
    },
    title: metadata.title,
    updatedAt: metadata.processedAt,
    videoId,
  };
  entryOpenTargets.set(entry, new Map(
    artifacts
      .filter((artifact): artifact is AvailableArtifact => artifact !== null)
      .map((artifact) => [artifact.path, artifact.target]),
  ));
  return entry;
}

async function availableArtifact(
  outputDir: string,
  rootPath: string,
  directory: "digests" | "emails" | "transcripts",
  file: string,
  operations: LibraryFileOperations,
): Promise<AvailableArtifact | null> {
  const path = join(outputDir, directory, file);
  const parentPath = dirname(path);
  const parentIdentity = await captureDirectoryIfPresent(parentPath, rootPath, operations);
  if (!parentIdentity) return null;
  const fileIdentity = await captureFileIfPresent(path, rootPath, operations);
  if (!fileIdentity) return null;

  // Revalidate immediately before exposing a path gathered from the filesystem.
  await assertDirectoryIdentity(parentPath, rootPath, parentIdentity, operations);
  await assertFileIdentity(path, rootPath, fileIdentity, operations);
  return {
    path,
    target: { fileIdentity, parentIdentity, parentPath, path, rootPath },
  };
}

async function captureDirectoryIfPresent(
  path: string,
  rootPath: string,
  operations: LibraryFileOperations,
): Promise<FileIdentity | null> {
  const stats = await lstatIfPresent(path, operations);
  if (!stats) return null;
  if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
  if (!isWithin(rootPath, await operations.realpath(path))) return null;
  return identityOf(stats);
}

async function captureFileIfPresent(
  path: string,
  rootPath: string,
  operations: LibraryFileOperations,
): Promise<FileIdentity | null> {
  const stats = await lstatIfPresent(path, operations);
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink()) return null;
  if (!isWithin(rootPath, await operations.realpath(dirname(path)))) return null;
  if (!isWithin(rootPath, await operations.realpath(path))) return null;
  return identityOf(stats);
}

async function assertDirectoryIdentity(
  path: string,
  rootPath: string,
  expected: FileIdentity,
  operations: LibraryFileOperations,
): Promise<void> {
  const stats = await operations.lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(stats, expected)) {
    throw changedDuringValidation(path);
  }
  if (!isWithin(rootPath, await operations.realpath(path))) throw changedDuringValidation(path);
}

async function assertFileIdentity(
  path: string,
  rootPath: string,
  expected: FileIdentity,
  operations: LibraryFileOperations,
): Promise<void> {
  const stats = await operations.lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || !sameIdentity(stats, expected)) {
    throw changedDuringValidation(path);
  }
  if (!isWithin(rootPath, await operations.realpath(dirname(path)))) throw changedDuringValidation(path);
  if (!isWithin(rootPath, await operations.realpath(path))) throw changedDuringValidation(path);
}

async function inspectOpenFile<T>(
  path: string,
  expected: FileIdentity,
  operations: LibraryFileOperations,
  inspect: (handle: LibraryFileHandle) => Promise<T>,
): Promise<T> {
  let handle: LibraryFileHandle;
  try {
    handle = await operations.open(path, OPEN_READ_ONLY_NO_FOLLOW);
  } catch (error) {
    if (isSymlinkRaceError(error)) throw changedDuringValidation(path);
    throw error;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile() || !sameIdentity(stats, expected)) throw changedDuringValidation(path);
    return await inspect(handle);
  } finally {
    await handle.close();
  }
}

async function lstatIfPresent(path: string, operations: LibraryFileOperations): Promise<FileStats | null> {
  try {
    return await operations.lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function realpathIfPresent(path: string, operations: LibraryFileOperations): Promise<string | null> {
  try {
    return await operations.realpath(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function parseMetadata(value: unknown, expectedVideoId: string): LibraryMetadata | null {
  if (!isRecord(value) || value.metadataSchemaVersion !== "metadata.v0") return null;
  if (typeof value.processedAt !== "string" || !isIsoTimestamp(value.processedAt)) return null;
  if (!isRecord(value.video) || value.video.videoId !== expectedVideoId) return null;
  if (value.video.canonicalUrl !== `https://www.youtube.com/watch?v=${expectedVideoId}`) return null;

  const channel = nullableString(value.video.channel);
  const title = nullableString(value.video.videoTitle);
  if (channel === undefined || title === undefined) return null;
  return { channel, processedAt: value.processedAt, title };
}

function preferredOpenPath(entry: LibraryEntry): string | null {
  return entry.paths.digestPath ?? entry.paths.transcriptMarkdownPath;
}

function identityOf(stats: FileIdentity): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(actual: FileIdentity, expected: FileIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function changedDuringValidation(path: string): LibraryIntegrityError {
  return new LibraryIntegrityError(`Artifact path changed during validation: ${path}`);
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function isIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return isNodeError(error) && error.code === "ENOENT";
}

function isSymlinkRaceError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ELOOP";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
