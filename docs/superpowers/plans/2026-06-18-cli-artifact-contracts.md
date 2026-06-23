# CLI Artifact Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce durable multi-format Transcripts, one Library Entry per Video, and explicit copy/open/stdout command contracts.

**Architecture:** Treat JSON Transcript data as canonical and derive Markdown and clean text through pure renderers. Build Library Entries from metadata, enrich Video metadata through a best-effort port, and keep clipboard/opener behavior behind injected adapters.

**Tech Stack:** Bun, TypeScript, Bun test, YouTube oEmbed, macOS `pbcopy` and `open`.

---

### Task 1: Transcript renderers and output paths

**Files:**
- Create: `src/output/transcript-renderer.ts`
- Create: `src/output/transcript-renderer.test.ts`
- Modify: `src/output/output-writer.ts`
- Modify: `src/output/output-writer.test.ts`
- Modify: `src/ingestion/transcript-only.ts`
- Modify: `src/ingestion/transcript-only.test.ts`

- [x] **Step 1: Write failing renderer tests**

```ts
test("renders clean text without timestamps", () => {
  expect(renderTranscriptText(transcript)).toBe("First sentence. Second sentence.\n");
});

test("renders readable markdown with provenance", () => {
  expect(renderTranscriptMarkdown({ transcript, video })).toContain("## Transcript\n\n**00:00** First sentence.");
});
```

- [x] **Step 2: Verify the tests fail**

Run: `bun test src/output/transcript-renderer.test.ts src/output/output-writer.test.ts`  
Expected: FAIL because the renderer and new paths do not exist.

- [x] **Step 3: Implement pure renderers and write three representations**

```ts
export function renderTranscriptText(transcript: Transcript): string {
  const paragraphs: string[] = [];
  let current = "";
  for (const segment of transcript.segments) {
    const text = segment.text.trim();
    if (!text) continue;
    current = current ? `${current} ${text}` : text;
    if (current.length >= 600 && /[.!?]$/.test(text)) {
      paragraphs.push(current);
      current = "";
    }
  }
  if (current) paragraphs.push(current);
  return `${paragraphs.join("\n\n")}\n`;
}

export function renderTranscriptMarkdown(input: { metadata: VideoMetadata; transcript: Transcript; video: YouTubeVideo }): string {
  return [
    `# ${input.metadata.title ?? `Transcript ${input.video.videoId}`}`, "", `URL: ${input.video.canonicalUrl}`,
    `Language: ${input.transcript.language ?? "unknown"}`, "", "## Transcript", "",
    ...input.transcript.segments.map((segment) => `**${formatTimestamp(segment.start)}** ${segment.text}`), "",
  ].join("\n");
}
```

Extend output result types with `transcriptJsonPath`, `transcriptMarkdownPath`, and
`transcriptTextPath`; write all files through temporary siblings followed by rename so
an interrupted replacement preserves the prior Library Entry.

- [x] **Step 4: Run output and ingestion tests**

Run: `bun test src/output src/ingestion/transcript-only.test.ts src/ingestion/ingest-video.test.ts && bun run typecheck`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/output src/ingestion/transcript-only.ts src/ingestion/transcript-only.test.ts src/ingestion/ingest-video.test.ts
git commit -m "feat(output): add transcript representations"
```

### Task 2: Best-effort Video metadata enrichment

**Files:**
- Create: `src/video/video-metadata-source.ts`
- Create: `src/video/youtube-oembed-metadata-source.ts`
- Create: `src/video/youtube-oembed-metadata-source.test.ts`
- Modify: `src/ingestion/ingest-video.ts`
- Modify: `src/ingestion/ingest-video.test.ts`
- Modify: `src/ingestion/transcript-only.ts`
- Modify: `src/ingestion/transcript-only.test.ts`
- Modify: `src/output/output-writer.ts`

- [x] **Step 1: Write failing oEmbed success and fallback tests**

```ts
test("maps public oEmbed metadata", async () => {
  const source = new YouTubeOEmbedMetadataSource(async () => new Response(JSON.stringify({ title: "A title", author_name: "A channel" })));
  expect(await source.fetch(video)).toEqual({ channel: "A channel", title: "A title" });
});

test("ingestion continues when metadata lookup fails", async () => {
  const result = await fetchTranscriptOnly(input({ metadataSource: { fetch: async () => { throw new Error("offline"); } } }));
  expect(result.exitCode).toBe(0);
});
```

- [x] **Step 2: Verify the tests fail**

Run: `bun test src/video/youtube-oembed-metadata-source.test.ts src/ingestion/transcript-only.test.ts`  
Expected: FAIL because the metadata port is missing.

- [x] **Step 3: Implement the optional port**

