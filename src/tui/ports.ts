import type { LibraryEntry } from "../cli/artifacts";
import type { DoctorReport } from "../cli/doctor";
import type { RuntimeReadiness } from "../cli/runtime-manager";
import type { SystemActions } from "../cli/system-actions";
import type { ResultData } from "./model";

export type CreateOperationOptions = Readonly<{
  onProgress(message: string): void;
  signal: AbortSignal;
}>;

export type TuiCreatePort = {
  ingest(url: string, options: CreateOperationOptions): Promise<ResultData>;
  transcript(url: string, options: CreateOperationOptions): Promise<ResultData>;
};

/** Narrow application boundary used by the TUI controller and its renderer. */
export type TuiPorts = {
  config: {
    saveArtifactLibrary(path: string): Promise<void>;
  };
  create: TuiCreatePort;
  credential: {
    saveOpenCodeApiKey(value: string): Promise<void>;
  };
  doctor: {
    run(): Promise<DoctorReport>;
  };
  library: {
    list(): Promise<LibraryEntry[]>;
  };
  lifecycle: {
    quit(): void | Promise<void>;
  };
  output: {
    print(text: string): void | Promise<void>;
  };
  reader: {
    read(path: string): Promise<string>;
  };
  runtime: {
    prepare(): Promise<void>;
    readiness(): Promise<RuntimeReadiness>;
  };
  system: SystemActions;
};
