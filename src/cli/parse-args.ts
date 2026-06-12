import { parseYouTubeVideoUrl, type YouTubeVideo } from "../video/youtube-url";

export type CliOptions =
  | {
      command: "help";
    }
  | {
      command: "ingest";
      emailPreview: boolean;
      json: boolean;
      video: YouTubeVideo;
    }
  | {
      command: "transcript";
      json: boolean;
      video: YouTubeVideo;
    }
  | {
      command: "doctor";
      json: boolean;
    }
  | {
      command: "list";
      json: boolean;
    }
  | {
      command: "open";
      json: boolean;
      target: string;
    }
  | {
      command: "config";
      json: boolean;
      key?: "opencode-api-key";
      subcommand: "get" | "set" | "unset";
    };

export type CliError = {
  code: "missing-url" | "invalid-url" | "unsupported-command";
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

export const USAGE = "Usage: video-digest <command> [options]";
export const LEGACY_USAGE = "Usage: bun run video-digest <youtube-url> [--email-preview]";

const COMMANDS = new Set(["ingest", "transcript", "doctor", "list", "open", "config"]);

export function parseCliArgs(args: string[]): CliArgsResult {
  if (args.includes("--help") || args.includes("-h")) {
    return {
      ok: true,
      value: {
        command: "help",
      },
    };
  }

  const firstArg = args.find((arg) => !arg.startsWith("--"));

  if (firstArg === "doctor") {
    return {
      ok: true,
      value: {
        command: "doctor",
        json: args.includes("--json"),
      },
    };
  }

  if (firstArg === "list") {
    return {
      ok: true,
      value: {
        command: "list",
        json: args.includes("--json"),
      },
    };
  }

  if (firstArg === "open") {
    const target = args.filter((arg) => !arg.startsWith("--"))[1];

    if (!target) {
      return {
        ok: false,
        error: {
          code: "missing-url",
          message: "Usage: video-digest open <latest|video-id> [--json]",
        },
      };
    }

    return {
      ok: true,
      value: {
        command: "open",
        json: args.includes("--json"),
        target,
      },
    };
  }

  if (firstArg === "config") {
    const positional = args.filter((arg) => !arg.startsWith("--"));
    const subcommand = positional[1];
    const key = positional[2];

    if (subcommand === "get") {
      return {
        ok: true,
        value: {
          command: "config",
          json: args.includes("--json"),
          subcommand,
        },
      };
    }

    if ((subcommand === "set" || subcommand === "unset") && key === "opencode-api-key") {
      return {
        ok: true,
        value: {
          command: "config",
          json: args.includes("--json"),
          key,
          subcommand,
        },
      };
    }

    return {
      ok: false,
      error: {
        code: "unsupported-command",
        message: "Usage: video-digest config <get|set|unset> [opencode-api-key] [--json]",
      },
    };
  }

  const url = firstArg === "ingest" || firstArg === "transcript"
    ? args.filter((arg) => !arg.startsWith("--"))[1]
    : firstArg;

  if (!url) {
    return {
      ok: false,
      error: {
        code: "missing-url",
        message: firstArg === "transcript"
          ? "Usage: video-digest transcript <youtube-url> [--json]"
          : LEGACY_USAGE,
      },
    };
  }

  if (
    firstArg &&
    !firstArg.includes("://") &&
    !firstArg.includes("youtube.com") &&
    !firstArg.includes("youtu.be") &&
    !COMMANDS.has(firstArg)
  ) {
    return {
      ok: false,
      error: {
        code: "unsupported-command",
        message: `Unsupported command: ${firstArg}\n\n${USAGE}`,
      },
    };
  }

  try {
    const video = parseYouTubeVideoUrl(url);
    if (firstArg === "transcript") {
      return {
        ok: true,
        value: {
          command: "transcript",
          json: args.includes("--json"),
          video,
        },
      };
    }

    return {
      ok: true,
      value: {
        command: "ingest",
        emailPreview: args.includes("--email-preview"),
        json: args.includes("--json"),
        video,
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