```ts
export type VideoMetadata = { channel: string | null; title: string | null };
export interface VideoMetadataSource { fetch(video: YouTubeVideo): Promise<VideoMetadata>; }

export class YouTubeOEmbedMetadataSource implements VideoMetadataSource {
  constructor(private readonly request: typeof fetch = fetch) {}
  async fetch(video: YouTubeVideo): Promise<VideoMetadata> {
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.search = new URLSearchParams({ format: "json", url: video.canonicalUrl }).toString();
    const response = await this.request(endpoint);
    if (!response.ok) throw new Error(`YouTube oEmbed failed with HTTP ${response.status}`);
    const payload = await response.json() as Record<string, unknown>;
    return { channel: typeof payload.author_name === "string" ? payload.author_name : null, title: typeof payload.title === "string" ? payload.title : null };
  }
}
```

Catch enrichment failure at the application-service boundary, persist null metadata,
and never change the Transcript exit code.

- [x] **Step 4: Run Video and Ingestion tests**

Run: `bun test src/video src/ingestion src/output/output-writer.test.ts && bun run typecheck`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/video src/ingestion src/output/output-writer.ts src/output/output-writer.test.ts
git commit -m "feat(video): enrich public metadata"
```

### Task 3: Library Entries replace digest-only discovery

**Files:**
- Rewrite: `src/cli/artifacts.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/main.test.ts`
- Create: `src/cli/library.test.ts`

- [x] **Step 1: Write a failing transcript-only Library Entry test**

```ts
test("lists one entry per Video with available artifacts", async () => {
  await seedMetadata(outputDir, { mode: "transcript-only", videoId: "1ZgUcrR0K7I" });
  const entries = await listLibraryEntries(outputDir);
  expect(entries).toEqual([expect.objectContaining({
    videoId: "1ZgUcrR0K7I",
    paths: expect.objectContaining({ digestPath: null, transcriptMarkdownPath: expect.stringEndingWith("1ZgUcrR0K7I.md") }),
  })]);
});
```

- [x] **Step 2: Verify the test fails**

Run: `bun test src/cli/library.test.ts`  
Expected: FAIL because discovery scans only `digests/`.

- [x] **Step 3: Implement metadata-driven entries**

```ts
export type LibraryEntry = {
  videoId: string; title: string | null; channel: string | null; updatedAt: string;
  paths: {
    digestPath: string | null; emailPreviewPath: string | null; metadataPath: string;
    transcriptJsonPath: string; transcriptMarkdownPath: string; transcriptTextPath: string;
  };
};
```

Rename discovery functions to `listLibraryEntries` and `resolveLibraryEntry`; derive
available paths from metadata and filesystem existence, sort by `processedAt`, and
make `open` choose Digest first, then Transcript Markdown.

- [x] **Step 4: Run library and CLI tests**

Run: `bun test src/cli/library.test.ts src/cli/main.test.ts && bun run typecheck`  
Expected: PASS, including transcript-only `list --json` and `open latest --json`.

- [x] **Step 5: Commit**

```bash
git add src/cli/artifacts.ts src/cli/library.test.ts src/cli/main.ts src/cli/main.test.ts
git commit -m "feat(cli): model library entries"
```

### Task 4: Clipboard, opener, stdout, help, and version contracts

**Files:**
- Create: `src/cli/system-actions.ts`
- Create: `src/cli/system-actions.test.ts`
- Modify: `src/cli/parse-args.ts`
- Modify: `src/cli/parse-args.test.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/main.test.ts`
- Modify: `src/cli/package-metadata.test.ts`

- [x] **Step 1: Write failing option and adapter tests**

```ts
test("rejects json with stdout", () => {
  expect(parseCliArgs(["transcript", url, "--json", "--stdout"])).toMatchObject({ ok: false, error: { code: "conflicting-options" } });
});

test("copies exact clean text through pbcopy", async () => {
  const calls: string[][] = [];
  await copyText("hello\n", fakeSpawn(calls));
  expect(calls[0]).toEqual(["pbcopy"]);
});
```

- [x] **Step 2: Verify the tests fail**

Run: `bun test src/cli/system-actions.test.ts src/cli/parse-args.test.ts src/cli/main.test.ts`  
Expected: FAIL for missing flags and actions.

- [x] **Step 3: Implement injected system actions and output modes**

```ts
export type SystemActions = {
  copy(text: string): Promise<void>;
  open(path: string): Promise<void>;
  reveal(path: string): Promise<void>;
};
```

Parse `--copy`, `--open`, and `--stdout`; keep artifact writes unchanged; suppress
progress and all other stdout for `--stdout`. Add command-scoped help, package-backed
`--version`, and OSC 8 links with a plain-path fallback.

- [x] **Step 4: Run complete direct-CLI verification**

Run: `bun test src/cli src/output src/ingestion src/video && bun run typecheck`  
Expected: PASS with stdout contract tests asserting exact strings.

- [x] **Step 5: Commit**

```bash
git add src/cli
git commit -m "feat(cli): add transcript actions"
```
