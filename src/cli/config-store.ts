import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AppConfig = {
  artifactLibrary: string;
  schemaVersion: "config.v0";
};

export class FileConfigStore {
  constructor(private readonly path: string) {}

  async load(): Promise<AppConfig | null> {
    let contents: string;

    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }

    let value: unknown;

    try {
      value = JSON.parse(contents);
    } catch {
      throw new Error(`Invalid config at ${this.path}: malformed JSON`);
    }

    return validateConfig(value, this.path);
  }

  async save(config: AppConfig): Promise<void> {
    const validated = validateConfig(config, this.path);
    const parent = dirname(this.path);

    await mkdir(parent, { mode: 0o700, recursive: true });
    await writeFile(this.path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.path, 0o600);
  }
}

function validateConfig(value: unknown, path: string): AppConfig {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.artifactLibrary !== "string" ||
    value.schemaVersion !== "config.v0"
  ) {
    throw new Error(`Unsupported config at ${path}: expected schema config.v0`);
  }

  return {
    artifactLibrary: value.artifactLibrary,
    schemaVersion: value.schemaVersion,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
