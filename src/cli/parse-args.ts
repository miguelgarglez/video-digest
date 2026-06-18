import { parseYouTubeVideoUrl, type YouTubeVideo } from "../video/youtube-url";

export type CliOptions =
  | {
      command: "help";
    }
  | {
      command: "ingest";
      emailPreview: boolean;
      json: boolean;
      outputDir?: string;
      video: YouTubeVideo;
    }
  | {
      command: "transcript";
      json: boolean;
      outputDir?: string;
      video: YouTubeVideo;
    }
  | {
      command: "doctor";
      json: boolean;
    }
  | {
      command: "list";
      json: boolean;
      outputDir?: string;
    }
  | {
      command: "open";
      json: boolean;
      outputDir?: string;
      target: string;
    }
  | {
      command: "config";
      json: boolean;
      key?: "opencode-api-key" | "output-dir";
      subcommand: "get" | "set" | "unset";
      value?: string;
    };

export type CliError = {
  code: "missing-url" | "invalid-url" | "missing-option-value" | "unsupported-command" | "unsupported-option";
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

  if (args.includes("--output-dir") && !supportsOutputDir(findCommand(args))) {
    return {
      ok: false,
      error: {
        code: "unsupported-option",
        message: "--output-dir is only supported for ingest, transcript, list, and open.\n\nUsage: video-digest <command> [options]",
      },
    };
  }

  const parsedOutputDir = extractOutputDir(args);
  if (!parsedOutputDir.ok) {
    return parsedOutputDir;
  }
  const positional = parsedOutputDir.args.filter((arg) => !arg.startsWith("--"));
  const firstArg = positional[0];

  if (parsedOutputDir.outputDir !== undefined && !supportsOutputDir(firstArg)) {
    return {
      ok: false,
      error: {
        code: "unsupported-option",
        message: "--output-dir is only supported for ingest, transcript, list, and open.\n\nUsage: video-digest <command> [options]",
      },
    };
  }

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
        outputDir: parsedOutputDir.outputDir,
      },
    };
  }

  if (firstArg === "open") {
    const target = positional[1];

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
        outputDir: parsedOutputDir.outputDir,
        target,
      },
    };
  }

  if (firstArg === "config") {
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

    if (subcommand === "set" && key === "output-dir" && positional[3]) {
      return {
        ok: true,
        value: {
          command: "config",
          json: args.includes("--json"),
          key,
          subcommand,
          value: positional[3],
        },
      };
    }

    if (subcommand === "set" && key === "output-dir") {
      return {
        ok: false,
        error: {
          code: "missing-option-value",
          message: "output-dir requires a non-empty path.\n\nUsage: video-digest config set output-dir <path> [--json]",
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
    ? positional[1]
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
          outputDir: parsedOutputDir.outputDir,
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
        outputDir: parsedOutputDir.outputDir,
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

function supportsOutputDir(firstArg: string | undefined): boolean {
  return firstArg === "ingest"
    || firstArg === "transcript"
    || firstArg === "list"
    || firstArg === "open"
    || Boolean(firstArg && (
      firstArg.includes("://")
      || firstArg.includes("youtube.com")
      || firstArg.includes("youtu.be")
    ));
}

function findCommand(args: string[]): string | undefined {
  const optionValueIndexes = new Set<number>();
  args.forEach((arg, index) => {
    if (arg === "--output-dir") {
      optionValueIndexes.add(index + 1);
    }
  });
  return args.find((arg, index) => !arg.startsWith("--") && !optionValueIndexes.has(index));
}

function extractOutputDir(args: string[]):
  | { args: string[]; ok: true; outputDir?: string }
  | { error: CliError; ok: false } {
  const remaining: string[] = [];
  let outputDir: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--output-dir") {
      remaining.push(args[index]!);
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      return {
        ok: false,
        error: {
          code: "missing-option-value",
          message: "--output-dir requires a non-empty path.\n\nUsage: video-digest <command> [options] [--output-dir <path>]",
        },
      };
    }
    outputDir = value;
    index += 1;
  }

  return { args: remaining, ok: true, outputDir };
}
