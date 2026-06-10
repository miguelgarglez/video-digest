import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { handleRequest } from "./handler";
import { IngestionRepository } from "../storage/ingestion-repository";
import type { Summarizer } from "../summarizer/summarizer";
import type { TranscriptSource } from "../transcript/transcript-source";
describe("handleRequest", () => {
  let tempDir = "";
  let repository: IngestionRepository | null = null;

  afterEach(async () => {
    repository?.close();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("renders the home page", async () => {
    ({ repository, tempDir } = await createRepository());

    const response = await handleRequest(new Request("http://localhost/"), {
      outputDir: join(tempDir, "outputs"),
      repository,
      summarizer: fakeSummarizer(),
      transcriptSource: fakeTranscriptSource(),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Personal Video Digest");
  });

  test("redirects after creating an ingestion", async () => {
    ({ repository, tempDir } = await createRepository());

    let resolveIngestion!: () => void;
    const ingestionStarted = new Promise<void>((resolve) => {
      resolveIngestion = resolve;
    });

    const responsePromise = handleRequest(
      new Request("http://localhost/ingestions", {
        body: new URLSearchParams({ url: "https://youtu.be/1ZgUcrR0K7I" }),
        method: "POST",
      }),
      {
        outputDir: join(tempDir, "outputs"),
        repository,
        runIngestion: async () => {
          await ingestionStarted;
          return {
            ok: true,
            record: repository!.save({
              canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
              digestTitle: "Useful Digest",
              status: "completed",
              videoId: "1ZgUcrR0K7I",
            }),
          };
        },
        summarizer: fakeSummarizer(),
        transcriptSource: fakeTranscriptSource(),
      },
    );
    const response = await Promise.race([
      responsePromise,
      delay(20).then(() => "timed-out" as const),
    ]);

    expect(response).not.toBe("timed-out");
    if (response === "timed-out") {
      throw new Error("POST /ingestions waited for background ingestion");
    }
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/ingestions/1ZgUcrR0K7I");
    expect(repository.findByVideoId("1ZgUcrR0K7I")).toMatchObject({
      progressStage: "queued",
      status: "processing",
    });

    resolveIngestion();
  });

  test("renders invalid url submissions as HTML errors", async () => {
    ({ repository, tempDir } = await createRepository());

    const response = await handleRequest(
      new Request("http://localhost/ingestions", {
        body: new URLSearchParams({ url: "not-a-url" }),
        method: "POST",
      }),
      {
        outputDir: join(tempDir, "outputs"),
        repository,
        summarizer: fakeSummarizer(),
        transcriptSource: fakeTranscriptSource(),
      },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Unsupported YouTube URL");
  });

  test("returns ingestion details as JSON", async () => {
    ({ repository, tempDir } = await createRepository());
    repository!.save({
      canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      digestTitle: "Useful Digest",
      status: "completed",
      videoId: "1ZgUcrR0K7I",
    });

    const response = await handleRequest(new Request("http://localhost/api/ingestions/1ZgUcrR0K7I"), {
      outputDir: join(tempDir, "outputs"),
      repository,
      summarizer: fakeSummarizer(),
      transcriptSource: fakeTranscriptSource(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      digestTitle: "Useful Digest",
      progressLabel: null,
      progressStage: null,
      statusLabel: "Completado",
      status: "completed",
      videoId: "1ZgUcrR0K7I",
    });
  });

  test("returns processing ingestion details as polling JSON", async () => {
    ({ repository, tempDir } = await createRepository());
    repository!.saveProcessing({
      canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      progressStage: "generating-digest",
      videoId: "1ZgUcrR0K7I",
    });

    const response = await handleRequest(new Request("http://localhost/api/ingestions/1ZgUcrR0K7I"), {
      outputDir: join(tempDir, "outputs"),
      repository,
      summarizer: fakeSummarizer(),
      transcriptSource: fakeTranscriptSource(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      progressLabel: "Generando digest",
      progressStage: "generating-digest",
      status: "processing",
      statusLabel: "Procesando",
      videoId: "1ZgUcrR0K7I",
    });
  });

  test("renders ingestion page with digest content", async () => {
    ({ repository, tempDir } = await createRepository());
    const outputDir = join(tempDir, "outputs");
    const digestPath = join(outputDir, "digests", "1ZgUcrR0K7I.md");
    await mkdir(join(outputDir, "digests"), { recursive: true });
    await writeFile(digestPath, "# Useful Digest\n", { flag: "w" });

    repository!.save({
      canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      digestPath,
      digestTitle: "Useful Digest",
      status: "completed",
      videoId: "1ZgUcrR0K7I",
    });

    const response = await handleRequest(new Request("http://localhost/ingestions/1ZgUcrR0K7I"), {
      outputDir,
      repository,
      summarizer: fakeSummarizer(),
      transcriptSource: fakeTranscriptSource(),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Useful Digest");
  });

  test("renders processing ingestion page with human progress and polling", async () => {
    ({ repository, tempDir } = await createRepository());
    repository!.saveProcessing({
      canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      progressStage: "fetching-transcript",
      videoId: "1ZgUcrR0K7I",
    });

    const response = await handleRequest(new Request("http://localhost/ingestions/1ZgUcrR0K7I"), {
      outputDir: join(tempDir, "outputs"),
      repository,
      summarizer: fakeSummarizer(),
      transcriptSource: fakeTranscriptSource(),
    });

    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Procesando");
    expect(html).toContain("Obteniendo transcripción");
    expect(html).toContain('data-poll-url="/api/ingestions/1ZgUcrR0K7I"');
    expect(html).toContain("fetch(pollUrl");
    expect(html).not.toContain("<pre class=\"digest\"");
  });
});

async function createRepository() {
  const tempDir = await mkdtemp(join(tmpdir(), "video-digest-web-"));
  const repository = new IngestionRepository({ dbPath: join(tempDir, "ingestions.sqlite") });
  return { repository, tempDir };
}

function fakeSummarizer(): Summarizer {
  return {
    async generateDigest() {
      throw new Error("Not used in handler tests");
    },
  };
}

function fakeTranscriptSource(): TranscriptSource {
  return {
    async fetch() {
      throw new Error("Not used in handler tests");
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
