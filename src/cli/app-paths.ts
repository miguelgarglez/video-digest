import { join } from "node:path";

export type AppPaths = {
  configPath: string;
  defaultArtifactLibrary: string;
  runtimeDir: string;
};

export function resolveAppPaths(home: string): AppPaths {
  const applicationSupport = join(home, "Library", "Application Support", "video-digest");

  return {
    configPath: join(applicationSupport, "config.json"),
    defaultArtifactLibrary: join(home, "Documents", "Video Digest"),
    runtimeDir: join(applicationSupport, "runtime", "python"),
  };
}
