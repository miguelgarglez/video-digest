import { describe, expect, test } from "bun:test";
import { resolveArtifactLibrary } from "./artifact-library";

describe("resolveArtifactLibrary", () => {
  test.each([
    ["CLI flag", "/cli", "/env", "/saved", "/default", "/cli"],
    ["environment", undefined, "/env", "/saved", "/default", "/env"],
    ["saved config", undefined, undefined, "/saved", "/default", "/saved"],
    ["app default", undefined, undefined, undefined, "/default", "/default"],
  ])("uses %s precedence", (_label, cli, env, saved, fallback, expected) => {
    expect(resolveArtifactLibrary({
      cliOutputDir: cli,
      defaultArtifactLibrary: fallback,
      envOutputDir: env,
      savedArtifactLibrary: saved,
    })).toBe(expected);
  });
});
