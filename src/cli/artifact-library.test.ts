import { describe, expect, test } from "bun:test";
import { resolveArtifactLibrary, type ArtifactLibraryResolution } from "./artifact-library";

describe("resolveArtifactLibrary", () => {
  test.each([
    ["CLI flag", "/cli", "/env", "/saved", "/default", { path: "/cli", source: "cli" }],
    ["environment", undefined, "/env", "/saved", "/default", { path: "/env", source: "env" }],
    ["saved config", undefined, undefined, "/saved", "/default", { path: "/saved", source: "config" }],
    ["app default", undefined, undefined, undefined, "/default", { path: "/default", source: "default" }],
  ])("uses %s precedence", (_label, cli, env, saved, fallback, expected) => {
    expect(resolveArtifactLibrary({
      cliOutputDir: cli,
      defaultArtifactLibrary: fallback,
      envOutputDir: env,
      savedArtifactLibrary: saved,
    })).toEqual(expected as ArtifactLibraryResolution);
  });
});
