import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import type { PublicCliErrorCode } from "./public-contract";

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
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
};

const defaultFileOperations: LibraryFileOperations = {
  lstat,
  open: (path, flags) => open(path, flags) as Promise<FileHandle & LibraryFileHandle>,
  readdir,
  readlink,
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

export type LibraryRootIdentity = {
  canonicalIdentity: FileIdentity;
  canonicalPath: string;
  lexicalIdentity: FileIdentity & {
    kind: "directory" | "symlink";
    linkTarget: string | null;
  };
  path: string;
};

export type LibraryOpenTarget = {
  fileIdentity: FileIdentity;
  parentIdentity: FileIdentity;
  parentPath: string;
  path: string;
  root: LibraryRootIdentity;
};

export type LibraryArtifactPreference = "digest" | "transcript";

export type ResolvedLibraryArtifact = Readonly<{
  item: LibraryEntry;
  openPath: string;
  openTarget: LibraryOpenTarget;
}>;

export type ResolvedLibraryEntry = {
  item: LibraryEntry;
  ok: true;
  openPath: string;
  openTarget: LibraryOpenTarget;
};

export type LibraryEntryErrorCode = Extract<PublicCliErrorCode,
  "library-entry-not-found" | "library-entry-not-openable">;

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
  const root = await captureLibraryRoot(outputDir, operations);
  if (!root) return [];
  await assertLibraryRootIdentity(root, operations);

  const metadataDir = join(outputDir, "metadata");
  const metadataParent = await captureDirectoryIfPresent(metadataDir, root, operations);
  if (!metadataParent) return [];
  await assertLibraryRootIdentity(root, operations);

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
      .map((file) => readLibraryEntry(outputDir, root, metadataParent, file, operations)),
  );

  const entries = candidates
    .filter((entry): entry is LibraryEntry => entry !== null)
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.videoId.localeCompare(right.videoId));
  await assertLibraryRootIdentity(root, operations);
  return entries;
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
 * Resolves an identifier to a validated artifact gathered from canonical Library
 * metadata. Callers must hold the Artifact Library recovery lock for the entire
 * resolution and subsequent read/open/reveal operation.
 */
export async function resolveLibraryArtifact(
  outputDir: string,
  videoId: string,
  preference: LibraryArtifactPreference,
  fileOperations: Partial<LibraryFileOperations> = {},
): Promise<ResolvedLibraryArtifact> {
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    throw new LibraryIntegrityError("Library target has an invalid Video ID.");
  }
  const item = (await listLibraryEntries(outputDir, fileOperations))
    .find((candidate) => candidate.videoId === videoId);
  if (!item) throw new LibraryIntegrityError(`Library Entry ${videoId} was not found.`);

  const openPath = preference === "transcript"
    ? item.paths.transcriptMarkdownPath ?? item.paths.digestPath
    : item.paths.digestPath ?? item.paths.transcriptMarkdownPath;
  const openTarget = openPath ? entryOpenTargets.get(item)?.get(openPath) : undefined;
  if (!openPath || !openTarget) {
    throw new LibraryIntegrityError(`Library Entry ${videoId} has no readable human artifact.`);
  }
  return { item, openPath, openTarget };
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
  await assertDirectoryIdentity(target.parentPath, target.root, target.parentIdentity, operations);
  await assertFileIdentity(target.path, target.root, target.fileIdentity, operations);
  await inspectOpenFile(target.path, target.fileIdentity, operations, async () => undefined);
  await assertLibraryRootIdentity(target.root, operations);
}

/** Reads the already-resolved inode through O_NOFOLLOW after full identity checks. */
export async function readLibraryOpenTarget(
  target: LibraryOpenTarget,
  fileOperations: Partial<LibraryFileOperations> = {},
): Promise<string> {
  const operations = { ...defaultFileOperations, ...fileOperations };
  await assertDirectoryIdentity(target.parentPath, target.root, target.parentIdentity, operations);
  await assertFileIdentity(target.path, target.root, target.fileIdentity, operations);
  await assertLibraryRootIdentity(target.root, operations);
  const contents = await inspectOpenFile(
    target.path,
    target.fileIdentity,
    operations,
    (handle) => handle.readFile({ encoding: "utf8" }),
  );
  await assertLibraryRootIdentity(target.root, operations);
  return contents;
}

async function readLibraryEntry(
  outputDir: string,
  root: LibraryRootIdentity,
  metadataParent: LibraryOpenTarget["parentIdentity"],
  metadataFile: string,
  operations: LibraryFileOperations,
): Promise<LibraryEntry | null> {
  const videoId = basename(metadataFile, ".json");
  const metadataPath = join(outputDir, "metadata", metadataFile);
  const metadataIdentity = await captureFileIfPresent(metadataPath, root, operations);
  if (!metadataIdentity) return null;

  await assertDirectoryIdentity(dirname(metadataPath), root, metadataParent, operations);
  await assertLibraryRootIdentity(root, operations);
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
    availableArtifact(outputDir, root, "digests", `${videoId}.md`, operations),
    availableArtifact(outputDir, root, "emails", `${videoId}.md`, operations),
    availableArtifact(outputDir, root, "transcripts", `${videoId}.json`, operations),
    availableArtifact(outputDir, root, "transcripts", `${videoId}.md`, operations),
    availableArtifact(outputDir, root, "transcripts", `${videoId}.txt`, operations),
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
  await assertLibraryRootIdentity(root, operations);
  return entry;
}

