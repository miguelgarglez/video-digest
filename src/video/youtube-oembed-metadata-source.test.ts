import { describe, expect, test } from "bun:test";
import { fetchVideoMetadataBestEffort } from "./video-metadata-source";
import { YouTubeOEmbedMetadataSource } from "./youtube-oembed-metadata-source";
import type { YouTubeVideo } from "./youtube-url";

describe("YouTubeOEmbedMetadataSource", () => {
  test("maps public oEmbed metadata and requests the canonical URL", async () => {
    const requests: URL[] = [];
    const source = new YouTubeOEmbedMetadataSource(async (request) => {
      requests.push(new URL(request.toString()));
      return new Response(JSON.stringify({
        author_name: "  A channel  ",
        title: "  A title  ",
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
      new Response(JSON.stringify({ author_name: "   ", title: "\n" })),
    );

    expect(await source.fetch(video)).toEqual({ channel: null, title: null });
  });

  test("maps a non-object JSON payload to null metadata", async () => {
    const source = new YouTubeOEmbedMetadataSource(async () =>
      new Response("null", { headers: { "content-type": "application/json" } }),
    );

    expect(await source.fetch(video)).toEqual({ channel: null, title: null });
  });

  test("rejects non-success responses", async () => {
    const source = new YouTubeOEmbedMetadataSource(async () => new Response("missing", { status: 404 }));

    await expect(source.fetch(video)).rejects.toThrow("YouTube oEmbed failed with HTTP 404");
  });

  test("aborts a bounded lookup and best-effort processing falls back without leaking its timer", async () => {
    let abortSignal: AbortSignal | undefined;
    let fireTimeout: (() => void) | undefined;
    let clearedHandle: unknown;
    const timerHandle = Symbol("metadata-timeout");
    const source = new YouTubeOEmbedMetadataSource(
      async (_request, init) => new Promise<Response>((_resolve, reject) => {
        abortSignal = init?.signal ?? undefined;
        abortSignal?.addEventListener("abort", () => reject(abortSignal?.reason), { once: true });
      }),
      {
        timeoutMs: 2_500,
        timer: {
          cancel(handle) {
            clearedHandle = handle;
          },
          schedule(callback, delayMs) {
            expect(delayMs).toBe(2_500);
            fireTimeout = callback;
            return timerHandle;
          },
        },
      },
    );

    const resultPromise = fetchVideoMetadataBestEffort(source, video);
    expect(abortSignal?.aborted).toBe(false);
    if (!fireTimeout) throw new Error("Expected metadata timeout to be scheduled");
    fireTimeout();

    expect(await resultPromise).toEqual({ channel: null, title: null });
    expect(abortSignal?.aborted).toBe(true);
    expect(clearedHandle).toBe(timerHandle);
  });
});

const video: YouTubeVideo = {
  canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
  videoId: "1ZgUcrR0K7I",
};
