import type { YouTubeVideo } from "./youtube-url";

export type VideoMetadata = {
  channel: string | null;
  title: string | null;
};

export interface VideoMetadataSource {
  fetch(video: YouTubeVideo, options?: { signal?: AbortSignal }): Promise<VideoMetadata>;
}

export const EMPTY_VIDEO_METADATA: VideoMetadata = {
  channel: null,
  title: null,
};

export async function fetchVideoMetadataBestEffort(
  source: VideoMetadataSource | undefined,
  video: YouTubeVideo,
  options: { signal?: AbortSignal } = {},
): Promise<VideoMetadata> {
  if (!source) return EMPTY_VIDEO_METADATA;

  try {
    return await source.fetch(video, options);
  } catch {
    return EMPTY_VIDEO_METADATA;
  }
}
