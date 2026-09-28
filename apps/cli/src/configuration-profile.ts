import { lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export class ConfigurationProfileError extends Error {
  constructor(message: string, public readonly code = "CONFIG_PROFILE_INVALID") { super(message); }
}

/** Select before opening stores. The unselected environment keeps its legacy paths. */
export function selectConfigurationProfile(argv: string[], env: Record<string, string | undefined>) {
  const args: string[] = [];
  let option: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--config-profile") { args.push(argv[index]); continue; }
    const value = argv[++index];
    if (option !== undefined || !value || value.startsWith("--")) {
      throw new ConfigurationProfileError("--config-profile requires exactly one profile name.");
    }
    option = value;
  }
  const name = option ?? env.MYSKILLS_CONFIG_PROFILE;
  if (name === undefined) return { argv: args, env, name, directory: undefined };
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new ConfigurationProfileError("Configuration profile names must be 1–64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit.");
  }
  if (env.MYSKILLS_CONFIG_FILE || env.MYSKILLS_TOKEN_FILE) {
    throw new ConfigurationProfileError("A named configuration profile cannot be combined with MYSKILLS_CONFIG_FILE or MYSKILLS_TOKEN_FILE. Use MYSKILLS_CONFIG_DIR for its base directory.", "CONFIG_PROFILE_AMBIGUOUS");
  }
  const base = env.MYSKILLS_CONFIG_DIR || (env.XDG_CONFIG_HOME
    ? path.join(env.XDG_CONFIG_HOME, "myskills-app") : path.join(os.homedir(), ".config", "myskills-app"));
  const baseDirectory = canonicalFutureDirectory(path.resolve(base));
  const profilesDirectory = path.join(baseDirectory, "profiles");
  const directory = path.join(profilesDirectory, name);
  assertProfileDirectory(profilesDirectory);
  assertProfileDirectory(directory);
  return { argv: args, env: { ...env, MYSKILLS_CONFIG_DIR: directory }, name, directory };
}

/** Base directory aliases use the same namespace, including before first write. */
function canonicalFutureDirectory(directory: string): string {
  try { return realpathSync(directory); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(canonicalFutureDirectory(parent), path.basename(directory));
  }
}

/** Profile components must not alias another account's files or credential namespace. */
function assertProfileDirectory(directory: string): void {
  try {
    const info = lstatSync(directory);
    if (info.isDirectory() && !info.isSymbolicLink()) return;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
  }
  throw new ConfigurationProfileError("Named configuration profile directories must be real directories, not links or files.", "CONFIG_PROFILE_PATH_UNSAFE");
}
