import { readFile } from "node:fs/promises";
import { runIngestionFromUrl } from "../ingestion/ingestion-service";
import type { IngestionRepository } from "../storage/ingestion-repository";
import type { IngestionRecord } from "../storage/ingestion-record";
import type { Summarizer } from "../summarizer/summarizer";
import type { TranscriptSource } from "../transcript/transcript-source";
import { parseYouTubeVideoUrl } from "../video/youtube-url";
import { renderErrorPage, renderHomePage, renderIngestionPage } from "./html";
import { progressLabel, statusLabel } from "./ingestion-presenter";

export type WebHandlerDependencies = {
  outputDir: string;
  repository: IngestionRepository;
  runIngestion?: typeof runIngestionFromUrl;
  summarizer: Summarizer;
  transcriptSource: TranscriptSource;
};

export async function handleRequest(
  request: Request,
  dependencies: WebHandlerDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path === "/") {
    return htmlResponse(renderHomePage(dependencies.repository.listRecent()));
  }

  if (request.method === "POST" && path === "/ingestions") {
    const form = await request.formData();
    const youtubeUrl = String(form.get("url") ?? "").trim();

    if (!youtubeUrl) {
      return htmlResponse(renderErrorPage("URL requerida", "YouTube URL is required"), 400);
    }

    let video;
    try {
      video = parseYouTubeVideoUrl(youtubeUrl);
    } catch (error) {
      return htmlResponse(
        renderErrorPage(
          "URL no soportada",
          error instanceof Error ? error.message : "Unsupported YouTube URL",
        ),
        400,
      );
    }

    dependencies.repository.saveProcessing({
      canonicalUrl: video.canonicalUrl,
      progressStage: "queued",
      videoId: video.videoId,
    });
    startBackgroundIngestion(youtubeUrl, dependencies);

    return Response.redirect(new URL(`/ingestions/${video.videoId}`, url).toString(), 303);
  }

  const ingestionMatch = path.match(/^\/ingestions\/([^/]+)$/);
  if (request.method === "GET" && ingestionMatch) {
    const videoId = ingestionMatch[1];
    if (!videoId) {
      return new Response("Not found", { status: 404 });
    }

    const record = dependencies.repository.findByVideoId(videoId);
    if (!record) {
      return new Response("Ingestion not found", { status: 404 });
    }

    const digestMarkdown = record.digestPath ? await readOptionalFile(record.digestPath) : null;
    return htmlResponse(renderIngestionPage(record, digestMarkdown));
  }

  const apiMatch = path.match(/^\/api\/ingestions\/([^/]+)$/);
  if (request.method === "GET" && apiMatch) {
    const videoId = apiMatch[1];
    if (!videoId) {
      return new Response("Not found", { status: 404 });
    }

    const record = dependencies.repository.findByVideoId(videoId);
    if (!record) {
      return new Response(JSON.stringify({ error: "Ingestion not found" }), {
        headers: { "Content-Type": "application/json" },
        status: 404,
      });
    }

    return new Response(JSON.stringify(toPollingResponse(record), null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Not found", { status: 404 });
}

function startBackgroundIngestion(
  youtubeUrl: string,
  dependencies: WebHandlerDependencies,
): void {
  const runIngestion = dependencies.runIngestion ?? runIngestionFromUrl;

  void runIngestion(youtubeUrl, {
    outputDir: dependencies.outputDir,
    repository: dependencies.repository,
    summarizer: dependencies.summarizer,
    transcriptSource: dependencies.transcriptSource,
  }).catch((error) => {
    console.error(error);
  });
}

function toPollingResponse(record: IngestionRecord) {
  return {
    canonicalUrl: record.canonicalUrl,
    digestTitle: record.digestTitle,
    errorMessage: record.errorMessage,
    progressLabel: progressLabel(record.progressStage),
    progressStage: record.progressStage,
    status: record.status,
    statusLabel: statusLabel(record.status),
    updatedAt: record.updatedAt,
    videoId: record.videoId,
  };
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
    status,
  });
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
