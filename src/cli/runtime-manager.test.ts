import { afterEach, describe, expect, test } from "bun:test";
import { access, chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectedRuntimeMarker,
  buildRuntimeCommandEnvironment,
  inspectRuntime,
  managedInterpreterPath,
  prepareRuntime,
  runtimeMarkerPath,
  resolveUvExecutable,
  RuntimeSetupError,
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
      idFactory: () => "test",
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
        env: { UV_PROJECT_ENVIRONMENT: `${runtimeDir}.staging-test` },
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

  test("rejects a successful uv run that did not create an executable interpreter", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-prepare-")); roots.push(root);
    const runtimeDir = join(root, "python"); await mkdir(runtimeDir); await writeFile(join(runtimeDir, "sentinel"), "existing");
    await expect(prepareRuntime({ idFactory: () => "one", lockContents: "lock", pythonDir: root, runtimeDir,
      runner: async (_command, options) => { await mkdir(options.env.UV_PROJECT_ENVIRONMENT!); return { exitCode: 0, stderr: "", stdout: "" }; }, uvPath: "uv" })).rejects.toThrow("not ready");
    expect(await readFile(join(runtimeDir, "sentinel"), "utf8")).toBe("existing");
  });

  test("uses an exclusive lock and does not disturb an active setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-prepare-")); roots.push(root);
    const runtimeDir = join(root, "python"); let release!: () => void; let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const first = prepareRuntime({ idFactory: () => "first", pid: 111, clock: () => new Date("2026-01-01T00:00:00Z"), lockContents: "lock", pythonDir: root, runtimeDir,
      runner: async (_command, options) => { await mkdir(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin"), { recursive: true }); await writeFile(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin/python"), ""); await chmod(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin/python"), 0o755); markStarted(); await blocked; return { exitCode: 0, stderr: "", stdout: "" }; }, uvPath: "uv" });
    await started;
    expect(JSON.parse(await readFile(join(`${runtimeDir}.setup-lock`, "owner.json"), "utf8"))).toEqual({ schemaVersion: "runtime-setup-lock.v1", pid: 111, token: "first", stagingDir: `${runtimeDir}.staging-first`, backupDir: `${runtimeDir}.backup-first`, createdAt: "2026-01-01T00:00:00.000Z", leaseExpiresAt: "2026-01-01T00:01:00.000Z" });
    await expect(prepareRuntime({ idFactory: () => "second", clock: () => new Date("2026-01-01T00:00:30Z"), lockContents: "lock", pythonDir: root, runtimeDir,
      runner: async () => { throw new Error("must not run"); }, uvPath: "uv" })).rejects.toThrow("already in progress");
    expect(await readFile(join(`${runtimeDir}.staging-first`, "bin/python"), "utf8")).toBe("");
    release(); await first;
  });

  test("restores the existing runtime when the atomic staging swap fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-prepare-"));
    roots.push(root);
    const runtimeDir = join(root, "python");
    const stagingDir = `${runtimeDir}.staging-test`;
    await mkdir(runtimeDir);
    await writeFile(join(runtimeDir, "sentinel"), "existing");

    await expect(prepareRuntime({
      idFactory: () => "test",
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
        await mkdir(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin"), { recursive: true });
        await writeFile(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin/python"), "");
        await chmod(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin/python"), 0o755);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      uvPath: "uv",
    })).rejects.toThrow("swap failed");

    expect(await readFile(join(runtimeDir, "sentinel"), "utf8")).toBe("existing");
  });

  test("rolls back when final runtime validation fails after the swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-prepare-")); roots.push(root);
    const runtimeDir = join(root, "python"); await mkdir(runtimeDir); await writeFile(join(runtimeDir, "sentinel"), "existing");
    await expect(prepareRuntime({ idFactory: () => "post", lockContents: "lock", pythonDir: root, runtimeDir, uvPath: "uv",
      filesystem: { access, mkdir, rm, writeFile, rename: async (from, to) => { await rename(from, to); if (to === runtimeDir && String(from).includes("staging")) await chmod(managedInterpreterPath(runtimeDir), 0o000); } },
      runner: async (_command, options) => { await mkdir(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin"), { recursive: true }); await writeFile(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin/python"), ""); await chmod(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin/python"), 0o755); return { exitCode: 0, stderr: "", stdout: "" }; },
    })).rejects.toThrow("Installed Python runtime is not ready");
    expect(await readFile(join(runtimeDir, "sentinel"), "utf8")).toBe("existing");
  });

  test("preserves backup and reports recovery path when swap and restoration both fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-prepare-")); roots.push(root);
    const runtimeDir = join(root, "python"); const backupDir = `${runtimeDir}.backup-broken`;
    await mkdir(runtimeDir); await writeFile(join(runtimeDir, "sentinel"), "existing");
    const error = await prepareRuntime({ idFactory: () => "broken", lockContents: "lock", pythonDir: root, runtimeDir, uvPath: "uv",
      filesystem: { access, mkdir, rm, writeFile, rename: async (from, to) => { if (String(from).includes("staging") || from === backupDir) throw new Error("rename secret"); await rename(from, to); } },
      runner: async (_command, options) => { await mkdir(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin"), { recursive: true }); await writeFile(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin/python"), ""); await chmod(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin/python"), 0o755); return { exitCode: 0, stderr: "", stdout: "" }; },
    }).catch((value) => value);
    expect(error).toBeInstanceOf(RuntimeSetupError);
    expect(error.message).toContain(backupDir);
    expect(error.message).not.toContain("secret");
    expect(await readFile(join(backupDir, "sentinel"), "utf8")).toBe("existing");
  });

  test("recovers a dead owner's orphan backup before a new setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-prepare-")); roots.push(root);
    const runtimeDir = join(root, "python"); const lockDir = `${runtimeDir}.setup-lock`;
    const stagingDir = `${runtimeDir}.staging-dead`; const backupDir = `${runtimeDir}.backup-dead`;
    await mkdir(lockDir); await mkdir(stagingDir); await mkdir(backupDir); await writeFile(join(backupDir, "sentinel"), "recovered");
    await writeFile(join(lockDir, "owner.json"), JSON.stringify({ schemaVersion: "runtime-setup-lock.v1", pid: 123, token: "dead", stagingDir, backupDir, createdAt: "2020-01-01T00:00:00.000Z", leaseExpiresAt: "2020-01-01T00:01:00.000Z" }));
    await expect(prepareRuntime({ idFactory: () => "new", pid: 456, clock: () => new Date("2026-01-01"), lockContents: "lock", pythonDir: root, runtimeDir, uvPath: "uv", runner: async () => ({ exitCode: 1, stderr: "stop", stdout: "" }) })).rejects.toThrow("stop");
    expect(await readFile(join(runtimeDir, "sentinel"), "utf8")).toBe("recovered");
    await expect(access(stagingDir)).rejects.toThrow();
  });

  test("atomically claims and removes a stale lock with no published owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-prepare-")); roots.push(root);
    const runtimeDir = join(root, "python"); await mkdir(`${runtimeDir}.setup-lock`);
    await expect(prepareRuntime({ idFactory: () => "fresh", clock: () => new Date(Date.now() + 600_000), lockContents: "lock", pythonDir: root, runtimeDir, uvPath: "uv", runner: async () => ({ exitCode: 1, stderr: "continued", stdout: "" }) })).rejects.toThrow("continued");
    await expect(access(`${runtimeDir}.setup-lock.claim-fresh`)).rejects.toThrow();
  });

  test("two stale recoverers yield one live owner and never delete its lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-prepare-")); roots.push(root); const runtimeDir = join(root, "python"); const lockDir = `${runtimeDir}.setup-lock`;
    await mkdir(lockDir); await writeFile(join(lockDir, "owner.json"), JSON.stringify({ schemaVersion: "runtime-setup-lock.v1", pid: 1, token: "old", stagingDir: `${runtimeDir}.staging-old`, backupDir: `${runtimeDir}.backup-old`, createdAt: "2020-01-01T00:00:00.000Z", leaseExpiresAt: "2020-01-01T00:01:00.000Z" }));
    let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; }); let runningToken = "";
    const launch = (token: string) => prepareRuntime({ idFactory: () => token, clock: () => new Date("2026-01-01"), lockContents: "lock", pythonDir: root, runtimeDir, uvPath: "uv", runner: async (_command, options) => { runningToken = token; await mkdir(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin"), { recursive: true }); await writeFile(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin/python"), ""); await chmod(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin/python"), 0o755); await blocked; return { exitCode: 0, stderr: "", stdout: "" }; } });
    const attempts = [launch("a"), launch("b")];
    const loser = await Promise.race(attempts.map((attempt) => attempt.then(() => null, (error) => error)));
    expect(loser).toBeInstanceOf(RuntimeSetupError); expect(loser.code).toBe("already-running");
    let liveOwner: { token: string } | undefined;
    while (!liveOwner || !runningToken) { try { liveOwner = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")); } catch {} if (!liveOwner || !runningToken) await new Promise((resolve) => setTimeout(resolve, 0)); }
    expect(liveOwner.token).toBe(runningToken);
    release(); const settled = await Promise.allSettled(attempts); expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  });

  test("atomically preserves malformed owner metadata for manual recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-prepare-")); roots.push(root); const runtimeDir = join(root, "python"); const lockDir = `${runtimeDir}.setup-lock`;
    await mkdir(lockDir); await writeFile(join(lockDir, "owner.json"), "{broken");
    const error = await prepareRuntime({ idFactory: () => "claim", lockContents: "lock", pythonDir: root, runtimeDir, uvPath: "uv", runner: async () => { throw new Error("must not run"); } }).catch((value) => value);
    expect(error).toBeInstanceOf(RuntimeSetupError); expect(error.code).toBe("recovery-required");
    expect(await readFile(join(`${lockDir}.claim-claim`, "owner.json"), "utf8")).toBe("{broken");
  });

  test("renews the published lease through the heartbeat and stops it before unlock", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-digest-prepare-")); roots.push(root); const runtimeDir = join(root, "python"); let now = new Date("2026-01-01T00:00:00Z"); let renew!: () => Promise<void>; let stopped = false; let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const setup = prepareRuntime({ idFactory: () => "beat", clock: () => now, heartbeatFactory: (callback) => { renew = callback; return { stop: async () => { stopped = true; } }; }, lockContents: "lock", pythonDir: root, runtimeDir, uvPath: "uv", runner: async (_command, options) => { await mkdir(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin"), { recursive: true }); await writeFile(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin/python"), ""); await chmod(join(options.env.UV_PROJECT_ENVIRONMENT!, "bin/python"), 0o755); await blocked; return { exitCode: 0, stderr: "", stdout: "" }; } });
    while (!renew) await new Promise((resolve) => setTimeout(resolve, 0));
    now = new Date("2026-01-01T00:00:30Z"); await renew();
    expect(JSON.parse(await readFile(join(`${runtimeDir}.setup-lock`, "owner.json"), "utf8")).leaseExpiresAt).toBe("2026-01-01T00:01:30.000Z");
    release(); await setup; expect(stopped).toBe(true);
  });
});

test("buildRuntimeCommandEnvironment allowlists operational variables and excludes secrets", () => {
  expect(buildRuntimeCommandEnvironment({ PATH: "/bin", HOME: "/home", OPENCODE_API_KEY: "secret", ARBITRARY_SECRET: "no" }, "/stage")).toEqual({
    HOME: "/home", PATH: "/bin", UV_PROJECT_ENVIRONMENT: "/stage",
  });
});

test("resolveUvExecutable defaults to uv and honors only explicit UV_BIN", () => {
  expect(resolveUvExecutable({ HOME: "/home" })).toBe("uv");
  expect(resolveUvExecutable({ HOME: "/home", UV_BIN: "/custom/uv" })).toBe("/custom/uv");
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
