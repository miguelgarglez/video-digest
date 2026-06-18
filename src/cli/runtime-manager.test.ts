import { afterEach, describe, expect, test } from "bun:test";
import { access, chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectedRuntimeMarker,
  inspectRuntime,
  managedInterpreterPath,
  prepareRuntime,
  runtimeMarkerPath,
} from "./runtime-manager";

describe("prepareRuntime", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  test("builds in staging with frozen Python 3.12 dependencies and atomically installs it", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-prepare-"));
    roots.push(root);
    const runtimeDir = join(root, "python");
    const pythonDir = join(root, "package-python");
    const calls: Array<{ command: string[]; options: { cwd: string; env: Record<string, string> } }> = [];
    await mkdir(pythonDir);

    await prepareRuntime({
      lockContents: "locked\n",
      pythonDir,
      runtimeDir,
      runner: async (command, options) => {
        calls.push({ command, options });
        await mkdir(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin"), { recursive: true });
        await writeFile(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin", "python"), "python");
        await chmod(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin", "python"), 0o755);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      uvPath: "/fake/uv",
    });

    expect(calls).toEqual([{
      command: ["/fake/uv", "sync", "--frozen", "--python", "3.12", "--project", pythonDir],
      options: {
        cwd: pythonDir,
        env: { UV_PROJECT_ENVIRONMENT: `${runtimeDir}.staging` },
      },
    }]);
    expect(await readFile(runtimeMarkerPath(runtimeDir), "utf8")).toBe(expectedRuntimeMarker("locked\n"));
    expect(await readFile(managedInterpreterPath(runtimeDir), "utf8")).toBe("python");
  });

  test("preserves the existing runtime and does not write a marker when uv fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-prepare-"));
    roots.push(root);
    const runtimeDir = join(root, "python");
    await mkdir(runtimeDir);
    await writeFile(join(runtimeDir, "sentinel"), "existing");

    await expect(prepareRuntime({
      lockContents: "new lock",
      pythonDir: join(root, "package-python"),
      runtimeDir,
      runner: async () => ({ exitCode: 1, stderr: "uv failed with secret-token", stdout: "" }),
      uvPath: "uv",
    })).rejects.toThrow("uv failed with secret-token");

    expect(await readFile(join(runtimeDir, "sentinel"), "utf8")).toBe("existing");
    await expect(readFile(runtimeMarkerPath(runtimeDir), "utf8")).rejects.toThrow();
  });

  test("restores the existing runtime when the atomic staging swap fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-prepare-"));
    roots.push(root);
    const runtimeDir = join(root, "python");
    const stagingDir = `${runtimeDir}.staging`;
    await mkdir(runtimeDir);
    await writeFile(join(runtimeDir, "sentinel"), "existing");

    await expect(prepareRuntime({
      filesystem: {
        access,
        mkdir,
        rename: async (from, to) => {
          if (from === stagingDir && to === runtimeDir) throw new Error("swap failed");
          await rename(from, to);
        },
        rm,
        writeFile,
      },
      lockContents: "new lock",
      pythonDir: join(root, "package-python"),
      runtimeDir,
      runner: async (_command, options) => {
        await mkdir(options.env.UV_PROJECT_ENVIRONMENT!, { recursive: true });
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      uvPath: "uv",
    })).rejects.toThrow("swap failed");

    expect(await readFile(join(runtimeDir, "sentinel"), "utf8")).toBe("existing");
  });
});

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
