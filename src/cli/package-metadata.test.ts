import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("package metadata", () => {
  test("exposes an existing video-digest bin entrypoint", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      bin?: Record<string, string>;
      version?: string;
    };
    const binPath = packageJson.bin?.["video-digest"];

    expect(binPath).toBe("./bin/video-digest");
    await access(join(process.cwd(), binPath!));
    expect(packageJson.version).toBe("0.1.0");
  });
});
