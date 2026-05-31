import { parseCliArgs } from "./parse-args";

export type CliIO = {
  error: (message: string) => void;
  log: (message: string) => void;
};

export function runCli(args: string[], io: CliIO = console): number {
  const result = parseCliArgs(args);

  if (!result.ok) {
    io.error(result.error.message);
    return 1;
  }

  const { emailPreview, video } = result.value;

  io.log(`Video ID: ${video.videoId}`);
  io.log(`Canonical URL: ${video.canonicalUrl}`);
  io.log(`Email preview: ${emailPreview ? "yes" : "no"}`);

  return 0;
}

if (import.meta.main) {
  const exitCode = runCli(Bun.argv.slice(2));
  process.exit(exitCode);
}
