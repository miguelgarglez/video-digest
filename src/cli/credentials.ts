export type CredentialStore = {
  deleteOpenCodeApiKey(): Promise<void>;
  getOpenCodeApiKey(): Promise<string | null>;
  setOpenCodeApiKey(value: string): Promise<void>;
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

const KEYCHAIN_ACCOUNT = "opencode-api-key";
const KEYCHAIN_SERVICE = "personal-video-digest";

export class MacOSKeychainCredentialStore implements CredentialStore {
  private readonly account: string;
  private readonly runSecurity: SecurityCommandRunner;
  private readonly service: string;

  constructor(options: {
    account?: string;
    runSecurity?: SecurityCommandRunner;
    service?: string;
  } = {}) {
    this.account = options.account ?? KEYCHAIN_ACCOUNT;
    this.runSecurity = options.runSecurity ?? runSecurityCommand;
    this.service = options.service ?? KEYCHAIN_SERVICE;
  }

  async getOpenCodeApiKey(): Promise<string | null> {
    const result = await this.runSecurity([
      "find-generic-password",
      "-a",
      this.account,
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

  async setOpenCodeApiKey(value: string): Promise<void> {
    const result = await this.runSecurity([
      "add-generic-password",
      "-a",
      this.account,
      "-s",
      this.service,
      "-w",
      value,
      "-U",
    ]);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Could not store OpenCode API key in Keychain");
    }
  }

  async deleteOpenCodeApiKey(): Promise<void> {
    const result = await this.runSecurity([
      "delete-generic-password",
      "-a",
      this.account,
      "-s",
      this.service,
    ]);

    if (result.exitCode !== 0 && !result.stderr.includes("could not be found")) {
      throw new Error(result.stderr.trim() || "Could not delete OpenCode API key from Keychain");
    }
  }
}

export async function resolveOpenCodeApiKey(input: {
  env: Record<string, string | undefined>;
  store: CredentialStore;
}): Promise<CredentialSource> {
  const envValue = input.env.OPENCODE_API_KEY?.trim();

  if (envValue) {
    return {
      source: "env",
      value: envValue,
    };
  }

  const storedValue = await input.store.getOpenCodeApiKey();

  if (storedValue) {
    return {
      source: "keychain",
      value: storedValue,
    };
  }

  return {
    source: "missing",
    value: null,
  };
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
