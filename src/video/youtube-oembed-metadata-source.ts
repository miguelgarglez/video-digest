import type { VideoMetadata, VideoMetadataSource } from "./video-metadata-source";
import type { YouTubeVideo } from "./youtube-url";

export type OEmbedRequest = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type OEmbedTimer = {
  cancel(handle: unknown): void;
  schedule(callback: () => void, delayMs: number): unknown;
};

export type YouTubeOEmbedMetadataSourceOptions = {
  timeoutMs?: number;
  timer?: OEmbedTimer;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const defaultTimer: OEmbedTimer = {
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
};

export class YouTubeOEmbedMetadataSource implements VideoMetadataSource {
  private readonly timeoutMs: number;
  private readonly timer: OEmbedTimer;

  constructor(
    private readonly request: OEmbedRequest = fetch,
    options: YouTubeOEmbedMetadataSourceOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError("YouTube oEmbed timeout must be a positive finite number");
    }
    this.timer = options.timer ?? defaultTimer;
  }

  async fetch(video: YouTubeVideo): Promise<VideoMetadata> {
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.search = new URLSearchParams({
      format: "json",
      url: video.canonicalUrl,
    }).toString();

    const controller = new AbortController();
    const timeoutHandle = this.timer.schedule(() => {
      controller.abort(new Error(`YouTube oEmbed timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    try {
      const response = await this.request(endpoint, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`YouTube oEmbed failed with HTTP ${response.status}`);
      }

      const value: unknown = await response.json();
      const payload = isRecord(value) ? value : {};
      return {
        channel: normalizedOptionalText(payload.author_name),
        title: normalizedOptionalText(payload.title),
      };
    } finally {
      this.timer.cancel(timeoutHandle);
    }
  }
}

function normalizedOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
