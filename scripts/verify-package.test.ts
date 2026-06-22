import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  packAndVerifyPackage,
  validatePackedFiles,
  verifyPackedFileListsAgree,
  type CommandInvocation,
} from "./verify-package";

const validPackedFiles = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/bin/video-digest",
  "package/python/fetch_transcript.py",
  "package/python/pyproject.toml",
  "package/python/uv.lock",
  "package/docs/cli/compatibility.md",
  "package/docs/cli/exit-codes.md",
  "package/docs/cli/json-contracts.md",
  "package/.agents/skills/video-digest/SKILL.md",
  "package/.agents/skills/video-digest/agents/openai.yaml",
  "package/.agents/skills/video-digest/references/contracts.md",
  "package/src/cli/app-paths.ts",
  "package/src/cli/artifact-library.ts",
  "package/src/cli/artifacts.ts",
  "package/src/cli/config-store.ts",
  "package/src/cli/credentials.ts",
  "package/src/cli/doctor.ts",
  "package/src/cli/main.ts",
  "package/src/cli/package-resources.ts",
  "package/src/cli/parse-args.ts",
  "package/src/cli/progress-renderer.ts",
  "package/src/cli/public-contract.ts",
  "package/src/cli/runtime-manager.ts",
  "package/src/cli/system-actions.ts",
  "package/src/digest/digest.ts",
  "package/src/ingestion/ingest-video.ts",
  "package/src/ingestion/ingestion-service.ts",
  "package/src/ingestion/transcript-only.ts",
  "package/src/output/output-writer.ts",
  "package/src/output/transcript-renderer.ts",
  "package/src/storage/ingestion-record.ts",
  "package/src/storage/ingestion-repository.ts",
  "package/src/storage/process-lock.ts",
  "package/src/summarizer/opencode-summarizer.ts",
  "package/src/summarizer/summarizer.ts",
  "package/src/transcript/python-youtube-transcript-source.ts",
  "package/src/transcript/transcript-quality.ts",
  "package/src/transcript/transcript-source.ts",
  "package/src/tui/controller.ts",
  "package/src/tui/default-ports.ts",
  "package/src/tui/model.ts",
  "package/src/tui/ports.ts",
  "package/src/tui/renderer.ts",
  "package/src/tui/screens.ts",
  "package/src/tui/secret-editor.ts",
  "package/src/tui/start.ts",
  "package/src/tui/theme.ts",
  "package/src/tui/update.ts",
  "package/src/video/video-metadata-source.ts",
  "package/src/video/youtube-oembed-metadata-source.ts",
  "package/src/video/youtube-url.ts",
  "package/src/web/handler.ts",
  "package/src/web/html.ts",
  "package/src/web/ingestion-presenter.ts",
  "package/src/web/server.ts",
  "package/src/web/startup.ts",
] as const;

describe("packed-file validation", () => {
  test("accepts exactly the public package contract", () => {
    expect(validatePackedFiles([...validPackedFiles])).toEqual([...validPackedFiles].sort());
  });

  test("requires every runtime resource", () => {
    expect(() => validatePackedFiles(["package/package.json"])).toThrow(
      "Missing packed file: package/bin/video-digest",
    );
  });

  test("rejects tests and fixtures before applying source allow rules", () => {
    for (const path of [
      "package/src/cli/main.test.ts",
      "package/src/a.spec.ts",
      "package/src/__snapshots__/main.snap",
      "package/src/deep/fixtures/request.json",
    ]) {
      expect(() => validatePackedFiles([...validPackedFiles, path])).toThrow(
        `Unexpected packed file: ${path}`,
      );
    }
  });

  test("rejects unexpected, hidden, mapped, and non-runtime source files", () => {
    for (const path of [
      "package/.env",
      "package/src/.secret.ts",
      "package/src/cli/main.ts.map",
      "package/src/cli/extra.ts",
      "package/docs/cli/extra.md",
    ]) {
      expect(() => validatePackedFiles([...validPackedFiles, path])).toThrow(
        `Unexpected packed file: ${path}`,
      );
    }
  });

  test("normalizes benign archive spelling before validation", () => {
    const spelled = validPackedFiles.map((path, index) =>
      index === 0 ? `./${path}` : path.replace("package/", "package//"),
    );
    expect(validatePackedFiles(spelled)).toEqual([...validPackedFiles].sort());
  });

  test("rejects absolute, traversal, control-character, and duplicate names", () => {
    for (const path of [
      "/package/package.json",
      "package/src/../package.json",
      "package/src/evil\nname.ts",
      "C:/package/package.json",
      "\\\\server\\package\\package.json",
    ]) {
      expect(() => validatePackedFiles([...validPackedFiles, path])).toThrow();
    }
    expect(() => validatePackedFiles([...validPackedFiles, "./package/package.json"])).toThrow(
      "Duplicate packed file: package/package.json",
    );
  });

  test("requires npm and tar manifests to describe the same files", () => {
    expect(() =>
      verifyPackedFileListsAgree(validPackedFiles, validPackedFiles.slice(1)),
    ).toThrow("Packed manifests disagree");
  });
});

describe("package creation", () => {
  test("uses shell-free commands, a fresh destination, and returns cleanup ownership", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const tempRoot = await mkdtemp(join(tmpdir(), "video digest verifier tests "));
    const invocations: CommandInvocation[] = [];
    try {
      const runCommand = async (invocation: CommandInvocation) => {
        invocations.push(invocation);
        if (invocation.executable === "npm") {
          const destination = invocation.args.at(-1)!;
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, "video-digest-0.1.0.tgz"), "fixture");
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                id: "video-digest@0.1.0",
                name: "video-digest",
                version: "0.1.0",
                filename: "video-digest-0.1.0.tgz",
                files: validPackedFiles.map((path) => ({ path: path.slice("package/".length) })),
              },
            ]),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: validPackedFiles.join("\n") + "\n", stderr: "" };
      };

      const result = await packAndVerifyPackage({ repositoryRoot: root, tempRoot, runCommand });

      expect(invocations.map(({ executable, args }) => [executable, ...args])).toEqual([
        [
          "npm",
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          result.temporaryDirectory,
        ],
        ["tar", "-tzf", result.tarballPath],
      ]);
      expect(result.tarballPath).toBe(
        join(result.temporaryDirectory, "video-digest-0.1.0.tgz"),
      );
      expect(result.temporaryDirectory.startsWith(tempRoot)).toBe(true);
      await result.cleanup();
      expect(await Bun.file(result.tarballPath).exists()).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("reports failed pack commands without echoing their output", async () => {
    const secret = "npm_token=do-not-leak";
    const runCommand = async () => ({ exitCode: 1, stdout: secret, stderr: secret });
    await expect(
      packAndVerifyPackage({ repositoryRoot: process.cwd(), runCommand }),
    ).rejects.toThrow("npm pack failed with exit code 1");
    try {
      await packAndVerifyPackage({ repositoryRoot: process.cwd(), runCommand });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
