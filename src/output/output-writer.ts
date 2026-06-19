import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
};

const defaultFileOperations: OutputFileOperations = {
  rename,
  unlink,
  writeFile,
};

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
  fileOperations: OutputFileOperations = defaultFileOperations,
): Promise<IngestionOutputPaths> {
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

  await writeFilesAtomically(entries, fileOperations);

  return paths;
}

export async function writeTranscriptOnlyOutputs(
  input: TranscriptOnlyOutputInput,
  fileOperations: OutputFileOperations = defaultFileOperations,
): Promise<TranscriptOnlyOutputPaths> {
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

  await writeFilesAtomically(
    [
      { contents: `${JSON.stringify(input.transcript, null, 2)}\n`, path: paths.transcriptJsonPath },
      { contents: renderTranscriptMarkdown(input), path: paths.transcriptMarkdownPath },
      { contents: renderTranscriptText(input.transcript), path: paths.transcriptTextPath },
      {
        contents: `${JSON.stringify(buildTranscriptOnlyMetadata(input), null, 2)}\n`,
        path: paths.metadataPath,
      },
    ],
    fileOperations,
  );

  return paths;
}

export async function writeFailedIngestionMetadata(
  input: FailedIngestionMetadataInput,
  fileOperations: OutputFileOperations = defaultFileOperations,
): Promise<string> {
  const metadataPath = join(input.outputDir, "metadata", `${input.video.videoId}.json`);

  await mkdir(join(input.outputDir, "metadata"), { recursive: true });
  await writeFilesAtomically(
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

async function writeFilesAtomically(
  entries: Array<{ contents: string; path: string }>,
  fileOperations: OutputFileOperations,
): Promise<void> {
  const temporaryEntries = entries.map((entry) => ({
    ...entry,
    temporaryPath: `${entry.path}.${randomUUID()}.tmp`,
  }));

  try {
    const writeResults = await Promise.allSettled(
      temporaryEntries.map((entry) => fileOperations.writeFile(entry.temporaryPath, entry.contents)),
    );
    const failedWrite = writeResults.find((result) => result.status === "rejected");
    if (failedWrite?.status === "rejected") {
      throw failedWrite.reason;
    }

    for (const entry of temporaryEntries) {
      await fileOperations.rename(entry.temporaryPath, entry.path);
    }
  } catch (error) {
    await Promise.all(
      temporaryEntries.map((entry) =>
        fileOperations.unlink(entry.temporaryPath).catch(() => undefined),
      ),
    );
    throw error;
  }
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
