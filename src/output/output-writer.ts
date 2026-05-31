import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Digest } from "../digest/digest";
import type { Transcript } from "../transcript/transcript-source";
import type { TranscriptQuality } from "../transcript/transcript-quality";
import type { YouTubeVideo } from "../video/youtube-url";

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
  transcriptPath: string;
};

export async function writeIngestionOutputs(
  input: IngestionOutputInput,
): Promise<IngestionOutputPaths> {
  const paths = outputPaths(input.outputDir, input.video.videoId, input.emailPreview);

  await Promise.all([
    mkdir(join(input.outputDir, "digests"), { recursive: true }),
    mkdir(join(input.outputDir, "metadata"), { recursive: true }),
    mkdir(join(input.outputDir, "transcripts"), { recursive: true }),
    input.emailPreview ? mkdir(join(input.outputDir, "emails"), { recursive: true }) : undefined,
  ]);

  await writeFile(paths.transcriptPath, `${JSON.stringify(input.transcript, null, 2)}\n`);
  await writeFile(paths.metadataPath, `${JSON.stringify(buildMetadata(input), null, 2)}\n`);
  await writeFile(paths.digestPath, renderDigestMarkdown(input));

  if (paths.emailPreviewPath) {
    await writeFile(paths.emailPreviewPath, renderEmailPreview(input));
  }

  return paths;
}

function outputPaths(outputDir: string, videoId: string, emailPreview: boolean): IngestionOutputPaths {
  return {
    digestPath: join(outputDir, "digests", `${videoId}.md`),
    emailPreviewPath: emailPreview ? join(outputDir, "emails", `${videoId}.md`) : null,
    metadataPath: join(outputDir, "metadata", `${videoId}.json`),
    transcriptPath: join(outputDir, "transcripts", `${videoId}.json`),
  };
}

function buildMetadata(input: IngestionOutputInput) {
  return {
    digest: input.digest,
    metadataSchemaVersion: "metadata.v0",
    processedAt: new Date().toISOString(),
    transcriptQuality: input.transcriptQuality,
    video: {
      canonicalUrl: input.video.canonicalUrl,
      channel: null,
      durationSeconds: input.transcriptQuality.durationSeconds,
      videoId: input.video.videoId,
      videoTitle: null,
    },
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
