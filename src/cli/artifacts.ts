import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type ArtifactEntry = {
  digestPath: string;
  digestTitle: string | null;
  metadataPath: string | null;
  updatedAt: string;
  videoId: string;
};

export async function listArtifacts(outputDir: string): Promise<ArtifactEntry[]> {
  const digestDir = join(outputDir, "digests");
  let files: string[];

  try {
    files = await readdir(digestDir);
  } catch {
    return [];
  }

  const entries = await Promise.all(
    files
      .filter((file) => file.endsWith(".md"))
      .map(async (file): Promise<ArtifactEntry> => {
        const videoId = file.replace(/\.md$/, "");
        const digestPath = join(digestDir, file);
        const metadataPath = join(outputDir, "metadata", `${videoId}.json`);
        const digestStat = await stat(digestPath);
        const metadata = await readMetadata(metadataPath);

        return {
          digestPath,
          digestTitle: metadata.digestTitle,
          metadataPath: metadata.exists ? metadataPath : null,
          updatedAt: digestStat.mtime.toISOString(),
          videoId,
        };
      }),
  );

  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function resolveOpenTarget(
  outputDir: string,
  target: string,
): Promise<{ item: ArtifactEntry; ok: true } | { message: string; ok: false }> {
  const items = await listArtifacts(outputDir);
  const item = target === "latest"
    ? items[0]
    : items.find((candidate) => candidate.videoId === target);

  if (!item) {
    return {
      message: target === "latest" ? "No digests found." : `No digest found for video ${target}.`,
      ok: false,
    };
  }

  return {
    item,
    ok: true,
  };
}

async function readMetadata(path: string): Promise<{ digestTitle: string | null; exists: boolean }> {
  try {
    const metadata = JSON.parse(await readFile(path, "utf8")) as {
      digest?: { digestTitle?: unknown };
    };
    return {
      digestTitle: typeof metadata.digest?.digestTitle === "string" ? metadata.digest.digestTitle : null,
      exists: true,
    };
  } catch {
    return {
      digestTitle: null,
      exists: false,
    };
  }
}
