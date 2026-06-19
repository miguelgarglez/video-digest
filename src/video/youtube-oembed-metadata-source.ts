import type { VideoMetadata, VideoMetadataSource } from "./video-metadata-source";
import type { YouTubeVideo } from "./youtube-url";

export type OEmbedRequest = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class YouTubeOEmbedMetadataSource implements VideoMetadataSource {
  constructor(private readonly request: OEmbedRequest = fetch) {}

  async fetch(video: YouTubeVideo): Promise<VideoMetadata> {
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.search = new URLSearchParams({
      format: "json",
      url: video.canonicalUrl,
    }).toString();

    const response = await this.request(endpoint);
    if (!response.ok) {
      throw new Error(`YouTube oEmbed failed with HTTP ${response.status}`);
    }

    const value: unknown = await response.json();
    const payload = isRecord(value) ? value : {};
    return {
      channel: typeof payload.author_name === "string" ? payload.author_name : null,
      title: typeof payload.title === "string" ? payload.title : null,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
