import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { ProcessLockError, withProcessLock } from "./process-lock";

describe("withProcessLock", () => {
  test("rejects a second live owner without disturbing the first", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-lock-"));
    const lockDir = join(root, "library.lock");
    let unblock!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const first = withProcessLock({
      getProcessIdentity: async () => "101:start",
      lockDir,
      pid: 101,
      tokenFactory: () => "first",
    }, async () => {
      started();
      await blocked;
    });
    await didStart;

    const second = withProcessLock({
      getProcessIdentity: async (pid) => pid === 101 ? "101:start" : "202:start",
      lockDir,
      pid: 202,
      tokenFactory: () => "second",
    }, async () => {});

    await expect(second).rejects.toMatchObject({ code: "already-running" });
    expect(JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")).token).toBe("first");
    unblock();
    await first;
  });

  test("takes over a dead owner in place under a recovery claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-lock-dead-"));
    const lockDir = join(root, "library.lock");
    await mkdir(lockDir);
    await writeFile(join(lockDir, "owner.json"), JSON.stringify({
      createdAt: "2020-01-01T00:00:00.000Z",
      pid: 101,
      processIdentity: "101:dead",
      schemaVersion: "process-lock.v0",
      token: "dead",
    }));
    const removedPaths: string[] = [];

    await withProcessLock({
      filesystem: {
        access,
        mkdir,
        readFile: (path) => readFile(path, "utf8"),
        rename,
        rm: async (path, options) => {
          removedPaths.push(path.toString());
          await rm(path, options);
        },
        writeFile,
      },
      getProcessIdentity: async (pid) => pid === 101 ? null : "202:start",
      lockDir,
      pid: 202,
      tokenFactory: () => "replacement",
    }, async () => {
      expect(JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")).token).toBe(
        "replacement",
      );
      await expect(access(join(lockDir, "recovery-claim"))).rejects.toThrow();
      expect(removedPaths).not.toContain(lockDir);
    });
  });

  test("exports an actionable lock error", () => {
    expect(new ProcessLockError("already-running", "busy")).toMatchObject({
      code: "already-running",
      message: "busy",
    });
  });
});
