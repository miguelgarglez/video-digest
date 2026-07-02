import { describe, expect, test } from "bun:test";
import {
  copyText,
  openExternalUrl,
  openPath,
  revealPath,
  spawnCommand,
  SystemActionError,
  type SpawnCommand,
} from "./system-actions";

function recordingSpawn(exitCode = 0, stderr = ""): { calls: Array<{ command: string[]; stdin?: string }>; spawn: SpawnCommand } {
  const calls: Array<{ command: string[]; stdin?: string }> = [];
  return {
    calls,
    spawn: async (command, options = {}) => {
      calls.push({ command: [...command], stdin: options.stdin });
      return { exitCode, stderr, stdout: "" };
    },
  };
}

describe("macOS system actions", () => {
  test("copies exact clean text through pbcopy stdin", async () => {
    const fake = recordingSpawn();
    await copyText("hello\n", fake.spawn);
    expect(fake.calls).toEqual([{ command: ["pbcopy"], stdin: "hello\n" }]);
  });

  test("preserves a large Unicode payload exactly", async () => {
    const fake = recordingSpawn();
    const text = `${"🧠 résumé 日本語\n".repeat(100_000)}final\n`;
    await copyText(text, fake.spawn);
    expect(fake.calls[0]?.stdin).toBe(text);
  });

  test("maps early-exit input delivery failures without an unhandled rejection", async () => {
    const spawn: SpawnCommand = async () => {
      await Promise.resolve();
      throw Object.assign(new Error("broken pipe detail"), { code: "EPIPE" });
    };
    await expect(copyText("large text", spawn)).rejects.toMatchObject({ code: "copy-failed" });
  });

  test("delivers a backpressured Unicode Blob before reporting success", async () => {
    const text = "🧠日本語résumé".repeat(200_000);
    const byteLength = new TextEncoder().encode(text).byteLength;
    const result = await spawnCommand([
      process.execPath,
      "-e",
      "const s=await Bun.stdin.text();process.exit(new TextEncoder().encode(s).byteLength===Number(Bun.argv.at(-1))?0:1)",
      String(byteLength),
    ], { stdin: text });
    expect(result.exitCode).toBe(0);
  });

  test("maps a real early child exit while a large input is pending", async () => {
    await expect(copyText("x".repeat(2_000_000), (command, options) =>
      spawnCommand(["/bin/sh", "-c", "exit 9"], options))).rejects.toMatchObject({ code: "copy-failed" });
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

  test("opens only approved feedback URL shapes as separate process arguments", async () => {
    const commands: string[][] = [];
    const spawn: SpawnCommand = async (command) => {
      commands.push([...command]);
      return { exitCode: 0, stderr: "", stdout: "" };
    };

    await openExternalUrl("mailto:miguel.garglez@gmail.com?subject=Video%20Digest", spawn);
    await openExternalUrl(
      "https://github.com/miguelgarglez/video-digest/issues/new?title=%5BBug%5D",
      spawn,
    );

    expect(commands).toEqual([
      ["/usr/bin/open", "mailto:miguel.garglez@gmail.com?subject=Video%20Digest"],
      ["/usr/bin/open", "https://github.com/miguelgarglez/video-digest/issues/new?title=%5BBug%5D"],
    ]);
  });

  test("rejects shells, files, foreign hosts, and misleading GitHub paths before spawning", async () => {
    let calls = 0;
    const spawn: SpawnCommand = async () => {
      calls += 1;
      return { exitCode: 0, stderr: "", stdout: "" };
    };

    for (const url of [
      "file:///Users/test/private",
      "javascript:alert(1)",
      "https://example.com/miguelgarglez/video-digest/issues/new",
      "https://github.com/another/repository/issues/new",
      "mailto:another@example.com",
    ]) {
      await expect(openExternalUrl(url, spawn)).rejects.toMatchObject({ code: "open-failed" });
    }
    expect(calls).toBe(0);
  });

  test("returns a stable safe error when a system command fails", async () => {
    const fake = recordingSpawn(1, "private system detail");
    await expect(copyText("secret", fake.spawn)).rejects.toEqual(
      new SystemActionError("copy-failed", "Could not copy the text. Copy it manually and try again."),
    );
  });

  test("normalizes spawn exceptions without leaking their details", async () => {
    const spawn: SpawnCommand = async () => { throw new Error("secret command detail"); };
    await expect(openPath("/tmp/a.md", spawn)).rejects.toEqual(
      new SystemActionError("open-failed", "Could not open the transcript. Open the Markdown file from its reported path."),
    );
  });
});