async function availableArtifact(
  outputDir: string,
  root: LibraryRootIdentity,
  directory: "digests" | "emails" | "transcripts",
  file: string,
  operations: LibraryFileOperations,
): Promise<AvailableArtifact | null> {
  const path = join(outputDir, directory, file);
  const parentPath = dirname(path);
  const parentIdentity = await captureDirectoryIfPresent(parentPath, root, operations);
  if (!parentIdentity) return null;
  const fileIdentity = await captureFileIfPresent(path, root, operations);
  if (!fileIdentity) return null;

  // Revalidate immediately before exposing a path gathered from the filesystem.
  await assertDirectoryIdentity(parentPath, root, parentIdentity, operations);
  await assertFileIdentity(path, root, fileIdentity, operations);
  await assertLibraryRootIdentity(root, operations);
  return {
    path,
    target: { fileIdentity, parentIdentity, parentPath, path, root },
  };
}

async function captureDirectoryIfPresent(
  path: string,
  root: LibraryRootIdentity,
  operations: LibraryFileOperations,
): Promise<FileIdentity | null> {
  const stats = await lstatIfPresent(path, operations);
  if (!stats) return null;
  if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
  if (!isWithin(root.canonicalPath, await operations.realpath(path))) return null;
  return identityOf(stats);
}

async function captureFileIfPresent(
  path: string,
  root: LibraryRootIdentity,
  operations: LibraryFileOperations,
): Promise<FileIdentity | null> {
  const stats = await lstatIfPresent(path, operations);
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink()) return null;
  if (!isWithin(root.canonicalPath, await operations.realpath(dirname(path)))) return null;
  if (!isWithin(root.canonicalPath, await operations.realpath(path))) return null;
  return identityOf(stats);
}

async function assertDirectoryIdentity(
  path: string,
  root: LibraryRootIdentity,
  expected: FileIdentity,
  operations: LibraryFileOperations,
): Promise<void> {
  const stats = await operations.lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(stats, expected)) {
    throw changedDuringValidation(path);
  }
  if (!isWithin(root.canonicalPath, await operations.realpath(path))) throw changedDuringValidation(path);
}

async function assertFileIdentity(
  path: string,
  root: LibraryRootIdentity,
  expected: FileIdentity,
  operations: LibraryFileOperations,
): Promise<void> {
  const stats = await operations.lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || !sameIdentity(stats, expected)) {
    throw changedDuringValidation(path);
  }
  if (!isWithin(root.canonicalPath, await operations.realpath(dirname(path)))) throw changedDuringValidation(path);
  if (!isWithin(root.canonicalPath, await operations.realpath(path))) throw changedDuringValidation(path);
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

async function captureLibraryRoot(
  path: string,
  operations: LibraryFileOperations,
): Promise<LibraryRootIdentity | null> {
  const stats = await lstatIfPresent(path, operations);
  if (!stats) return null;
  const isDirectory = stats.isDirectory() && !stats.isSymbolicLink();
  const isSymlink = stats.isSymbolicLink();
  if (!isDirectory && !isSymlink) {
    throw new LibraryIntegrityError(`Artifact Library root must be a directory or a symlink to one: ${path}`);
  }
  const linkTarget = isSymlink ? await operations.readlink(path) : null;
  const canonicalPath = await operations.realpath(path);
  const canonicalStats = await operations.lstat(canonicalPath);
  if (!canonicalStats.isDirectory() || canonicalStats.isSymbolicLink()) {
    throw new LibraryIntegrityError(`Artifact Library root must resolve to a non-symlink directory: ${path}`);
  }
  if (isDirectory && !sameIdentity(stats, canonicalStats)) throw changedDuringValidation(path);
  return {
    canonicalIdentity: identityOf(canonicalStats),
    canonicalPath,
    lexicalIdentity: {
      ...identityOf(stats),
      kind: isSymlink ? "symlink" : "directory",
      linkTarget,
    },
    path,
  };
}

async function assertLibraryRootIdentity(
  root: LibraryRootIdentity,
  operations: LibraryFileOperations,
): Promise<void> {
  let stats: FileStats;
  let canonicalStats: FileStats;
  let canonicalPath: string;
  try {
    stats = await operations.lstat(root.path);
    canonicalPath = await operations.realpath(root.path);
  } catch (error) {
    if (isMissingPathError(error) || isSymlinkRaceError(error)) {
      throw changedDuringValidation(root.path);
    }
    throw error;
  }

  const lexicalKindMatches = root.lexicalIdentity.kind === "symlink"
    ? stats.isSymbolicLink()
    : stats.isDirectory() && !stats.isSymbolicLink();
  let linkTargetMatches = true;
  if (root.lexicalIdentity.kind === "symlink") {
    try {
      linkTargetMatches = await operations.readlink(root.path) === root.lexicalIdentity.linkTarget;
    } catch (error) {
      if (isMissingPathError(error) || isNotSymlinkError(error)) throw changedDuringValidation(root.path);
      throw error;
    }
  }
  try {
    // Keep the canonical target identity check last: subsequent code is
    // synchronous until the caller's protected operation.
    canonicalStats = await operations.lstat(root.canonicalPath);
  } catch (error) {
    if (isMissingPathError(error)) throw changedDuringValidation(root.path);
    throw error;
  }

  if (
    !lexicalKindMatches
    || !sameIdentity(stats, root.lexicalIdentity)
    || !linkTargetMatches
    || canonicalPath !== root.canonicalPath
    || !canonicalStats.isDirectory()
    || canonicalStats.isSymbolicLink()
    || !sameIdentity(canonicalStats, root.canonicalIdentity)
  ) {
    throw changedDuringValidation(root.path);
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

function isNotSymlinkError(error: unknown): boolean {
  return isNodeError(error) && error.code === "EINVAL";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
