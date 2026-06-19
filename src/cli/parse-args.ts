import { parseYouTubeVideoUrl, type YouTubeVideo } from "../video/youtube-url";

export type CliOptions =
  | {
      command: "help";
      topic?: string;
    }
  | {
      command: "version";
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
      copy: boolean;
      json: boolean;
      open: boolean;
      outputDir?: string;
      stdout: boolean;
      video: YouTubeVideo;
    }
  | {
      command: "doctor";
      json: boolean;
    }
  | {
      command: "setup";
      json: boolean;
      yes: boolean;
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
  code: "conflicting-options" | "duplicate-option" | "missing-url" | "invalid-url" | "missing-option-value" | "unsupported-command" | "unsupported-option";
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

const COMMANDS = new Set(["ingest", "transcript", "doctor", "setup", "list", "open", "config"]);

export function parseCliArgs(args: string[]): CliArgsResult {
  const duplicate = args.find((argument, index) => argument.startsWith("-") && args.indexOf(argument) !== index);
  if (duplicate) {
    return failure("duplicate-option", `Option may only be specified once: ${duplicate}`);
  }

  if (args[0] === "--version") {
    return args.length === 1
      ? { ok: true, value: { command: "version" } }
      : failure("unsupported-option", "--version cannot be combined with other arguments.");
  }

  if (args.includes("--help") || args.includes("-h")) {
    const topic = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
    if (topic && !COMMANDS.has(topic)) return failure("unsupported-command", `Unsupported command: ${topic}\n\n${USAGE}`);
    const unexpected = args.find((argument, index) => index > 0 && argument !== "--help" && argument !== "-h");
    if (unexpected) return failure("unsupported-option", `Command help cannot be combined with: ${unexpected}`);
    return {
      ok: true,
      value: {
        command: "help",
        ...(topic ? { topic } : {}),
      },
    };
  }

  const command = findCommand(args);
  const allowedOptions = allowedOptionsFor(command);
  const unsupportedOption = args.find((argument) => argument.startsWith("-") && argument !== "--output-dir" && !allowedOptions.has(argument));
  if (unsupportedOption && command !== "setup") {
    return failure("unsupported-option", `Unsupported ${command ?? "CLI"} option: ${unsupportedOption}`);
  }
  const unsupportedAction = ["--copy", "--open", "--stdout"].find((flag) => args.includes(flag) && command !== "transcript");
  if (unsupportedAction) {
    return failure("unsupported-option", `${unsupportedAction} is only supported for transcript.`);
  }
  if (command === "transcript" && args.includes("--json") && args.includes("--stdout")) {
    return failure("conflicting-options", "--stdout cannot be combined with --json. Remove one of these options.");
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

  const maximumPositionals = firstArg === "open" ? 2
    : firstArg === "doctor" || firstArg === "list" ? 1
    : firstArg === "ingest" || firstArg === "transcript" ? 2
    : undefined;
  if (maximumPositionals !== undefined && positional.length > maximumPositionals) {
    return unexpectedArgument(firstArg!, positional[maximumPositionals]!);
  }
  if (firstArg && !COMMANDS.has(firstArg) && positional.length > 1) {
    return unexpectedArgument("ingest", positional[1]!);
  }

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

  if (firstArg === "setup") {
    const unknownOption = args.find((arg) => arg.startsWith("--") && arg !== "--yes" && arg !== "--json");
    if (unknownOption) {
      return {
        ok: false,
        error: {
          code: "unsupported-option",
          message: `Unsupported setup option: ${unknownOption}\n\nUsage: video-digest setup [--yes] [--json]`,
        },
      };
    }
    const unexpectedArgument = positional[1];
    if (unexpectedArgument) {
      return {
        ok: false,
        error: {
          code: "unsupported-command",
          message: `Unexpected setup argument: ${unexpectedArgument}\n\nUsage: video-digest setup [--yes] [--json]`,
        },
      };
    }
    return {
      ok: true,
      value: {
        command: "setup",
        json: args.includes("--json"),
        yes: args.includes("--yes"),
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
      if (positional.length > 2) return unexpectedArgument("config", positional[2]!);
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
      if (positional.length > 3) return unexpectedArgument("config", positional[3]!);
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
      if (positional.length > 4) return unexpectedArgument("config", positional[4]!);
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
          copy: args.includes("--copy"),
          json: args.includes("--json"),
          open: args.includes("--open"),
          outputDir: parsedOutputDir.outputDir,
          stdout: args.includes("--stdout"),
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

function failure(code: CliError["code"], message: string): CliArgsResult {
  return { ok: false, error: { code, message } };
}

function unexpectedArgument(command: string, argument: string): CliArgsResult {
  return failure("unsupported-command", `Unexpected ${command} argument: ${argument}\n\n${USAGE}`);
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

function allowedOptionsFor(command: string | undefined): Set<string> {
  const common = ["--json"];
  switch (command) {
    case "transcript": return new Set([...common, "--copy", "--open", "--stdout", "--output-dir"]);
    case "ingest": return new Set([...common, "--email-preview", "--output-dir"]);
    case "list":
    case "open": return new Set([...common, "--output-dir"]);
    case "setup": return new Set([...common, "--yes"]);
    case "doctor":
    case "config": return new Set(common);
    default:
      return new Set([...common, "--email-preview", "--output-dir"]);
  }
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
