import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectedRuntimeMarker,
  inspectRuntime,
  managedInterpreterPath,
  runtimeMarkerPath,
} from "./runtime-manager";

describe("expectedRuntimeMarker", () => {
  test("returns the SHA-256 hex digest of the lock contents", () => {
    expect(expectedRuntimeMarker("locked dependencies\n")).toBe(
      "69fab28c6ba57a6e6eb23d4f583eb30ff911e68358c2054d7d8908b21b189ee7",
    );
  });
});

describe("inspectRuntime", () => {
  const runtimeDirs: string[] = [];

  async function createRuntimeDir(): Promise<string> {
    const runtimeDir = await mkdtemp(join(tmpdir(), "video-digest-runtime-"));
    runtimeDirs.push(runtimeDir);
    return runtimeDir;
  }

  afterEach(async () => {
    await Promise.all(runtimeDirs.splice(0).map((runtimeDir) => rm(runtimeDir, { force: true, recursive: true })));
  });

  test("reports a missing managed interpreter", async () => {
    const runtimeDir = await createRuntimeDir();

    await expect(inspectRuntime(runtimeDir, "lock")).resolves.toEqual({
      remediation: "Run video-digest setup.",
      status: "missing",
    });
  });

  test("reports a missing marker", async () => {
    const runtimeDir = await createRuntimeDir();
    await mkdir(join(runtimeDir, "bin"));
    await writeFile(managedInterpreterPath(runtimeDir), "");
    await chmod(managedInterpreterPath(runtimeDir), 0o755);

    await expect(inspectRuntime(runtimeDir, "lock")).resolves.toEqual({
      remediation: "Run video-digest setup.",
      status: "missing",
    });
  });

  test("reports an obsolete marker", async () => {
    const runtimeDir = await createRuntimeDir();
    await mkdir(join(runtimeDir, "bin"));
    await writeFile(managedInterpreterPath(runtimeDir), "");
    await chmod(managedInterpreterPath(runtimeDir), 0o755);
    await writeFile(runtimeMarkerPath(runtimeDir), "old-hash\n");

    await expect(inspectRuntime(runtimeDir, "new lock")).resolves.toEqual({
      remediation: "Run video-digest setup.",
      status: "obsolete",
    });
  });

  test("reports a directory at the managed interpreter path as missing", async () => {
    const runtimeDir = await createRuntimeDir();
    const lockContents = "current lock";
    await mkdir(managedInterpreterPath(runtimeDir), { recursive: true });
    await writeFile(runtimeMarkerPath(runtimeDir), expectedRuntimeMarker(lockContents));

    await expect(inspectRuntime(runtimeDir, lockContents)).resolves.toEqual({
      remediation: "Run video-digest setup.",
      status: "missing",
    });
  });

  test("reports a non-executable managed interpreter file as missing", async () => {
    const runtimeDir = await createRuntimeDir();
    const lockContents = "current lock";
    await mkdir(join(runtimeDir, "bin"));
    await writeFile(managedInterpreterPath(runtimeDir), "");
    await chmod(managedInterpreterPath(runtimeDir), 0o000);
    await writeFile(runtimeMarkerPath(runtimeDir), expectedRuntimeMarker(lockContents));

    await expect(inspectRuntime(runtimeDir, lockContents)).resolves.toEqual({
      remediation: "Run video-digest setup.",
      status: "missing",
    });
  });

  test("reports a ready runtime when the interpreter is an executable regular file", async () => {
    const runtimeDir = await createRuntimeDir();
    const lockContents = "current lock";
    await mkdir(join(runtimeDir, "bin"));
    await writeFile(managedInterpreterPath(runtimeDir), "");
    await chmod(managedInterpreterPath(runtimeDir), 0o755);
    await writeFile(runtimeMarkerPath(runtimeDir), `${expectedRuntimeMarker(lockContents)}\n`);

    await expect(inspectRuntime(runtimeDir, lockContents)).resolves.toEqual({ status: "ready" });
  });
});
