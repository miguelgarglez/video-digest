export type ArtifactLibraryOptions = {
  cliOutputDir?: string;
  defaultArtifactLibrary: string;
  envOutputDir?: string;
  savedArtifactLibrary?: string;
};

export function resolveArtifactLibrary(options: ArtifactLibraryOptions): string {
  return options.cliOutputDir
    ?? options.envOutputDir
    ?? options.savedArtifactLibrary
    ?? options.defaultArtifactLibrary;
}
