import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
  test("reports a missing managed interpreter", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "video-digest-runtime-"));

    await expect(inspectRuntime(runtimeDir, "lock")).resolves.toEqual({
      remediation: "Run video-digest setup.",
      status: "missing",
    });
  });

  test("reports a missing marker", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "video-digest-runtime-"));
    await mkdir(join(runtimeDir, "bin"));
    await writeFile(managedInterpreterPath(runtimeDir), "");

    await expect(inspectRuntime(runtimeDir, "lock")).resolves.toEqual({
      remediation: "Run video-digest setup.",
      status: "missing",
    });
  });

  test("reports an obsolete marker", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "video-digest-runtime-"));
    await mkdir(join(runtimeDir, "bin"));
    await writeFile(managedInterpreterPath(runtimeDir), "");
    await writeFile(runtimeMarkerPath(runtimeDir), "old-hash\n");

    await expect(inspectRuntime(runtimeDir, "new lock")).resolves.toEqual({
      remediation: "Run video-digest setup.",
      status: "obsolete",
    });
  });

  test("reports a ready runtime when the interpreter and current marker exist", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "video-digest-runtime-"));
    const lockContents = "current lock";
    await mkdir(join(runtimeDir, "bin"));
    await writeFile(managedInterpreterPath(runtimeDir), "");
    await writeFile(runtimeMarkerPath(runtimeDir), `${expectedRuntimeMarker(lockContents)}\n`);

    await expect(inspectRuntime(runtimeDir, lockContents)).resolves.toEqual({ status: "ready" });
  });
});
