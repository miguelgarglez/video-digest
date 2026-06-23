# CLI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable configuration, explicit Python runtime setup, and Artifact Library path resolution without implicit installation.

**Architecture:** Keep filesystem paths, configuration persistence, package-resource lookup, and runtime installation in separate modules under `src/cli`. `main.ts` composes those ports; `doctor.ts` observes readiness but never mutates state.

**Tech Stack:** Bun, TypeScript, Bun test, macOS Keychain, uv.

---

### Task 1: Application paths and versioned configuration

**Files:**
- Create: `src/cli/app-paths.ts`
- Create: `src/cli/app-paths.test.ts`
- Create: `src/cli/config-store.ts`
- Create: `src/cli/config-store.test.ts`

- [x] **Step 1: Write failing path and config-store tests**

```ts
test("uses macOS support paths and the Documents library default", () => {
  expect(resolveAppPaths("/Users/miguel")).toEqual({
    configPath: "/Users/miguel/Library/Application Support/video-digest/config.json",
    defaultArtifactLibrary: "/Users/miguel/Documents/Video Digest",
    runtimeDir: "/Users/miguel/Library/Application Support/video-digest/runtime/python",
  });
});

test("round-trips config.v0 without secrets", async () => {
  const store = new FileConfigStore(join(tempDir, "config.json"));
  await store.save({ artifactLibrary: "/tmp/library", schemaVersion: "config.v0" });
  expect(await store.load()).toEqual({ artifactLibrary: "/tmp/library", schemaVersion: "config.v0" });
  expect(await readFile(join(tempDir, "config.json"), "utf8")).not.toContain("apiKey");
});
```

- [x] **Step 2: Run the tests and verify missing-module failures**

Run: `bun test src/cli/app-paths.test.ts src/cli/config-store.test.ts`  
Expected: FAIL because both modules are missing.

- [x] **Step 3: Implement focused path and config modules**

```ts
export type AppConfig = { artifactLibrary: string; schemaVersion: "config.v0" };

export function resolveAppPaths(home: string) {
  const support = join(home, "Library", "Application Support", "video-digest");
  return {
    configPath: join(support, "config.json"),
    defaultArtifactLibrary: join(home, "Documents", "Video Digest"),
    runtimeDir: join(support, "runtime", "python"),
  };
}

export class FileConfigStore {
  constructor(private readonly path: string) {}
  async load(): Promise<AppConfig | null> {
    try { return parseConfig(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async save(config: AppConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
}

function parseConfig(value: unknown): AppConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid video-digest configuration");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== "config.v0" || typeof input.artifactLibrary !== "string") {
    throw new Error("Unsupported video-digest configuration");
  }
  return { artifactLibrary: input.artifactLibrary, schemaVersion: "config.v0" };
}
```

- [x] **Step 4: Run focused tests and typecheck**

Run: `bun test src/cli/app-paths.test.ts src/cli/config-store.test.ts && bun run typecheck`  
Expected: all tests PASS and TypeScript exits 0.

- [x] **Step 5: Commit**

```bash
git add src/cli/app-paths.ts src/cli/app-paths.test.ts src/cli/config-store.ts src/cli/config-store.test.ts
git commit -m "feat(cli): add application configuration"
```

### Task 2: Artifact Library precedence and config command

**Files:**
- Create: `src/cli/artifact-library.ts`
- Create: `src/cli/artifact-library.test.ts`
- Modify: `src/cli/parse-args.ts`
- Modify: `src/cli/parse-args.test.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/main.test.ts`

- [x] **Step 1: Write failing precedence and parsing tests**

```ts
test("resolves flag before env, config, and default", () => {
  expect(resolveArtifactLibrary({ cli: "/cli", env: "/env", saved: "/saved", fallback: "/default" })).toBe("/cli");
});

test("parses output-dir and persistent config", () => {
  expect(parseCliArgs(["list", "--output-dir", "/tmp/library"])).toMatchObject({
    ok: true, value: { command: "list", outputDir: "/tmp/library" },
  });
  expect(parseCliArgs(["config", "set", "output-dir", "/tmp/library"])).toMatchObject({
    ok: true, value: { command: "config", key: "output-dir", value: "/tmp/library" },
  });
});
```

- [x] **Step 2: Verify the tests fail**

Run: `bun test src/cli/artifact-library.test.ts src/cli/parse-args.test.ts`  
Expected: FAIL because output-directory parsing and resolution do not exist.

- [x] **Step 3: Implement the resolver and thread it through commands**

```ts
export function resolveArtifactLibrary(input: {
  cli?: string; env?: string; saved?: string; fallback: string;
}): string {
  return input.cli ?? input.env ?? input.saved ?? input.fallback;
}
```

Load `FileConfigStore` once in `runCli`, apply the documented precedence to
`ingest`, `transcript`, `list`, and `open`, and make `config get --json` return the
saved Artifact Library without exposing Keychain values.

- [x] **Step 4: Run CLI tests and typecheck**

