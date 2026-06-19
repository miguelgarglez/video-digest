import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Digest } from "../digest/digest";
import type { Transcript } from "../transcript/transcript-source";
import type { TranscriptQuality } from "../transcript/transcript-quality";
import type { YouTubeVideo } from "../video/youtube-url";
import { renderTranscriptMarkdown, renderTranscriptText } from "./transcript-renderer";

export type IngestionOutputInput = {
  digest: Digest;
  emailPreview: boolean;
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
  pathExists(path: string): Promise<boolean>;
  readDirectory(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
};

const defaultFileOperations: OutputFileOperations = {
  pathExists: async (path) => {
    try {
      await access(path);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  },
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
  transcriptQuality: TranscriptQuality;
  video: YouTubeVideo;
};

export async function writeIngestionOutputs(
  input: IngestionOutputInput,
  fileOperations: Partial<OutputFileOperations> = {},
): Promise<IngestionOutputPaths> {
  await recoverPendingOutputTransactions(input.outputDir, fileOperations);
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
  await recoverPendingOutputTransactions(input.outputDir, fileOperations);
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
    [],
    fileOperations,
  );

  return paths;
}

export async function writeFailedIngestionMetadata(
  input: FailedIngestionMetadataInput,
  fileOperations: Partial<OutputFileOperations> = {},
): Promise<string> {
  await recoverPendingOutputTransactions(input.outputDir, fileOperations);
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
            video: buildVideoMetadata(input.video, input.transcriptQuality),
          },
          null,
          2,
        )}\n`,
        path: metadataPath,
      },
    ],
    [],
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
    video: buildVideoMetadata(input.video, input.transcriptQuality),
  };
}

function buildVideoMetadata(video: YouTubeVideo, transcriptQuality: TranscriptQuality) {
  return {
    canonicalUrl: video.canonicalUrl,
    channel: null,
    durationSeconds: transcriptQuality.durationSeconds,
    videoId: video.videoId,
    videoTitle: null,
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
  token: string;
  videoId: string;
};

export async function recoverPendingOutputTransactions(
  outputDir: string,
  operationOverrides: Partial<OutputFileOperations> = {},
): Promise<void> {
  const fileOperations = { ...defaultFileOperations, ...operationOverrides };
  const transactionDir = join(outputDir, ".transactions");
  let manifestNames: string[];

  try {
    manifestNames = (await fileOperations.readDirectory(transactionDir))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }

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

  for (const { manifest, manifestPath } of manifests) {
    const recoveryFailures: string[] = [];
    let recoveryFailed = false;
    for (const artifact of manifest.artifacts) {
      try {
        if (artifact.hadOriginal) {
          if (await fileOperations.pathExists(artifact.backupPath)) {
            await unlinkIfPresent(artifact.targetPath, fileOperations);
            await fileOperations.rename(artifact.backupPath, artifact.targetPath);
          }
        } else {
          await unlinkIfPresent(artifact.targetPath, fileOperations);
        }
      } catch (error) {
        recoveryFailed = true;
        const preserved = await fileOperations.pathExists(artifact.backupPath)
          ? [artifact.backupPath]
          : [];
        recoveryFailures.push(...preserved);
      } finally {
        await unlinkIfPresent(artifact.tempPath, fileOperations);
      }
    }
    if (recoveryFailed) {
      throw new OutputRecoveryError(recoveryFailures, new Error("Output recovery incomplete"));
    }
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
  let manifestPublished = false;

  try {
    const writeResults = await Promise.allSettled(
      temporaryEntries.map((entry) => fileOperations.writeFile(entry.temporaryPath, entry.contents)),
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
      token: operationId,
      videoId,
    };
    await mkdir(transactionDir, { recursive: true });
    await fileOperations.writeFile(manifestTempPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await fileOperations.rename(manifestTempPath, manifestPath);
    manifestPublished = true;

    for (const artifact of manifest.artifacts) {
      if (!artifact.hadOriginal) continue;
      await fileOperations.rename(artifact.targetPath, artifact.backupPath);
      backups.push({ backupPath: artifact.backupPath, path: artifact.targetPath });
    }

    for (const entry of temporaryEntries) {
      await fileOperations.rename(entry.temporaryPath, entry.path);
    }

    const cleanupResults = await Promise.allSettled(
      backups.map(({ backupPath }) => fileOperations.unlink(backupPath)),
    );
    const preservedBackupPaths = backups
      .filter((_, index) => cleanupResults[index]?.status === "rejected")
      .map(({ backupPath }) => backupPath);
    if (preservedBackupPaths.length > 0) {
      throw new OutputRecoveryError(preservedBackupPaths, cleanupResults);
    }
    await Promise.allSettled(
      temporaryEntries.map((entry) => fileOperations.unlink(entry.temporaryPath)),
    );
    await fileOperations.unlink(manifestPath);
  } catch (error) {
    if (error instanceof OutputRecoveryError) throw error;

    if (manifestPublished) {
      try {
        await recoverPendingOutputTransactions(outputDir, fileOperations);
      } catch (recoveryError) {
        throw recoveryError;
      }
      throw error;
    }

    await Promise.allSettled(
      [
        ...temporaryEntries.map((entry) => fileOperations.unlink(entry.temporaryPath)),
        fileOperations.unlink(manifestTempPath),
      ],
    );
    throw error;
  }
}

function validateManifest(
  value: unknown,
  outputDir: string,
  manifestName: string,
): OutputTransactionManifest {
  if (!isRecord(value)
    || !hasExactKeys(value, ["artifacts", "schemaVersion", "token", "videoId"])
    || value.schemaVersion !== "output-transaction.v0"
    || typeof value.token !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.token)
    || manifestName !== `${value.token}.json`
    || typeof value.videoId !== "string"
    || value.videoId.length === 0
    || !Array.isArray(value.artifacts)
    || value.artifacts.length === 0
  ) {
    throw new Error("Unexpected output transaction manifest schema");
  }

  const seenTargets = new Set<string>();
  const artifacts = value.artifacts.map((artifact) => {
    if (!isRecord(artifact)
      || !hasExactKeys(artifact, ["backupPath", "hadOriginal", "targetPath", "tempPath"])
      || typeof artifact.backupPath !== "string"
      || typeof artifact.hadOriginal !== "boolean"
      || typeof artifact.targetPath !== "string"
      || typeof artifact.tempPath !== "string"
      || !isOwnedTargetPath(outputDir, artifact.targetPath)
      || artifact.backupPath !== `${artifact.targetPath}.${value.token}.backup`
      || artifact.tempPath !== `${artifact.targetPath}.${value.token}.tmp`
      || seenTargets.has(artifact.targetPath)
    ) {
      throw new Error("Unsafe output transaction artifact path");
    }
    seenTargets.add(artifact.targetPath);
    return artifact as OutputTransactionArtifact;
  });

  return { ...value, artifacts } as OutputTransactionManifest;
}

function isOwnedTargetPath(outputDir: string, targetPath: string): boolean {
  const relativePath = relative(resolve(outputDir), resolve(targetPath));
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return false;
  return ["digests", "emails", "metadata", "transcripts"].includes(relativePath.split(/[\\/]/)[0]!);
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
    video: buildVideoMetadata(input.video, input.transcriptQuality),
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
