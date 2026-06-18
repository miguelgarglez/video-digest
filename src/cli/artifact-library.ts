export type ArtifactLibraryOptions = {
  cliOutputDir?: string;
  defaultArtifactLibrary: string;
  envOutputDir?: string;
  savedArtifactLibrary?: string;
};

export type ArtifactLibraryResolution = {
  path: string;
  source: "cli" | "config" | "default" | "env";
};

export function resolveArtifactLibrary(options: ArtifactLibraryOptions): ArtifactLibraryResolution {
  if (options.cliOutputDir !== undefined) {
    return { path: options.cliOutputDir, source: "cli" };
  }
  if (options.envOutputDir !== undefined) {
    return { path: options.envOutputDir, source: "env" };
  }
  if (options.savedArtifactLibrary !== undefined) {
    return { path: options.savedArtifactLibrary, source: "config" };
  }
  return { path: options.defaultArtifactLibrary, source: "default" };
}
