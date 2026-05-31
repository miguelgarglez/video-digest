export type YouTubeVideo = {
  canonicalUrl: string;
  videoId: string;
};

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function parseYouTubeVideoUrl(input: string): YouTubeVideo {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw new Error(`Unsupported YouTube URL: ${input}`);
  }

  const host = url.hostname.toLowerCase();
  const videoId =
    parseWatchUrl(host, url) ?? parseShortUrl(host, url) ?? parseShortsUrl(host, url);

  if (!videoId || !YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
    throw new Error(`Unsupported YouTube URL: ${input}`);
  }

  return {
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
  };
}

function parseWatchUrl(host: string, url: URL): string | null {
  if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
    return null;
  }

  if (url.pathname !== "/watch") {
    return null;
  }

  return url.searchParams.get("v");
}

function parseShortUrl(host: string, url: URL): string | null {
  if (host !== "youtu.be") {
    return null;
  }

  return firstPathSegment(url);
}

function parseShortsUrl(host: string, url: URL): string | null {
  if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
    return null;
  }

  const segments = pathSegments(url);
  if (segments[0] !== "shorts") {
    return null;
  }

  return segments[1] ?? null;
}

function firstPathSegment(url: URL): string | null {
  return pathSegments(url)[0] ?? null;
}

function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}
