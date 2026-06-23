import type { PublicCliErrorCode } from "./public-contract";

export type SpawnResult = {
  exitCode: number;
  stderr: string;
};

export type SpawnCommand = (
  command: readonly string[],
  options?: { stdin?: string },
) => Promise<SpawnResult>;

export type SystemActions = {
  copy(text: string): Promise<void>;
  open(path: string): Promise<void>;
  reveal(path: string): Promise<void>;
};

export class SystemActionError extends Error {
  constructor(
    public readonly code: Extract<PublicCliErrorCode, "copy-failed" | "open-failed" | "reveal-failed">,
    message: string,
  ) {
    super(message);
    this.name = "SystemActionError";
  }
}

export async function copyText(text: string, spawn: SpawnCommand = spawnCommand): Promise<void> {
  await execute(["pbcopy"], { stdin: text }, spawn, new SystemActionError(
    "copy-failed",
    "Could not copy the transcript. Ensure pbcopy is available and try again.",
  ));
}

export async function openPath(path: string, spawn: SpawnCommand = spawnCommand): Promise<void> {
  await execute(["open", path], {}, spawn, new SystemActionError(
    "open-failed",
    "Could not open the transcript. Open the Markdown file from its reported path.",
  ));
}

export async function revealPath(path: string, spawn: SpawnCommand = spawnCommand): Promise<void> {
  await execute(["open", "-R", path], {}, spawn, new SystemActionError(
    "reveal-failed",
    "Could not reveal the file. Open its reported parent folder manually.",
  ));
}

export function createMacOSSystemActions(spawn: SpawnCommand = spawnCommand): SystemActions {
  return {
    copy: (text) => copyText(text, spawn),
    open: (path) => openPath(path, spawn),
    reveal: (path) => revealPath(path, spawn),
  };
}

async function execute(
  command: readonly string[],
  options: { stdin?: string },
  spawn: SpawnCommand,
  failure: SystemActionError,
): Promise<void> {
  try {
    const result = await spawn(command, options);
    if (result.exitCode !== 0) throw failure;
  } catch (error) {
    if (error instanceof SystemActionError) throw error;
    throw failure;
  }
}

export async function spawnCommand(command: readonly string[], options: { stdin?: string } = {}): Promise<SpawnResult> {
  const child = Bun.spawn([...command], {
    // A buffered Blob makes Bun own the complete delivery lifecycle. There are no
    // FileSink write/end promises that can reject after this function returns.
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "ignore",
    stderr: "pipe",
  });

  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr };
}
