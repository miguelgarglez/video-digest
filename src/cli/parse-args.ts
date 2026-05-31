import { parseYouTubeVideoUrl, type YouTubeVideo } from "../video/youtube-url";

export type CliOptions = {
  emailPreview: boolean;
  video: YouTubeVideo;
};

export type CliError = {
  code: "missing-url" | "invalid-url";
  message: string;
};

export type CliArgsResult =
  | {
      ok: true;
      value: CliOptions;
    }
  | {
      ok: false;
      error: CliError;
    };

export const USAGE = "Usage: bun run video-digest <youtube-url> [--email-preview]";

export function parseCliArgs(args: string[]): CliArgsResult {
  const url = args.find((arg) => !arg.startsWith("--"));

  if (!url) {
    return {
      ok: false,
      error: {
        code: "missing-url",
        message: USAGE,
      },
    };
  }

  try {
    return {
      ok: true,
      value: {
        emailPreview: args.includes("--email-preview"),
        video: parseYouTubeVideoUrl(url),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "invalid-url",
        message: error instanceof Error ? error.message : `Unsupported YouTube URL: ${url}`,
      },
    };
  }
}
