import { describe, expect, test } from "bun:test";
import { parseYouTubeVideoUrl } from "./youtube-url";

describe("parseYouTubeVideoUrl", () => {
  test("extracts the same videoId from common YouTube URL formats", () => {
    const urls = [
      "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
      "https://www.youtube.com/watch?v=1ZgUcrR0K7I&si=gx3OkZEnDAk7KDwh",
      "https://youtu.be/1ZgUcrR0K7I?si=gx3OkZEnDAk7KDwh",
      "https://m.youtube.com/watch?v=1ZgUcrR0K7I",
      "https://www.youtube.com/shorts/1ZgUcrR0K7I",
    ];

    expect(urls.map((url) => parseYouTubeVideoUrl(url).videoId)).toEqual([
      "1ZgUcrR0K7I",
      "1ZgUcrR0K7I",
      "1ZgUcrR0K7I",
      "1ZgUcrR0K7I",
      "1ZgUcrR0K7I",
    ]);
  });

  test("returns a canonical watch URL", () => {
    expect(parseYouTubeVideoUrl("https://youtu.be/1ZgUcrR0K7I").canonicalUrl).toBe(
      "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
    );
  });

  test("rejects unsupported URLs", () => {
    expect(() => parseYouTubeVideoUrl("https://example.com/watch?v=1ZgUcrR0K7I")).toThrow(
      "Unsupported YouTube URL",
    );
  });
});
