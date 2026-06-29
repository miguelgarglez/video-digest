import { lstat, mkdir, mkdtemp, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createDigest } from "../digest/digest";
import type { Transcript } from "../transcript/transcript-source";
import type { TranscriptQuality } from "../transcript/transcript-quality";
import type { YouTubeVideo } from "../video/youtube-url";
import {
  OutputRecoveryError,
  recoverPendingOutputTransactions,
  withRecoveredOutputLibrary,
  writeFailedIngestionMetadata,
  writeIngestionOutputs,
  writeTranscriptOnlyOutputs,
} from "./output-writer";

describe("writeIngestionOutputs", () => {
  test("writes versioned transcript, digest, metadata, and email preview files", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-"));

    const result = await writeIngestionOutputs({
      digest,
      emailPreview: true,
      generation,
      outputDir,
      transcript,
      transcriptQuality: warningQuality,
      video,
    });

    expect(result).toEqual({
      digestPath: join(outputDir, "digests", "1ZgUcrR0K7I.md"),
      emailPreviewPath: join(outputDir, "emails", "1ZgUcrR0K7I.md"),
      metadataPath: join(outputDir, "metadata", "1ZgUcrR0K7I.json"),
      transcriptJsonPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.json"),
      transcriptMarkdownPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.md"),
      transcriptTextPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.txt"),
    });

    expect(await readFile(result.transcriptJsonPath, "utf8")).toBe(
      `${JSON.stringify(transcript, null, 2)}\n`,
    );
    const transcriptJson = JSON.parse(await readFile(result.transcriptJsonPath, "utf8"));
    expect(transcriptJson.schemaVersion).toBe("transcript.v0");
    expect(await readFile(result.transcriptMarkdownPath, "utf8")).toBe(
      [
        "# Transcript 1ZgUcrR0K7I",
        "",
        `URL: ${video.canonicalUrl}`,
        "Language: en",
        "Source: youtube-transcript-api",
        "Provenance: unknown",
        "",
        "## Transcript",
        "",
        "**00:00** Technology can change media businesses.",
        "",
      ].join("\n"),
    );
    expect(await readFile(result.transcriptTextPath, "utf8")).toBe(
      "Technology can change media businesses.\n",
    );

    const metadataJson = JSON.parse(await readFile(result.metadataPath, "utf8"));
    expect(metadataJson).toMatchObject({
      digest: {
        schemaVersion: "digest.v0",
      },
      generation,
      metadataSchemaVersion: "metadata.v1",
      transcriptQuality: {
        status: "warning",
        warnings: ["low-segment-count"],
      },
      video: {
        channel: null,
        durationSeconds: 5,
        videoId: "1ZgUcrR0K7I",
        videoTitle: null,
      },
      videoDigestVersion: "0.2.0",
    });
    expect(JSON.stringify(metadataJson)).not.toContain("test-secret");

    const markdown = await readFile(result.digestPath, "utf8");
    expect(markdown).toContain("# Generated Digest Title");
    expect(markdown).toContain("## Transcript warnings");
    expect(markdown).toContain("- low-segment-count");

    const email = await readFile(result.emailPreviewPath!, "utf8");
    expect(email).toContain("Subject: Generated Digest Title");
  });

  test("does not write email preview unless requested", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-"));

    const result = await writeIngestionOutputs({
      digest,
      emailPreview: false,
      outputDir,
      transcript,
      transcriptQuality: usableQuality,
      video,
    });

    expect(result.emailPreviewPath).toBeNull();
  });

  test("renames metadata after every other entry file", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-order-"));
    const renamedDestinations: string[] = [];

    await writeIngestionOutputs(
      {
        digest,
        emailPreview: true,
        outputDir,
        transcript,
        transcriptQuality: usableQuality,
        video,
      },
      {
        rename: async (from, to) => {
          renamedDestinations.push(to);
          await rename(from, to);
        },
        unlink,
        writeFile,
      },
    );

    expect(renamedDestinations.filter((path) => !path.includes("/.transactions/")).at(-1)).toBe(
      join(outputDir, "metadata", "1ZgUcrR0K7I.json"),
    );
  });

  test("publishes a valid manifest before the first canonical rename", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-manifest-order-"));
    let manifestAtFirstCanonicalRename: unknown;

    await writeIngestionOutputs(
      {
        digest,
        emailPreview: false,
        outputDir,
        transcript,
        transcriptQuality: usableQuality,
        video,
      },
      {
        rename: async (from, to) => {
          if (!from.includes("/.transactions/") && manifestAtFirstCanonicalRename === undefined) {
            const names = (await readdir(join(outputDir, ".transactions")))
              .filter((name) => name.endsWith(".json"));
            manifestAtFirstCanonicalRename = JSON.parse(
              await readFile(join(outputDir, ".transactions", names[0]!), "utf8"),
            );
          }
          await rename(from, to);
        },
      },
    );

    expect(manifestAtFirstCanonicalRename).toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          hadOriginal: false,
          targetPath: join(outputDir, "transcripts", `${video.videoId}.json`),
        }),
      ]),
      schemaVersion: "output-transaction.v0",
      state: "prepared",
      videoId: video.videoId,
    });
  });

  test("commits metadata last and cleans temporary siblings after a write failure", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-failure-"));
    const renamedDestinations: string[] = [];
    const cleanedPaths: string[] = [];

    await expect(
      writeIngestionOutputs(
        {
          digest,
          emailPreview: false,
          outputDir,
          transcript,
          transcriptQuality: usableQuality,
          video,
        },
        {
          rename: async (from, to) => {
            renamedDestinations.push(to);
            await rename(from, to);
          },
          unlink: async (path) => {
            cleanedPaths.push(path);
            await unlink(path).catch(() => undefined);
          },
          writeFile: async (path, contents) => {
            if (path.includes("digests") && path.endsWith(".tmp")) {
              throw new Error("simulated write failure");
            }
            if (path.endsWith(".txt") || path.includes(".txt.")) {
              await Bun.sleep(20);
            }
            await writeFile(path, contents);
          },
        },
      ),
    ).rejects.toThrow("simulated write failure");

    expect(renamedDestinations).not.toContain(join(outputDir, "metadata", "1ZgUcrR0K7I.json"));
    expect(cleanedPaths.length).toBeGreaterThan(0);
    expect(cleanedPaths.every((path) => path.endsWith(".tmp"))).toBe(true);
    await Bun.sleep(30);
    expect((await readdir(outputDir, { recursive: true })).filter((path) => path.endsWith(".tmp")))
      .toEqual([]);
  });

  test("restores every previous artifact when replacement fails after installation starts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-rollback-"));
    const oldArtifacts = artifactContents(outputDir);
    await seedArtifacts(oldArtifacts);
    let installedCount = 0;

    await expect(
      writeIngestionOutputs(
        {
          digest,
          emailPreview: true,
          outputDir,
          transcript,
          transcriptQuality: usableQuality,
          video,
        },
        {
          rename: async (from, to) => {
            if (from.endsWith(".tmp")) {
              installedCount += 1;
              if (installedCount === 2) throw new Error("simulated install failure");
            }
            await rename(from, to);
          },
          unlink,
          writeFile,
        },
      ),
    ).rejects.toThrow("simulated install failure");

    expect(installedCount).toBe(2);
    for (const [path, contents] of oldArtifacts) {
      expect(await readFile(path, "utf8")).toBe(contents);
    }
    expect(
      (await readdir(outputDir, { recursive: true })).filter(
        (path) => path.endsWith(".tmp") || path.endsWith(".backup"),
      ),
    ).toEqual([]);
  });

  test("removes a stale email preview when a later ingest disables it", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-stale-email-"));
    const emailPath = join(outputDir, "emails", `${video.videoId}.md`);

    await writeIngestionOutputs({
      digest,
      emailPreview: true,
      outputDir,
      transcript,
      transcriptQuality: usableQuality,
      video,
    });
    expect(await readFile(emailPath, "utf8")).toContain("Subject:");

    await writeIngestionOutputs({
      digest,
      emailPreview: false,
      outputDir,
      transcript,
      transcriptQuality: usableQuality,
      video,
    });

    await expect(readFile(emailPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("restores a stale email when an ingest without preview rolls back", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-stale-email-rollback-"));
    const emailPath = join(outputDir, "emails", `${video.videoId}.md`);
    await mkdir(dirname(emailPath), { recursive: true });
    await writeFile(emailPath, "previous email\n");
    let installedCount = 0;

    await expect(
      writeIngestionOutputs(
        {
          digest,
          emailPreview: false,
          outputDir,
          transcript,
          transcriptQuality: usableQuality,
          video,
        },
        {
          rename: async (from, to) => {
            if (from.endsWith(".tmp") && ++installedCount === 2) {
              throw new Error("simulated install failure");
            }
            await rename(from, to);
          },
        },
      ),
    ).rejects.toThrow("simulated install failure");

    expect(await readFile(emailPath, "utf8")).toBe("previous email\n");
    expect(
      (await readdir(outputDir, { recursive: true })).filter(
        (path) => path.endsWith(".tmp") || path.endsWith(".backup"),
      ),
    ).toEqual([]);
  });

  test("preserves and reports a backup whose restoration fails", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-recovery-error-"));
    const oldArtifacts = artifactContents(outputDir);
    await seedArtifacts(oldArtifacts);
    let installedCount = 0;
    let unrestoredBackupPath = "";

    const promise = writeIngestionOutputs(
      {
        digest,
        emailPreview: true,
        outputDir,
        transcript,
        transcriptQuality: usableQuality,
        video,
      },
      {
        rename: async (from, to) => {
          if (from.endsWith(".tmp") && ++installedCount === 2) {
            throw new Error("simulated install failure");
          }
          if (from.endsWith(".backup") && to.endsWith(".json") && to.includes("transcripts")) {
            unrestoredBackupPath = from;
            throw new Error("simulated restore failure");
          }
          await rename(from, to);
        },
      },
    );

    const error = await promise.catch((caught) => caught);
    expect(error).toBeInstanceOf(OutputRecoveryError);
    expect(error.preservedBackupPaths).toEqual([unrestoredBackupPath]);
    expect(error.message).toContain("Restore these files manually");
    expect(await readFile(unrestoredBackupPath, "utf8")).toBe("old transcript json\n");
    const leftovers = (await readdir(outputDir, { recursive: true })).filter(
      (path) => path.endsWith(".tmp") || path.endsWith(".backup"),
    );
    expect(leftovers).toEqual([unrestoredBackupPath.slice(outputDir.length + 1)]);
  });

  test("restores old artifacts when the committed manifest rewrite is interrupted", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-commit-rewrite-"));
    const oldArtifacts = artifactContents(outputDir);
    await seedArtifacts(oldArtifacts);

    await expect(
      writeIngestionOutputs(
        {
          digest,
          emailPreview: true,
          outputDir,
          transcript,
          transcriptQuality: usableQuality,
          video,
        },
        {
          rename: async (from, to) => {
            if (from.includes("/.transactions/") && from.endsWith(".commit.tmp")) {
              throw new Error("simulated commit manifest interruption");
            }
            await rename(from, to);
          },
        },
      ),
    ).rejects.toThrow("simulated commit manifest interruption");

    for (const [path, contents] of oldArtifacts) {
      expect(await readFile(path, "utf8")).toBe(contents);
    }
    expect(
      (await readdir(outputDir, { recursive: true })).filter(
        (path) => path.endsWith(".tmp") || path.endsWith(".backup") || path.endsWith(".json.tmp"),
      ),
    ).toEqual([]);
  });

  test("does not let recovery inspect an active writer transaction", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-active-writer-"));
    let unblock!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const first = writeIngestionOutputs(
      { digest, emailPreview: false, outputDir, transcript, transcriptQuality: usableQuality, video },
      {
        rename: async (from, to) => {
          if (!from.includes("/.transactions/") && from.endsWith(".tmp")) {
            markStarted();
            await blocked;
          }
          await rename(from, to);
        },
      },
    );
    await started;

    await expect(recoverPendingOutputTransactions(outputDir)).rejects.toMatchObject({
      code: "already-running",
    });
    await expect(writeTranscriptOnlyOutputs({
      outputDir,
      transcript,
      transcriptQuality: usableQuality,
      video,
    })).rejects.toMatchObject({ code: "already-running" });
    let discovered = false;
    await expect(withRecoveredOutputLibrary(outputDir, async () => {
      discovered = true;
    })).rejects.toMatchObject({ code: "already-running" });
    expect(discovered).toBe(false);

    unblock();
    await first;
  });
});

