import type { LibraryEntry } from "../cli/artifacts";
import type { DoctorReport } from "../cli/doctor";
import type { RuntimeReadiness } from "../cli/runtime-manager";
import type { SystemActions } from "../cli/system-actions";
import type { LibraryTarget, ResultData } from "./model";
import type { DigestProviderId } from "../summarizer/providers";

export type CreateOperationOptions = Readonly<{
  onProgress(message: string): void;
  signal: AbortSignal;
}>;

export type TuiCreatePort = {
  ingest(url: string, options: CreateOperationOptions): Promise<ResultData>;
  transcript(url: string, options: CreateOperationOptions): Promise<ResultData>;
};

export type LibraryReadResult = Readonly<{
  content: string;
  /** Inert, terminal-safe presentation text; never pass this back to filesystem APIs. */
  displayPath: string;
  title: string;
}>;

/**
 * High-level capability boundary for Artifact Library access. Implementations must
 * resolve the target from canonical metadata inside `withRecoveredOutputLibrary`,
 * revalidate the Library root, parent, and file, and retain that lock through the
 * read or macOS opener/revealer call. `LibraryTarget` is an identifier, never a path.
 */
export type TuiLibraryPort = {
  list(): Promise<LibraryEntry[]>;
  open(target: LibraryTarget): Promise<void>;
  read(target: LibraryTarget): Promise<LibraryReadResult>;
  reveal(target: LibraryTarget): Promise<void>;
};

/** Narrow application boundary used by the TUI controller and its renderer. */
export type TuiPorts = {
  config: {
    saveArtifactLibrary(path: string): Promise<string>;
    saveModel(provider: DigestProviderId, model: string): Promise<void>;
    saveProvider(provider: DigestProviderId): Promise<void>;
  };
  create: TuiCreatePort;
  credential: {
    deleteApiKey(provider: DigestProviderId): Promise<void>;
    saveApiKey(provider: DigestProviderId, value: string): Promise<void>;
  };
  doctor: {
    run(): Promise<DoctorReport>;
  };
  library: TuiLibraryPort;
  lifecycle: {
    quit(): void | Promise<void>;
  };
  output: {
    print(text: string): void | Promise<void>;
  };
  runtime: {
    prepare(): Promise<void>;
    readiness(): Promise<RuntimeReadiness>;
  };
  system: Pick<SystemActions, "copy" | "openExternal">;
};
