import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "video-digest";
const PACKAGE_VERSION = "0.1.0";
const TARBALL_FILENAME = "video-digest-0.1.0.tgz";

const expectedPackedFiles = [
  "package/package.json",
  "package/bin/video-digest",
  "package/README.md",
  "package/LICENSE",
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

const expectedPackedFileSet = new Set<string>(expectedPackedFiles);
const forbiddenSource =
  /(?:\.(?:test|spec)\.[^/]+$|\.snap(?:\.|$)|\/(?:__)?(?:snapshots?|fixtures?)(?:__)?\/)/i;
const controlCharacter = /[\u0000-\u001f\u007f]/;

export interface CommandInvocation {
  executable: string;
  args: string[];
  cwd: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<CommandResult>;

export interface PackAndVerifyOptions {
  repositoryRoot?: string;
  tempRoot?: string;
  runCommand?: CommandRunner;
}

export interface VerifiedPackage {
  tarballPath: string;
  temporaryDirectory: string;
  cleanup: () => Promise<void>;
}

function displayPath(path: string): string {
  return controlCharacter.test(path) ? JSON.stringify(path) : path;
}

function normalizePackedFileName(name: string): string {
  if (
    name.length === 0 ||
    controlCharacter.test(name) ||
    name.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(name) ||
    name.startsWith("\\\\") ||
    name.includes("\\")
  ) {
    throw new Error(`Unsafe packed file name: ${displayPath(name)}`);
  }

  const withoutDotPrefix = name.replace(/^(?:\.\/)+/, "");
  if (withoutDotPrefix.split("/").includes("..")) {
    throw new Error(`Unsafe packed file name: ${displayPath(name)}`);
  }

  const normalized = posix.normalize(withoutDotPrefix);
  if (normalized === "." || normalized === ".." || !normalized.startsWith("package/")) {
    throw new Error(`Unsafe packed file name: ${displayPath(name)}`);
  }
  return normalized;
}

export function validatePackedFiles(files: readonly string[]): string[] {
  const normalizedFiles: string[] = [];
  const seen = new Set<string>();

  for (const input of files) {
    const file = normalizePackedFileName(input);
    if (seen.has(file)) throw new Error(`Duplicate packed file: ${file}`);
    seen.add(file);

    if (forbiddenSource.test(file)) {
      throw new Error(`Unexpected packed file: ${file}`);
    }
    if (!expectedPackedFileSet.has(file)) {
      throw new Error(`Unexpected packed file: ${file}`);
    }
    normalizedFiles.push(file);
  }

  for (const required of expectedPackedFiles) {
    if (!seen.has(required)) throw new Error(`Missing packed file: ${required}`);
  }

  return normalizedFiles.sort();
}

export function verifyPackedFileListsAgree(
  tarFiles: readonly string[],
  npmFiles: readonly string[],
): void {
  const normalizedTarFiles = tarFiles.map(normalizePackedFileName).sort();
  const normalizedNpmFiles = npmFiles.map(normalizePackedFileName).sort();
  if (
    normalizedTarFiles.length !== normalizedNpmFiles.length ||
    normalizedTarFiles.some((file, index) => file !== normalizedNpmFiles[index])
  ) {
    throw new Error("Packed manifests disagree");
  }
  validatePackedFiles(tarFiles);
  validatePackedFiles(npmFiles);
}

async function runProcess(invocation: CommandInvocation): Promise<CommandResult> {
  const process = Bun.spawn([invocation.executable, ...invocation.args], {
    cwd: invocation.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

interface NpmPackRecord {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  filename?: unknown;
  files?: unknown;
}

function parseNpmPackOutput(stdout: string): { filename: string; files: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack returned invalid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack must return exactly one package record");
  }

  const record = parsed[0] as NpmPackRecord;
  if (
    record.name !== PACKAGE_NAME ||
    record.version !== PACKAGE_VERSION ||
    record.id !== `${PACKAGE_NAME}@${PACKAGE_VERSION}`
  ) {
    throw new Error(`npm pack returned unexpected package identity`);
  }
  if (
    record.filename !== TARBALL_FILENAME ||
    basename(record.filename) !== record.filename ||
    controlCharacter.test(record.filename)
  ) {
    throw new Error("npm pack returned an unsafe tarball filename");
  }
  if (!Array.isArray(record.files)) {
    throw new Error("npm pack returned an invalid file manifest");
  }

  const files = record.files.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      typeof entry.path !== "string"
    ) {
      throw new Error("npm pack returned an invalid file manifest");
    }
    return `package/${entry.path}`;
  });
  return { filename: record.filename, files };
}

function parseTarListing(stdout: string): string[] {
  const files = stdout.split(/\r?\n/);
  if (files.at(-1) === "") files.pop();
  if (files.length === 0 || files.some((file) => file.length === 0)) {
    throw new Error("tar returned an invalid file listing");
  }
  return files;
}

export async function packAndVerifyPackage(
  options: PackAndVerifyOptions = {},
): Promise<VerifiedPackage> {
  const repositoryRoot = resolve(
    options.repositoryRoot ?? fileURLToPath(new URL("..", import.meta.url)),
  );
  const temporaryDirectory = await mkdtemp(
    join(resolve(options.tempRoot ?? tmpdir()), "video-digest-pack-"),
  );
  const runCommand = options.runCommand ?? runProcess;

  try {
    const packResult = await runCommand({
      executable: "npm",
      args: [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        temporaryDirectory,
      ],
      cwd: repositoryRoot,
    });
    if (packResult.exitCode !== 0) {
      throw new Error(`npm pack failed with exit code ${packResult.exitCode}`);
    }

    const manifest = parseNpmPackOutput(packResult.stdout);
    const tarballPath = join(temporaryDirectory, manifest.filename);
    const tarResult = await runCommand({
      executable: "tar",
      args: ["-tzf", tarballPath],
      cwd: repositoryRoot,
    });
    if (tarResult.exitCode !== 0) {
      throw new Error(`tar listing failed with exit code ${tarResult.exitCode}`);
    }

    const tarFiles = parseTarListing(tarResult.stdout);
    const npmFiles = manifest.files.map((file) => normalizePackedFileName(file));
    verifyPackedFileListsAgree(tarFiles, npmFiles);

    let cleaned = false;
    return {
      tarballPath,
      temporaryDirectory,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(temporaryDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  try {
    const verifiedPackage = await packAndVerifyPackage();
    console.log(verifiedPackage.tarballPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Package verification failed");
    process.exitCode = 1;
  }
}
