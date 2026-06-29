import { getProviderProfile, type DigestProviderId } from "../summarizer/providers";

export type CredentialStore = {
  deleteApiKey(provider: DigestProviderId): Promise<void>;
  getApiKey(provider: DigestProviderId): Promise<string | null>;
  setApiKey(provider: DigestProviderId, value: string): Promise<void>;
};

export type CredentialSource =
  | {
      source: "env" | "keychain";
      value: string;
    }
  | {
      source: "missing";
      value: null;
    };

export type SecurityCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type SecurityCommandRunner = (args: string[]) => Promise<SecurityCommandResult>;

const KEYCHAIN_SERVICE = "video-digest";

export class MacOSKeychainCredentialStore implements CredentialStore {
  private readonly runSecurity: SecurityCommandRunner;
  private readonly service: string;

  constructor(options: {
    runSecurity?: SecurityCommandRunner;
    service?: string;
  } = {}) {
    this.runSecurity = options.runSecurity ?? runSecurityCommand;
    this.service = options.service ?? KEYCHAIN_SERVICE;
  }

  async getApiKey(provider: DigestProviderId): Promise<string | null> {
    const result = await this.runSecurity([
      "find-generic-password",
      "-a",
      accountFor(provider),
      "-s",
      this.service,
      "-w",
    ]);

    if (result.exitCode !== 0) {
      return null;
    }

    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  }

  async setApiKey(provider: DigestProviderId, value: string): Promise<void> {
    const result = await this.runSecurity([
      "add-generic-password",
      "-a",
      accountFor(provider),
      "-s",
      this.service,
      "-w",
      value,
      "-U",
    ]);

    if (result.exitCode !== 0) {
      throw new Error("Could not store provider API key in Keychain");
    }
  }

  async deleteApiKey(provider: DigestProviderId): Promise<void> {
    const result = await this.runSecurity([
      "delete-generic-password",
      "-a",
      accountFor(provider),
      "-s",
      this.service,
    ]);

    if (result.exitCode !== 0 && !result.stderr.includes("could not be found")) {
      throw new Error("Could not delete provider API key from Keychain");
    }
  }
}

export async function resolveProviderApiKey(input: {
  env: Record<string, string | undefined>;
  provider: DigestProviderId;
  store: CredentialStore;
}): Promise<CredentialSource> {
  const envValue = input.env[getProviderProfile(input.provider).credentialEnv]?.trim();

  if (envValue) {
    return { source: "env", value: envValue };
  }

  const storedValue = await input.store.getApiKey(input.provider);
  return storedValue
    ? { source: "keychain", value: storedValue }
    : { source: "missing", value: null };
}

/** @deprecated Removed with the provider-neutral CLI contract in 1.0. */
export async function resolveOpenCodeApiKey(input: {
  env: Record<string, string | undefined>;
  store: CredentialStore;
}): Promise<CredentialSource> {
  return resolveProviderApiKey({ ...input, provider: "opencode" });
}

function accountFor(provider: DigestProviderId): string {
  return `provider:${provider}:api-key`;
}

async function runSecurityCommand(args: string[]): Promise<SecurityCommandResult> {
  const process = Bun.spawn(["security", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  return {
    exitCode,
    stderr,
    stdout,
  };
}