describe("recoverPendingOutputTransactions", () => {
  test("rejects a symlinked library lock without mutating its external owner", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-lock-symlink-"));
    const transactionDir = join(outputDir, ".transactions");
    const external = await mkdtemp(join(tmpdir(), "video-digest-lock-owner-"));
    const ownerPath = join(external, "owner.json");
    const owner = JSON.stringify({
      createdAt: "2020-01-01T00:00:00.000Z",
      pid: 999999,
      processIdentity: "dead",
      schemaVersion: "process-lock.v0",
      token: "external",
    });
    await mkdir(transactionDir, { recursive: true });
    await writeFile(ownerPath, owner);
    await symlink(external, join(transactionDir, "library.lock"));

    await expect(recoverPendingOutputTransactions(outputDir)).rejects.toMatchObject({
      code: "recovery-required",
    });
    expect(await readFile(ownerPath, "utf8")).toBe(owner);
    expect(await readdir(external)).toEqual(["owner.json"]);
  });

  test("restores an interrupted transaction and is idempotent", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-interrupted-"));
    const token = "11111111-1111-4111-8111-111111111111";
    const transactionDir = join(outputDir, ".transactions");
    const manifestPath = join(transactionDir, `${token}.json`);
    const jsonPath = join(outputDir, "transcripts", `${video.videoId}.json`);
    const markdownPath = join(outputDir, "transcripts", `${video.videoId}.md`);
    const textPath = join(outputDir, "transcripts", `${video.videoId}.txt`);
    const jsonBackupPath = `${jsonPath}.${token}.backup`;
    const jsonTempPath = `${jsonPath}.${token}.tmp`;
    const markdownBackupPath = `${markdownPath}.${token}.backup`;
    const markdownTempPath = `${markdownPath}.${token}.tmp`;
    const textBackupPath = `${textPath}.${token}.backup`;
    const textTempPath = `${textPath}.${token}.tmp`;

    await Promise.all([
      mkdir(transactionDir, { recursive: true }),
      mkdir(dirname(jsonPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(jsonPath, "new json\n"),
      writeFile(jsonBackupPath, "old json\n"),
      writeFile(jsonTempPath, "staged json\n"),
      writeFile(markdownPath, "new markdown\n"),
      writeFile(markdownTempPath, "staged markdown\n"),
      writeFile(textPath, "old text\n"),
      writeFile(textTempPath, "staged text\n"),
      writeFile(
        manifestPath,
        `${JSON.stringify({
          artifacts: [
            {
              backupPath: jsonBackupPath,
              hadOriginal: true,
              targetPath: jsonPath,
              tempPath: jsonTempPath,
            },
            {
              backupPath: markdownBackupPath,
              hadOriginal: false,
              targetPath: markdownPath,
              tempPath: markdownTempPath,
            },
            {
              backupPath: textBackupPath,
              hadOriginal: true,
              targetPath: textPath,
              tempPath: textTempPath,
            },
          ],
          schemaVersion: "output-transaction.v0",
          state: "prepared",
          token,
          videoId: video.videoId,
        }, null, 2)}\n`,
      ),
    ]);

    await recoverPendingOutputTransactions(outputDir);
    await recoverPendingOutputTransactions(outputDir);

    expect(await readFile(jsonPath, "utf8")).toBe("old json\n");
    expect(await readFile(textPath, "utf8")).toBe("old text\n");
    await expect(readFile(markdownPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    for (const ownedPath of [
      jsonBackupPath,
      jsonTempPath,
      markdownBackupPath,
      markdownTempPath,
      textBackupPath,
      textTempPath,
      manifestPath,
    ]) {
      await expect(readFile(ownedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("rejects an unsafe manifest without deleting any path", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-unsafe-manifest-"));
    const unrelatedDir = await mkdtemp(join(tmpdir(), "video-digest-unrelated-"));
    const unrelatedPath = join(unrelatedDir, "keep.txt");
    const token = "22222222-2222-4222-8222-222222222222";
    const transactionDir = join(outputDir, ".transactions");
    const manifestPath = join(transactionDir, `${token}.json`);
    await mkdir(transactionDir, { recursive: true });
    await writeFile(unrelatedPath, "do not delete\n");
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        artifacts: [{
          backupPath: `${unrelatedPath}.${token}.backup`,
          hadOriginal: false,
          targetPath: unrelatedPath,
          tempPath: `${unrelatedPath}.${token}.tmp`,
        }],
        schemaVersion: "output-transaction.v0",
        state: "prepared",
        token,
        videoId: video.videoId,
      })}\n`,
    );

    const error = await recoverPendingOutputTransactions(outputDir).catch((caught) => caught);

    expect(error).toBeInstanceOf(OutputRecoveryError);
    expect(error.message).toContain("unsafe output transaction manifest");
    expect(await readFile(unrelatedPath, "utf8")).toBe("do not delete\n");
    expect(await readFile(manifestPath, "utf8")).toContain(token);
  });

  test("rejects an unexpected manifest schema without touching its target", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-schema-manifest-"));
    const token = "33333333-3333-4333-8333-333333333333";
    const targetPath = join(outputDir, "transcripts", `${video.videoId}.txt`);
    const transactionDir = join(outputDir, ".transactions");
    const manifestPath = join(transactionDir, `${token}.json`);
    await Promise.all([
      mkdir(dirname(targetPath), { recursive: true }),
      mkdir(transactionDir, { recursive: true }),
    ]);
    await writeFile(targetPath, "keep target\n");
    await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: "output-transaction.v99" })}\n`);

    await expect(recoverPendingOutputTransactions(outputDir)).rejects.toBeInstanceOf(
      OutputRecoveryError,
    );
    expect(await readFile(targetPath, "utf8")).toBe("keep target\n");
    expect(await readFile(manifestPath, "utf8")).toContain("output-transaction.v99");
  });

  test("finishes a committed transaction without restoring partially deleted backups", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-committed-"));
    const token = "44444444-4444-4444-8444-444444444444";
    const transactionDir = join(outputDir, ".transactions");
    const manifestPath = join(transactionDir, `${token}.json`);
    const jsonPath = join(outputDir, "transcripts", `${video.videoId}.json`);
    const textPath = join(outputDir, "transcripts", `${video.videoId}.txt`);
    const jsonBackupPath = `${jsonPath}.${token}.backup`;
    const jsonTempPath = `${jsonPath}.${token}.tmp`;
    const textBackupPath = `${textPath}.${token}.backup`;
    const textTempPath = `${textPath}.${token}.tmp`;
    await Promise.all([
      mkdir(transactionDir, { recursive: true }),
      mkdir(dirname(jsonPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(jsonPath, "new json\n"),
      writeFile(textPath, "new text\n"),
      writeFile(jsonBackupPath, "old json\n"),
      writeFile(jsonTempPath, "staged json\n"),
      writeFile(textTempPath, "staged text\n"),
      writeFile(manifestPath, `${JSON.stringify({
        artifacts: [
          {
            backupPath: jsonBackupPath,
            hadOriginal: true,
            targetPath: jsonPath,
            tempPath: jsonTempPath,
          },
          {
            backupPath: textBackupPath,
            hadOriginal: true,
            targetPath: textPath,
            tempPath: textTempPath,
          },
        ],
        schemaVersion: "output-transaction.v0",
        state: "committed",
        token,
        videoId: video.videoId,
      }, null, 2)}\n`),
    ]);

    await recoverPendingOutputTransactions(outputDir);

    expect(await readFile(jsonPath, "utf8")).toBe("new json\n");
    expect(await readFile(textPath, "utf8")).toBe("new text\n");
    for (const ownedPath of [jsonBackupPath, jsonTempPath, textBackupPath, textTempPath, manifestPath]) {
      await expect(readFile(ownedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("rejects a symlinked owned directory without touching the outside victim", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-symlink-root-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "video-digest-symlink-victim-"));
    const token = "55555555-5555-4555-8555-555555555555";
    const transactionDir = join(outputDir, ".transactions");
    const targetPath = join(outputDir, "transcripts", `${video.videoId}.json`);
    const backupPath = `${targetPath}.${token}.backup`;
    const tempPath = `${targetPath}.${token}.tmp`;
    const manifestPath = join(transactionDir, `${token}.json`);
    await mkdir(transactionDir, { recursive: true });
    await symlink(outsideDir, join(outputDir, "transcripts"));
    await writeFile(join(outsideDir, `${video.videoId}.json`), "victim\n");
    await writeFile(join(outsideDir, `${video.videoId}.json.${token}.backup`), "backup\n");
    await writeFile(manifestPath, `${JSON.stringify({
      artifacts: [{ backupPath, hadOriginal: true, targetPath, tempPath }],
      schemaVersion: "output-transaction.v0",
      state: "prepared",
      token,
      videoId: video.videoId,
    })}\n`);

    await expect(recoverPendingOutputTransactions(outputDir)).rejects.toBeInstanceOf(
      OutputRecoveryError,
    );
    expect(await readFile(join(outsideDir, `${video.videoId}.json`), "utf8")).toBe("victim\n");
    expect(await readFile(join(outsideDir, `${video.videoId}.json.${token}.backup`), "utf8"))
      .toBe("backup\n");
  });

  test("fails closed when an artifact parent identity changes before mutation", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-parent-race-"));
    const token = "88888888-8888-4888-8888-888888888888";
    const transactionDir = join(outputDir, ".transactions");
    const transcriptDir = join(outputDir, "transcripts");
    const targetPath = join(transcriptDir, `${video.videoId}.json`);
    const backupPath = `${targetPath}.${token}.backup`;
    const tempPath = `${targetPath}.${token}.tmp`;
    await Promise.all([
      mkdir(transactionDir, { recursive: true }),
      mkdir(transcriptDir, { recursive: true }),
    ]);
    await Promise.all([writeFile(targetPath, "new\n"), writeFile(backupPath, "old\n")]);
    await writeFile(join(transactionDir, `${token}.json`), `${JSON.stringify({
      artifacts: [{ backupPath, hadOriginal: true, targetPath, tempPath }],
      schemaVersion: "output-transaction.v0",
      state: "prepared",
      token,
      videoId: video.videoId,
    })}\n`);
    let transcriptParentChecks = 0;

    await expect(recoverPendingOutputTransactions(outputDir, {
      lstat: async (path) => {
        const stats = await lstat(path);
        if (path !== transcriptDir) return stats;
        transcriptParentChecks += 1;
        return {
          dev: stats.dev,
          ino: stats.ino + (transcriptParentChecks >= 5 ? 1 : 0),
          isDirectory: () => true,
          isSymbolicLink: () => false,
        };
      },
    })).rejects.toBeInstanceOf(OutputRecoveryError);
    expect(await readFile(targetPath, "utf8")).toBe("new\n");
    expect(await readFile(backupPath, "utf8")).toBe("old\n");
  });

  test("removes only owned orphan manifest temp files", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-orphan-manifest-"));
    const transactionDir = join(outputDir, ".transactions");
    const token = "66666666-6666-4666-8666-666666666666";
    const ownedTemp = join(transactionDir, `${token}.json.tmp`);
    const unknown = join(transactionDir, "notes.tmp");
    await mkdir(transactionDir, { recursive: true });
    await Promise.all([writeFile(ownedTemp, "partial"), writeFile(unknown, "keep")]);

    await recoverPendingOutputTransactions(outputDir);

    await expect(readFile(ownedTemp, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(unknown, "utf8")).toBe("keep");
  });

  test("removes only exact owned artifact temps left before manifest publication", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-orphan-artifact-"));
    const token = "77777777-7777-4777-8777-777777777777";
    const transcriptDir = join(outputDir, "transcripts");
    const ownedTemp = join(transcriptDir, `${video.videoId}.json.${token}.tmp`);
    const unknown = join(transcriptDir, `notes.json.${token}.tmp`);
    await mkdir(transcriptDir, { recursive: true });
    await Promise.all([writeFile(ownedTemp, "partial"), writeFile(unknown, "keep")]);

    await recoverPendingOutputTransactions(outputDir);

    await expect(readFile(ownedTemp, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(unknown, "utf8")).toBe("keep");
  });
});

describe("writeTranscriptOnlyOutputs", () => {
  test("writes transcript and metadata without digest artifacts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-transcript-"));

    const result = await writeTranscriptOnlyOutputs({
      outputDir,
      transcript,
      transcriptQuality: usableQuality,
      video,
    });

    expect(result).toEqual({
      metadataPath: join(outputDir, "metadata", "1ZgUcrR0K7I.json"),
      transcriptJsonPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.json"),
      transcriptMarkdownPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.md"),
      transcriptTextPath: join(outputDir, "transcripts", "1ZgUcrR0K7I.txt"),
    });

    expect(await readFile(result.transcriptJsonPath, "utf8")).toBe(
      `${JSON.stringify(transcript, null, 2)}\n`,
    );
    const transcriptJson = JSON.parse(await readFile(result.transcriptJsonPath, "utf8"));
    expect(transcriptJson.schemaVersion).toBe("transcript.v0");
    expect(await readFile(result.transcriptMarkdownPath, "utf8")).toBe(
      [
        "# Transcript 1ZgUcrR0K7I",
        "",
        `URL: ${video.canonicalUrl}`,
        "Language: en",
        "Source: youtube-transcript-api",
        "Provenance: unknown",
        "",
        "## Transcript",
        "",
        "**00:00** Technology can change media businesses.",
        "",
      ].join("\n"),
    );
    expect(await readFile(result.transcriptTextPath, "utf8")).toBe(
      "Technology can change media businesses.\n",
    );

    const metadataJson = JSON.parse(await readFile(result.metadataPath, "utf8"));
    expect(metadataJson).toMatchObject({
      digest: null,
      generation: null,
      metadataSchemaVersion: "metadata.v1",
      mode: "transcript-only",
      transcriptQuality: {
        status: "usable",
      },
      video: {
        videoId: "1ZgUcrR0K7I",
      },
      videoDigestVersion: "0.2.0",
    });
    await expect(readFile(join(outputDir, "digests", "1ZgUcrR0K7I.md"), "utf8")).rejects.toThrow();
  });

  test("removes stale digest and email artifacts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-transcript-replace-"));
    await writeIngestionOutputs({
      digest, emailPreview: true, outputDir, transcript, transcriptQuality: usableQuality, video,
    });

    await writeTranscriptOnlyOutputs({ outputDir, transcript, transcriptQuality: usableQuality, video });

    await expect(readFile(join(outputDir, "digests", `${video.videoId}.md`), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(outputDir, "emails", `${video.videoId}.md`), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("writeFailedIngestionMetadata", () => {
  test("removes stale successful-entry artifacts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-failed-replace-"));
    await writeIngestionOutputs({
      digest, emailPreview: true, outputDir, transcript, transcriptQuality: usableQuality, video,
    });

    await writeFailedIngestionMetadata({
      error: { code: "unusable-transcript", message: "No usable transcript" },
      outputDir,
      transcriptQuality: usableQuality,
      video,
    });

    for (const path of [
      join(outputDir, "digests", `${video.videoId}.md`),
      join(outputDir, "emails", `${video.videoId}.md`),
      join(outputDir, "transcripts", `${video.videoId}.json`),
      join(outputDir, "transcripts", `${video.videoId}.md`),
      join(outputDir, "transcripts", `${video.videoId}.txt`),
    ]) {
      await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("restores a successful entry when failed-metadata replacement rolls back", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "video-digest-failed-rollback-"));
    await writeIngestionOutputs({
      digest, emailPreview: true, outputDir, transcript, transcriptQuality: usableQuality, video,
    });
    const previous = new Map<string, string>();
    for (const path of artifactContents(outputDir).keys()) previous.set(path, await readFile(path, "utf8"));

    await expect(writeFailedIngestionMetadata(
      {
        error: { code: "unusable-transcript", message: "No usable transcript" },
        outputDir,
        transcriptQuality: usableQuality,
        video,
      },
      {
        rename: async (from, to) => {
          if (from.includes("/.transactions/") && from.endsWith(".commit.tmp")) {
            throw new Error("simulated error-entry commit failure");
          }
          await rename(from, to);
        },
      },
    )).rejects.toThrow("simulated error-entry commit failure");

    for (const [path, contents] of previous) expect(await readFile(path, "utf8")).toBe(contents);
  });
});

const video: YouTubeVideo = {
  canonicalUrl: "https://www.youtube.com/watch?v=1ZgUcrR0K7I",
  videoId: "1ZgUcrR0K7I",
};

const transcript: Transcript = {
  language: "en",
  provenance: { isAutoGenerated: null },
  schemaVersion: "transcript.v0",
  segments: [
    {
      duration: 5,
      start: 0,
      text: "Technology can change media businesses.",
    },
  ],
  source: "youtube-transcript-api",
  videoId: "1ZgUcrR0K7I",
};

const warningQuality: TranscriptQuality = {
  averageCharsPerMinute: 720,
  durationSeconds: 5,
  language: "en",
  qualitySchemaVersion: "transcript-quality.v0",
  segmentCount: 1,
  status: "warning",
  totalTextLength: 39,
  warnings: ["low-segment-count"],
};

const usableQuality: TranscriptQuality = {
  ...warningQuality,
  status: "usable",
  warnings: [],
};

const generation = {
  provider: "anthropic" as const,
  requestId: "msg_123",
  requestedModel: "claude-sonnet-4-6",
  responseModel: "claude-sonnet-4-6",
  usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
};

const digest = createDigest({
  actionableIdeas: ["Study technology shifts in older industries."],
  conceptsToInvestigate: ["media economics"],
  connections: ["Connects to knowledge ingestion."],
  digestTitle: "Generated Digest Title",
  keyIdeas: ["Technology changes media economics."],
  relevantTimestamps: [
    {
      note: "Technology and media thesis.",
      timestamp: "0:00",
    },
  ],
  tldr: ["A concise digest."],
  verdict: "watch_fragments",
});

function artifactContents(outputDir: string): Map<string, string> {
  return new Map([
    [join(outputDir, "transcripts", `${video.videoId}.json`), "old transcript json\n"],
    [join(outputDir, "transcripts", `${video.videoId}.md`), "old transcript markdown\n"],
    [join(outputDir, "transcripts", `${video.videoId}.txt`), "old transcript text\n"],
    [join(outputDir, "digests", `${video.videoId}.md`), "old digest\n"],
    [join(outputDir, "metadata", `${video.videoId}.json`), "old metadata\n"],
    [join(outputDir, "emails", `${video.videoId}.md`), "old email\n"],
  ]);
}

async function seedArtifacts(artifacts: Map<string, string>): Promise<void> {
  await Promise.all(
    [...artifacts].map(async ([path, contents]) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    }),
  );
}
