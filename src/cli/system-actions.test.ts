import { describe, expect, test } from "bun:test";
import { copyText, openPath, revealPath, SystemActionError, type SpawnCommand } from "./system-actions";

function recordingSpawn(exitCode = 0, stderr = ""): { calls: Array<{ command: string[]; stdin?: string }>; spawn: SpawnCommand } {
  const calls: Array<{ command: string[]; stdin?: string }> = [];
  return {
    calls,
    spawn: async (command, options = {}) => {
      calls.push({ command: [...command], stdin: options.stdin });
      return { exitCode, stderr };
    },
  };
}

describe("macOS system actions", () => {
  test("copies exact clean text through pbcopy stdin", async () => {
    const fake = recordingSpawn();
    await copyText("hello\n", fake.spawn);
    expect(fake.calls).toEqual([{ command: ["pbcopy"], stdin: "hello\n" }]);
  });

  test("opens and reveals paths without invoking a shell", async () => {
    const fake = recordingSpawn();
    await openPath("/tmp/a file.md", fake.spawn);
    await revealPath("/tmp/a file.md", fake.spawn);
    expect(fake.calls).toEqual([
      { command: ["open", "/tmp/a file.md"], stdin: undefined },
      { command: ["open", "-R", "/tmp/a file.md"], stdin: undefined },
    ]);
  });

  test("returns a stable safe error when a system command fails", async () => {
    const fake = recordingSpawn(1, "private system detail");
    await expect(copyText("secret", fake.spawn)).rejects.toEqual(
      new SystemActionError("copy-failed", "Could not copy the transcript. Ensure pbcopy is available and try again."),
    );
  });

  test("normalizes spawn exceptions without leaking their details", async () => {
    const spawn: SpawnCommand = async () => { throw new Error("secret command detail"); };
    await expect(openPath("/tmp/a.md", spawn)).rejects.toEqual(
      new SystemActionError("open-failed", "Could not open the transcript. Open the Markdown file from its reported path."),
    );
  });
});