Run: `bun test src/cli/artifact-library.test.ts src/cli/parse-args.test.ts src/cli/main.test.ts && bun run typecheck`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/cli/artifact-library.ts src/cli/artifact-library.test.ts src/cli/parse-args.ts src/cli/parse-args.test.ts src/cli/main.ts src/cli/main.test.ts
git commit -m "feat(cli): configure artifact library"
```

### Task 3: Package resources and runtime readiness

**Files:**
- Create: `src/cli/package-resources.ts`
- Create: `src/cli/package-resources.test.ts`
- Create: `src/cli/runtime-manager.ts`
- Create: `src/cli/runtime-manager.test.ts`
- Modify: `src/transcript/python-youtube-transcript-source.ts`
- Modify: `src/transcript/python-youtube-transcript-source.test.ts`

- [x] **Step 1: Write failing resource and readiness tests**

```ts
test("resolves shipped resources from a module URL", () => {
  expect(resolvePackageResources(new URL("file:///pkg/src/cli/package-resources.ts"))).toEqual({
    packageJson: "/pkg/package.json", pythonDir: "/pkg/python",
    sidecarScript: "/pkg/python/fetch_transcript.py", uvLock: "/pkg/python/uv.lock",
  });
});

test("marks a matching lock hash ready", async () => {
  const readiness = await inspectRuntime({ lockContents: "locked", markerContents: expectedRuntimeMarker("locked"), runtimePythonExists: true });
  expect(readiness).toEqual({ status: "ready" });
});
```

- [x] **Step 2: Verify the tests fail**

Run: `bun test src/cli/package-resources.test.ts src/cli/runtime-manager.test.ts`  
Expected: FAIL because the modules are missing.

- [x] **Step 3: Implement resource lookup and a pure readiness model**

```ts
export type RuntimeReadiness =
  | { status: "ready" }
  | { status: "missing"; remediation: string }
  | { status: "obsolete"; remediation: string };

export function expectedRuntimeMarker(lockContents: string): string {
  return new Bun.CryptoHasher("sha256").update(lockContents).digest("hex");
}
```

Inject resolved `pythonDir`, `sidecarScript`, and managed interpreter paths into
`PythonYoutubeTranscriptSource`; remove its repository-root calculation and prevent
`uv run` from synchronizing dependencies during normal execution.

- [x] **Step 4: Run transcript and runtime tests**

Run: `bun test src/cli/package-resources.test.ts src/cli/runtime-manager.test.ts src/transcript/python-youtube-transcript-source.test.ts && bun run typecheck`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/cli/package-resources.ts src/cli/package-resources.test.ts src/cli/runtime-manager.ts src/cli/runtime-manager.test.ts src/transcript/python-youtube-transcript-source.ts src/transcript/python-youtube-transcript-source.test.ts
git commit -m "refactor(cli): resolve packaged runtime"
```

### Task 4: Explicit setup, doctor readiness, and Keychain rename

**Files:**
- Modify: `src/cli/runtime-manager.ts`
- Modify: `src/cli/runtime-manager.test.ts`
- Modify: `src/cli/parse-args.ts`
- Modify: `src/cli/parse-args.test.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/main.test.ts`
- Modify: `src/cli/doctor.ts`
- Modify: `src/cli/doctor.test.ts`
- Modify: `src/cli/credentials.ts`
- Modify: `src/cli/credentials.test.ts`

- [x] **Step 1: Write failing setup and doctor tests**

```ts
test("setup refuses non-interactive mutation without --yes", async () => {
  expect(await runCli(["setup"], nonTtyIO, { runtimeManager: fakeRuntime })).toBe(1);
  expect(fakeRuntime.prepareCalls).toBe(0);
});

test("doctor distinguishes obsolete runtime", async () => {
  const report = await buildDoctorReport(readyProbe({ runtimeStatus: "obsolete" }));
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "python-runtime", status: "fail" }));
});
```

- [x] **Step 2: Verify the tests fail**

Run: `bun test src/cli/runtime-manager.test.ts src/cli/main.test.ts src/cli/doctor.test.ts src/cli/credentials.test.ts`  
Expected: FAIL on missing setup behavior and old Keychain service.

- [x] **Step 3: Implement atomic consented setup**

```ts
export type PrepareRuntimeInput = {
  expectedMarker: string;
  fs: {
    remove(path: string): Promise<void>;
    replaceDirectory(source: string, destination: string): Promise<void>;
    writeFile(path: string, contents: string): Promise<void>;
  };
  pythonDir: string;
  runner(command: string[], options: { env: Record<string, string> }): Promise<void>;
  runtimeDir: string;
  stagingDir: string;
};

export async function prepareRuntime(input: PrepareRuntimeInput): Promise<void> {
  await input.fs.remove(input.stagingDir);
  await input.runner(["uv", "sync", "--frozen", "--python", "3.12", "--project", input.pythonDir], {
    env: { UV_PROJECT_ENVIRONMENT: input.stagingDir },
  });
  await input.fs.writeFile(join(input.stagingDir, ".video-digest-lock"), input.expectedMarker);
  await input.fs.replaceDirectory(input.stagingDir, input.runtimeDir);
}
```

Parse `setup [--yes]`, show the exact mutation before prompting, and call the runtime
manager only after affirmative input or `--yes`. Change `KEYCHAIN_SERVICE` to
`video-digest` with no legacy fallback. Add runtime readiness to human and JSON doctor
reports. `setup --yes --json` emits exactly
`{"schemaVersion":"setup-result.v0","status":"ready"}` on stdout; a refused or
failed setup uses the same schema with a stable error object.

- [x] **Step 4: Run the complete phase verification**

Run: `bun test src/cli src/transcript/python-youtube-transcript-source.test.ts && bun run typecheck`  
Expected: PASS with zero failed tests.

- [x] **Step 5: Commit**

```bash
git add src/cli src/transcript/python-youtube-transcript-source.ts src/transcript/python-youtube-transcript-source.test.ts
git commit -m "feat(cli): add explicit runtime setup"
```
