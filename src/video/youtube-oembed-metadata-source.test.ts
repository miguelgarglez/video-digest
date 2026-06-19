import { describe, expect, test } from "bun:test";
import { YouTubeOEmbedMetadataSource } from "./youtube-oembed-metadata-source";
import type { YouTubeVideo } from "./youtube-url";

describe("YouTubeOEmbedMetadataSource", () => {
  test("maps public oEmbed metadata and requests the canonical URL", async () => {
    const requests: URL[] = [];
    const source = new YouTubeOEmbedMetadataSource(async (request) => {
      requests.push(new URL(request.toString()));
      return new Response(JSON.stringify({
        author_name: "A channel",
        title: "A title",
      }));
    });

    expect(await source.fetch(video)).toEqual({
      channel: "A channel",
      title: "A title",
    });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error("Expected one oEmbed request");
    expect(request.origin + request.pathname).toBe("https://www.youtube.com/oembed");
    expect(request.searchParams.get("format")).toBe("json");
    expect(request.searchParams.get("url")).toBe(video.canonicalUrl);
  });

  test("maps missing or invalid public fields to null", async () => {
    const source = new YouTubeOEmbedMetadataSource(async () =>
      new Response(JSON.stringify({ author_name: 42, title: null })),
    );

    expect(await source.fetch(video)).toEqual({ channel: null, title: null });
  });

  test("rejects non-success responses", async () => {
    const source = new YouTubeOEmbedMetadataSource(async () => new Response("missing", { status: 404 }));

    await expect(source.fetch(video)).rejects.toThrow("YouTube oEmbed failed with HTTP 404");
  });
});

const video: YouTubeVideo = {
  canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
  videoId: "1ZgUcrR0K7I",
};
