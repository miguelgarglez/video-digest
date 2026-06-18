import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PackageResources = {
  packageJson: string;
  pythonDir: string;
  sidecarScript: string;
  uvLock: string;
};

export function resolvePackageResources(moduleUrl: string | URL): PackageResources {
  const packageRoot = resolve(dirname(fileURLToPath(moduleUrl)), "../..");
  const pythonDir = resolve(packageRoot, "python");

  return {
    packageJson: resolve(packageRoot, "package.json"),
    pythonDir,
    sidecarScript: resolve(pythonDir, "fetch_transcript.py"),
    uvLock: resolve(pythonDir, "uv.lock"),
  };
}
