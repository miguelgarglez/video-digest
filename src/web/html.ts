import type { IngestionRecord } from "../storage/ingestion-record";
import { progressLabel, statusLabel } from "./ingestion-presenter";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderHomePage(records: IngestionRecord[]): string {
  const history = records.length
    ? records
        .map(
          (record) => `
            <li>
              <a href="/ingestions/${escapeHtml(record.videoId)}">${escapeHtml(record.digestTitle ?? record.videoId)}</a>
              <span class="meta">${escapeHtml(record.status)} · ${escapeHtml(record.updatedAt)}</span>
            </li>
          `,
        )
        .join("")
    : "<li class=\"empty\">No ingestions yet.</li>";

  return renderPage(
    "Video Digest",
    `
      <section class="card">
        <h1>Video Digest</h1>
        <p class="subtitle">Paste a YouTube URL to fetch a transcript and generate a digest.</p>
        <form method="post" action="/ingestions">
          <label for="url">YouTube URL</label>
          <input id="url" name="url" type="url" placeholder="https://www.youtube.com/watch?v=..." required />
          <button type="submit">Generate digest</button>
        </form>
      </section>
      <section class="card">
        <h2>Recent ingestions</h2>
        <ul class="history">${history}</ul>
      </section>
    `,
  );
}

export function renderIngestionPage(record: IngestionRecord, digestMarkdown: string | null): string {
  const status = statusLabel(record.status);
  const progress = progressLabel(record.progressStage);
  const warnings =
    record.warnings.length > 0
      ? `<ul>${record.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
      : "<p>None</p>";

  const errorBlock =
    record.errorMessage !== null
      ? `<section class="card error"><h2>Error</h2><pre>${escapeHtml(record.errorMessage)}</pre></section>`
      : "";

  const digestBlock =
    digestMarkdown !== null
      ? `<section class="card"><h2>Digest</h2><pre class="digest">${escapeHtml(digestMarkdown)}</pre></section>`
      : "";
  const processingBlock =
    record.status === "processing"
      ? `
        <section class="card processing" data-poll-url="/api/ingestions/${escapeHtml(record.videoId)}">
          <h2>${escapeHtml(status)}</h2>
          <p id="progress-label" class="progress-label">${escapeHtml(progress ?? "En cola")}</p>
          <p id="polling-status" class="meta">Actualizando estado...</p>
          <div class="activity" aria-hidden="true"></div>
        </section>
        <script>
          (() => {
            const container = document.querySelector("[data-poll-url]");
            const pollUrl = container?.getAttribute("data-poll-url");
            const progressLabel = document.getElementById("progress-label");
            const pollingStatus = document.getElementById("polling-status");
            if (!pollUrl || !progressLabel || !pollingStatus) return;

            async function poll() {
              try {
                const response = await fetch(pollUrl, { headers: { "Accept": "application/json" } });
                if (!response.ok) throw new Error("Polling failed");
                const ingestion = await response.json();
                if (ingestion.progressLabel) progressLabel.textContent = ingestion.progressLabel;
                pollingStatus.textContent = "Actualizado hace unos segundos";
                if (ingestion.status !== "processing") {
                  window.location.reload();
                  return;
                }
              } catch {
                pollingStatus.textContent = "No se pudo actualizar. Reintentando...";
              }
              window.setTimeout(poll, 1500);
            }

            window.setTimeout(poll, 1000);
          })();
        </script>
      `
      : "";

  return renderPage(
    record.digestTitle ?? record.videoId,
    `
      <p><a href="/">← Back</a></p>
      <section class="card">
        <h1>${escapeHtml(record.digestTitle ?? "Ingestion result")}</h1>
        <dl class="facts">
          <dt>Video ID</dt><dd>${escapeHtml(record.videoId)}</dd>
          <dt>URL</dt><dd><a href="${escapeHtml(record.canonicalUrl)}">${escapeHtml(record.canonicalUrl)}</a></dd>
          <dt>Status</dt><dd>${escapeHtml(status)}</dd>
          <dt>Transcript quality</dt><dd>${escapeHtml(record.transcriptQualityStatus ?? "n/a")}</dd>
          <dt>Updated</dt><dd>${escapeHtml(record.updatedAt)}</dd>
        </dl>
      </section>
      ${processingBlock}
      <section class="card">
        <h2>Warnings</h2>
        ${warnings}
      </section>
      ${errorBlock}
      ${digestBlock}
    `,
  );
}

export function renderErrorPage(title: string, message: string): string {
  return renderPage(
    title,
    `
      <p><a href="/">← Back</a></p>
      <section class="card error">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
      </section>
    `,
  );
}

function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, system-ui, sans-serif;
        line-height: 1.5;
      }
      body {
        margin: 0 auto;
        max-width: 760px;
        padding: 2rem 1rem 4rem;
        background: #f6f7f9;
        color: #111827;
      }
      .card {
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
        padding: 1.25rem;
        margin-bottom: 1rem;
      }
      h1, h2 { margin-top: 0; }
      .subtitle { color: #4b5563; }
      form { display: grid; gap: 0.75rem; }
      input, button {
        font: inherit;
        padding: 0.75rem;
        border-radius: 8px;
        border: 1px solid #d1d5db;
      }
      button {
        background: #111827;
        color: #fff;
        border-color: #111827;
        cursor: pointer;
      }
      .history, .facts { margin: 0; padding: 0; list-style: none; }
      .history li, .facts { margin-bottom: 0.5rem; }
      .facts dt { font-weight: 600; margin-top: 0.5rem; }
      .facts dd { margin: 0.15rem 0 0; }
      .meta, .empty { color: #6b7280; }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        background: #f9fafb;
        border-radius: 8px;
        padding: 1rem;
        overflow-x: auto;
      }
      .error pre { background: #fef2f2; }
      .activity {
        width: 100%;
        height: 4px;
        overflow: hidden;
        position: relative;
        background: #e5e7eb;
        border-radius: 999px;
      }
      .activity::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 35%;
        background: #111827;
        border-radius: inherit;
        animation: activity 1.2s ease-in-out infinite;
      }
      .progress-label { font-weight: 600; }
      @keyframes activity {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(300%); }
      }
      @media (prefers-color-scheme: dark) {
        body { background: #0f172a; color: #e5e7eb; }
        .card { background: #111827; border-color: #374151; }
        .subtitle, .meta, .empty { color: #9ca3af; }
        input, button { background: #0f172a; color: #e5e7eb; border-color: #374151; }
        button { background: #e5e7eb; color: #111827; }
        pre { background: #0f172a; }
        .error pre { background: #3f1d1d; }
        .activity { background: #374151; }
        .activity::before { background: #e5e7eb; }
      }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}
