import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

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

export type ResolvedLibraryEntry = {
  item: LibraryEntry;
  ok: true;
  openPath: string;
};

export type UnresolvedLibraryEntry = {
  message: string;
  ok: false;
};

type LibraryMetadata = {
  channel: string | null;
  processedAt: string;
  title: string | null;
  videoId: string;
};

export async function listLibraryEntries(outputDir: string): Promise<LibraryEntry[]> {
  const rootPath = await safeRealpath(outputDir);
  if (!rootPath) return [];

  const metadataDir = join(outputDir, "metadata");
  if (!await isSafeDirectory(metadataDir, rootPath)) return [];

  let files: string[];
  try {
    files = await readdir(metadataDir);
  } catch {
    return [];
  }

  const candidates = await Promise.all(
    files
      .filter((file) => extname(file) === ".json" && VIDEO_ID_PATTERN.test(basename(file, ".json")))
      .map((file) => readLibraryEntry(outputDir, rootPath, file)),
  );

  return candidates
    .filter((entry): entry is LibraryEntry => entry !== null)
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.videoId.localeCompare(right.videoId));
}

export async function resolveLibraryEntry(
  outputDir: string,
  target: string,
): Promise<ResolvedLibraryEntry | UnresolvedLibraryEntry> {
  const items = await listLibraryEntries(outputDir);
  const item = target === "latest"
    ? items[0]
    : items.find((candidate) => candidate.videoId === target);
  if (!item) {
    return {
      message: target === "latest"
        ? "No Library Entries found."
        : `No Library Entry found for video ${target}.`,
      ok: false,
    };
  }

  const openPath = preferredOpenPath(item);
  if (!openPath) {
    return { message: `Library Entry ${target} has no readable artifact.`, ok: false };
  }

  return { item, ok: true, openPath };
}

async function readLibraryEntry(
  outputDir: string,
  rootPath: string,
  metadataFile: string,
): Promise<LibraryEntry | null> {
  const videoId = basename(metadataFile, ".json");
  const metadataPath = join(outputDir, "metadata", metadataFile);

  try {
    if (!await isSafeFile(metadataPath, rootPath)) return null;
    const metadata = parseMetadata(JSON.parse(await readFile(metadataPath, "utf8")), videoId);
    if (!metadata) return null;

    const paths = {
      digestPath: await availableArtifact(outputDir, rootPath, "digests", `${videoId}.md`),
      emailPreviewPath: await availableArtifact(outputDir, rootPath, "emails", `${videoId}.md`),
      metadataPath,
      transcriptJsonPath: await availableArtifact(outputDir, rootPath, "transcripts", `${videoId}.json`),
      transcriptMarkdownPath: await availableArtifact(outputDir, rootPath, "transcripts", `${videoId}.md`),
      transcriptTextPath: await availableArtifact(outputDir, rootPath, "transcripts", `${videoId}.txt`),
    } satisfies LibraryEntryPaths;

    return {
      channel: metadata.channel,
      paths,
      title: metadata.title,
      updatedAt: metadata.processedAt,
      videoId,
    };
  } catch {
    return null;
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

  return {
    channel,
    processedAt: value.processedAt,
    title,
    videoId: expectedVideoId,
  };
}

async function availableArtifact(
  outputDir: string,
  rootPath: string,
  directory: "digests" | "emails" | "transcripts",
  file: string,
): Promise<string | null> {
  const path = join(outputDir, directory, file);
  return await isSafeFile(path, rootPath) ? path : null;
}

async function isSafeDirectory(path: string, rootPath: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    return isWithin(rootPath, await realpath(path));
  } catch {
    return false;
  }
}

async function isSafeFile(path: string, rootPath: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    const actualPath = await realpath(path);
    const actualParent = await realpath(dirname(path));
    return isWithin(rootPath, actualPath) && isWithin(rootPath, actualParent);
  } catch {
    return false;
  }
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/"));
}

async function safeRealpath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

function preferredOpenPath(entry: LibraryEntry): string | null {
  return entry.paths.digestPath ?? entry.paths.transcriptMarkdownPath;
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
