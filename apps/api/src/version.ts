import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

interface PackageMetadata {
  version?: unknown;
}

const require = createRequire(import.meta.url);
const metadata = require("../../../package.json") as PackageMetadata;

if (typeof metadata.version !== "string" || !metadata.version.trim()) {
  throw new Error("Root package version metadata is required.");
}

export const API_VERSION = metadata.version;

export function readBuildRevision(): string | null {
  try {
    const build = JSON.parse(readFileSync(new URL("../../../build-info.json", import.meta.url), "utf8")) as {
      version?: unknown;
      revision?: unknown;
    };
    if (build.version !== API_VERSION) throw new Error("Build version differs from package metadata.");
    if (build.revision === null) return null;
    if (typeof build.revision !== "string" || !/^[a-f0-9]{40}$/.test(build.revision)) {
      throw new Error("Build revision is invalid.");
    }
    return build.revision;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
