import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { FileConfigStore, type AppConfig } from "./config-store";

const tempDirs: string[] = [];

async function makeConfigPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "video-digest-config-"));
  tempDirs.push(directory);
  return join(directory, "nested", "config.json");
}

async function writeConfigFixture(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("FileConfigStore", () => {
  test("returns null when the config file does not exist", async () => {
    const store = new FileConfigStore(await makeConfigPath());

    await expect(store.load()).resolves.toBeNull();
  });

  test("saves and loads a versioned config using private filesystem permissions", async () => {
    const path = await makeConfigPath();
    const store = new FileConfigStore(path);
    const config: AppConfig = {
      artifactLibrary: "/Users/example/Documents/Video Digest",
      schemaVersion: "config.v0",
    };

    await store.save(config);

    await expect(store.load()).resolves.toEqual(config);
    expect(await readFile(path, "utf8")).toBe(
      '{\n  "artifactLibrary": "/Users/example/Documents/Video Digest",\n  "schemaVersion": "config.v0"\n}\n',
    );
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("tightens permissions on an existing config directory", async () => {
    const path = await makeConfigPath();
    const parent = dirname(path);
    await mkdir(parent, { mode: 0o755, recursive: true });
    await chmod(parent, 0o755);

    await new FileConfigStore(path).save({
      artifactLibrary: "/tmp/library",
      schemaVersion: "config.v0",
    });

    expect((await stat(parent)).mode & 0o777).toBe(0o700);
  });

  test("rejects malformed JSON with a clear config error", async () => {
    const path = await makeConfigPath();
    await writeConfigFixture(path, "not-json");

    await expect(new FileConfigStore(path).load()).rejects.toThrow("Invalid config");
  });

  test.each([
    ["unsupported schema", { artifactLibrary: "/tmp/library", schemaVersion: "config.v1" }],
    ["missing property", { schemaVersion: "config.v0" }],
    ["extra property", { artifactLibrary: "/tmp/library", schemaVersion: "config.v0", theme: "dark" }],
  ])("rejects an invalid config shape: %s", async (_name, value) => {
    const path = await makeConfigPath();
    await writeConfigFixture(path, `${JSON.stringify(value)}\n`);

    await expect(new FileConfigStore(path).load()).rejects.toThrow("Unsupported config");
  });

  test("does not accept or persist secret fields", async () => {
    const path = await makeConfigPath();
    const store = new FileConfigStore(path);
    const configWithSecret = {
      artifactLibrary: "/tmp/library",
      schemaVersion: "config.v0",
      openCodeApiKey: "super-secret",
    } as unknown as AppConfig;

    await expect(store.save(configWithSecret)).rejects.toThrow("Unsupported config");
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("only treats ENOENT as a missing config", async () => {
    const path = await makeConfigPath();
    await writeConfigFixture(path, '{}');
    await chmod(path, 0o000);

    try {
      await expect(new FileConfigStore(path).load()).rejects.toBeDefined();
    } finally {
      await chmod(path, 0o600);
    }
  });
});
