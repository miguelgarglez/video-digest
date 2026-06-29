import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isDigestProviderId,
  type DigestProviderId,
} from "../summarizer/providers";

export type AppConfig = {
  artifactLibrary: string;
  digest: {
    defaultProvider: DigestProviderId;
    models: Partial<Record<DigestProviderId, string>>;
  };
  schemaVersion: "config.v1";
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
    await chmod(parent, 0o700);
    await writeFile(this.path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.path, 0o600);
  }
}

function validateConfig(value: unknown, path: string): AppConfig {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["artifactLibrary", "digest", "schemaVersion"]) ||
    typeof value.artifactLibrary !== "string" ||
    value.schemaVersion !== "config.v1" ||
    !isRecord(value.digest) ||
    !hasExactKeys(value.digest, ["defaultProvider", "models"]) ||
    typeof value.digest.defaultProvider !== "string" ||
    !isDigestProviderId(value.digest.defaultProvider) ||
    !isRecord(value.digest.models)
  ) {
    throw new Error(`Unsupported config at ${path}: expected schema config.v1`);
  }

  const models: Partial<Record<DigestProviderId, string>> = {};
  for (const [provider, model] of Object.entries(value.digest.models)) {
    if (!isDigestProviderId(provider) || typeof model !== "string" || model.trim().length === 0) {
      throw new Error(`Unsupported config at ${path}: expected schema config.v1`);
    }
    models[provider] = model;
  }

  return {
    artifactLibrary: value.artifactLibrary,
    digest: {
      defaultProvider: value.digest.defaultProvider,
      models,
    },
    schemaVersion: value.schemaVersion,
  };
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
