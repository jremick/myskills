import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  hasBlockingFindings,
  loadSkillManifestFromPackageFiles,
  loadSkillManifestFromPath,
  normalizePackageFilePath,
  readPackageSnapshot,
  scanPackagePath,
  type PackageScanResult,
} from "@myskills-app/skill-package";
import {
  assertValidArchitectureTargetAdapterContext,
  assertValidArchitectureTargetObservation,
  architectureTargetLimits,
  architectureTargetAdapterDigest,
  architectureTargetCapabilitiesDigest,
  architectureTargetObservationDigest,
  compareSemanticVersions,
  evaluateSkillUpdate,
  parseSemanticVersion,
  parseSkillReleaseMetadata,
  targetSkillOperationPlanDigest,
  validateArchitectureTargetHealth,
  type ArchitectureTargetAdapterContext,
  type ArchitectureTargetHealth,
  type ArchitectureTargetObservation,
  type SkillReleaseMetadata,
  type SkillReleaseUpdateCandidate,
  type TargetSkillOperation,
  type ArchitectureTarget,
} from "@myskills-app/core";
import {
  CodexReadOnlyArchitectureTargetAdapter,
  codexAdapterProfiles,
  type CodexAdapterProfile,
} from "./codex-readonly-adapter.js";
import {
  assertInstallRootLocked, assertRegularDirectory, atomicPrivateWrite, ensureSafeDirectory,
  exportPackageTree, readRegularText, validatePortableFilePaths, withInstallRootLock, writeNewPackageTree,
} from "./install-filesystem.js";
import { codexWorkspaceCapabilities, codexWorkspaceDescriptor, parseWorkspaceTarget, validateCodexSkill, workspaceRootDigest } from "./codex-workspace.js";
import { CompanionLease } from "./companion-lease.js";

const DEFAULT_API_URL = "http://localhost:3001";
const CLI_VERSION = process.env.MYSKILLS_CLI_VERSION ?? "0.0.0-dev";
const CLI_VISIBILITY_SCOPES = ["public", "authenticated", "organization", "team", "private", "explicit-users"] as const;
const LOGIN_AUTH_METHODS = ["password", "api-key"] as const;
const OBSERVED_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OBSERVED_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const OBSERVED_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const OBSERVED_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const CONTROL_CHARACTER_GLOBAL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/gu;
const LOCAL_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|tmp|var|etc|opt|Volumes|mnt|srv|root)\/)[^\s"'`<>\]\}\),;]+/giu;
const OBSERVED_FIXTURE_KEY_PATTERN = /path|secret|token|password|credential|private[-_ ]?key|package|connection|endpoint|url/i;
const CODEX_CONTEXT_MAX_BYTES = 16 * 1024;
const CODEX_CONTEXT_FIELDS = [
  "targetId",
  "targetGeneration",
  "architectureId",
  "environmentId",
  "profileId",
  "adapterDigest",
  "capabilitiesDigest",
] as const;
const CODEX_OBSERVATION_OPTIONS = new Set([
  "root",
  "profile",
  "context",
  "context-file",
  "target-id",
  "generation",
  "architecture-id",
  "environment-id",
  "profile-id",
  "adapter-digest",
  "capabilities-digest",
  "health",
  "json",
]);

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface CliPrompt {
  text: (label: string) => Promise<string>;
  secret: (label: string) => Promise<string>;
}

export type StoredCliTokenKind = "session" | "api";

export interface StoredCliToken {
  kind: StoredCliTokenKind;
  token: string;
  email?: string;
  expiresAt?: string;
}

export interface CliTokenStore {
  get: (apiUrl: string) => Promise<StoredCliToken | null>;
  set: (apiUrl: string, token: StoredCliToken) => Promise<void>;
  delete: (apiUrl: string) => Promise<void>;
  describe?: () => Promise<CliTokenStoreInfo> | CliTokenStoreInfo;
}

export interface CliTokenStoreInfo {
  backend: "keyring" | "file" | "memory";
  filePath?: string;
  fallbackFilePath?: string;
}

export interface CliConfigStore {
  getApiUrl: () => string | undefined;
  setApiUrl: (apiUrl: string) => Promise<void>;
  resetApiUrl: () => Promise<void>;
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  headers?: Headers | Record<string, string>;
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface CliRuntime {
  env: Record<string, string | undefined>;
  io: CliIo;
  fetch: FetchLike;
  configStore?: CliConfigStore;
  prompt?: CliPrompt;
  tokenStore?: CliTokenStore;
  /** Test-only clock seam for deterministic local target observations. */
  codexAdapterClock?: () => Date;
  /** Test-only fault seam for deterministic install crash-recovery coverage. */
  installFault?: (point: InstallFaultPoint) => void | Promise<void>;
  /** Internal executor fence, checked immediately before either promotion. */
  beforeInstallPromotion?: () => Promise<void>;
}

export type InstallFaultPoint = "prepared" | "previous-staged" | "installed" | "registry-committed";

interface ParsedArgs {
  command: string;
  args: string[];
  options: Record<string, string | boolean | string[]>;
}

export async function runCli(argv: string[], runtime: CliRuntime): Promise<number> {
  let parsed: ParsedArgs;
  try { parsed = parseArgs(argv); }
  catch { runtime.io.stderr("Invalid command options."); return 2; }
  try {
    if (["install", "list", "update", "updates", "rollback", "companion", "codex", "doctor"].includes(parsed.command)) {
      if (parsed.options.workspace && parsed.options.dir) throw new CliError("Choose --workspace or --dir, not both.", 2);
      const workspace = optionalStringOption(parsed, "workspace");
      if (workspace) {
        if (!path.isAbsolute(workspace)) throw new CliError("Workspace must be an absolute directory.", 2);
        if (parsed.options.platform && parsed.options.platform !== "codex") throw new CliError("Workspace installation supports the Codex platform.", 2);
        await assertRegularDirectory(workspace);
        const canonicalWorkspace = await realpath(workspace);
        if (canonicalWorkspace === os.homedir() || [".codex", ".agents"].some((directory) => {
          const relative = path.relative(path.join(os.homedir(), directory), canonicalWorkspace);
          return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
        })) throw new CliError("Choose a project workspace, not global configuration.", 2);
        await ensureSafeDirectory(canonicalWorkspace, path.join(canonicalWorkspace, ".agents", "skills"));
        parsed.options.workspace = canonicalWorkspace;
      }
      const root = installRoot(parsed, runtime);
      return await withInstallRootLock(root, async (canonicalRoot) => {
        parsed.options.dir = canonicalRoot;
        if (!workspace && ["install", "update", "rollback"].includes(parsed.command)) {
          try {
            await lstat(workspaceBindingPath(canonicalRoot));
            throw new CliError("This installation root belongs to an enrolled Codex workspace. Use --workspace for workspace mutations.", 2);
          } catch (error) { if (!isNodeError(error) || error.code !== "ENOENT") throw error; }
        }
        return dispatchCli(parsed, runtime);
      });
    }
    return await dispatchCli(parsed, runtime);
  } catch (error) {
    if (error instanceof CliError) {
      if (parsed.options.json) runtime.io.stderr(JSON.stringify({ error: error.toJSON() }, null, 2));
      else runtime.io.stderr(error.message);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : "Unexpected CLI failure.";
    if (parsed.options.json) runtime.io.stderr(JSON.stringify({ error: { code: "UNEXPECTED_CLI_FAILURE", message } }, null, 2));
    else runtime.io.stderr(message);
    return 1;
  }
}

async function dispatchCli(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
    switch (parsed.command) {
      case "":
      case "help":
      case "--help":
      case "-h":
        runtime.io.stdout(helpText());
        return 0;
      case "version":
      case "--version":
      case "-v":
        runtime.io.stdout(CLI_VERSION);
        return 0;
      case "validate":
        return await validateCommand(parsed, runtime);
      case "scan":
        return await scanCommand(parsed, runtime);
      case "search":
        return await searchCommand(parsed, runtime);
      case "info":
        return await infoCommand(parsed, runtime);
      case "login":
        return await loginCommand(parsed, runtime);
      case "logout":
        return await logoutCommand(parsed, runtime);
      case "whoami":
        return await whoamiCommand(parsed, runtime);
      case "auth":
        return await authCommand(parsed, runtime);
      case "config":
        return await configCommand(parsed, runtime);
      case "doctor":
        return await doctorCommand(parsed, runtime);
      case "submit":
        return await submitCommand(parsed, runtime);
      case "review":
        return await reviewCommand(parsed, runtime);
      case "submissions":
        return await submissionsCommand(parsed, runtime);
      case "skills":
        return await skillsCommand(parsed, runtime);
      case "releases":
        return await releasesCommand(parsed, runtime);
      case "teams":
        return await teamsCommand(parsed, runtime);
      case "sharing":
        return await sharingCommand(parsed, runtime);
      case "architecture":
      case "architectures":
        return await architecturesCommand(parsed, runtime);
      case "admin":
        return await adminCommand(parsed, runtime);
      case "export":
        return await exportCommand(parsed, runtime);
      case "install":
        return await installCommand(parsed, runtime);
      case "list":
        return await listInstalledCommand(parsed, runtime);
      case "update":
        return await updateCommand(parsed, runtime);
      case "updates":
        return await updatesCommand(parsed, runtime);
      case "rollback":
        return await rollbackCommand(parsed, runtime);
      case "companion":
        return await companionCommand(parsed, runtime);
      case "codex":
        return await codexWorkspaceCommand(parsed, runtime);
      case "token":
        return await tokenCommand(parsed, runtime);
      default:
        throw new CliError(`Unknown command: ${parsed.command}`, 2);
    }
}

async function validateCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const manifest = await loadSkillManifestFromPath(requiredPath(parsed));
  if (parsed.options.json) {
    runtime.io.stdout(JSON.stringify({ manifest }, null, 2));
  } else {
    runtime.io.stdout(`valid ${manifest.name}@${manifest.version}`);
  }
  return 0;
}

async function scanCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const result = await scanPackagePath(requiredPath(parsed));
  if (parsed.options.json) {
    runtime.io.stdout(JSON.stringify(result, null, 2));
  } else {
    printScanResult(result, runtime.io);
  }
  return hasBlockingFindings(result.findings) ? 1 : 0;
}

async function searchCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const query = parsed.args.join(" ").trim();
  const response = await apiGet(
    `/v1/skills${query ? `?q=${encodeURIComponent(query)}` : ""}`,
    parsed,
    runtime,
    await tokenOption(parsed, runtime) ?? undefined,
  );
  if (parsed.options.json) {
    runtime.io.stdout(JSON.stringify(response, null, 2));
  } else {
    const skills = response.skills as Array<{ slug: string; title: string; latestVersion: string | null }>;
    if (skills.length === 0) {
      runtime.io.stdout("No skills found.");
    } else {
      for (const skill of skills) {
        runtime.io.stdout(`${skill.slug}\t${skill.latestVersion ?? "-"}\t${skill.title}`);
      }
    }
  }
  return 0;
}

async function infoCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const slug = parsed.args[0];
  if (!slug) {
    throw new CliError("Usage: myskills info <skill-slug>", 2);
  }
  const response = await apiGet(
    `/v1/skills/${encodeURIComponent(slug)}`,
    parsed,
    runtime,
    await tokenOption(parsed, runtime) ?? undefined,
  );
  if (parsed.options.json) {
    runtime.io.stdout(JSON.stringify(response, null, 2));
  } else {
    const skill = response.skill as {
      slug: string;
      title: string;
      summary: string;
      latestVersion: string | null;
      platforms: Array<{ name: string; installTarget: string; status: string }>;
      tags: string[];
    };
    runtime.io.stdout(`${skill.title} (${skill.slug})`);
    runtime.io.stdout(`version: ${skill.latestVersion ?? "-"}`);
    runtime.io.stdout(`platforms: ${skill.platforms.map((platform) => platform.name).join(", ") || "-"}`);
    runtime.io.stdout(`tags: ${skill.tags.join(", ") || "-"}`);
    runtime.io.stdout(skill.summary);
  }
  return 0;
}

async function loginCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const tokenStore = runtime.tokenStore;
  if (!tokenStore) {
    throw new CliError("No token store is configured. Set MYSKILLS_TOKEN for one-off commands.", 1);
  }
  const apiUrl = await loginApiUrl(parsed, runtime);
  parsed.options["api-url"] = apiUrl;
  const method = await loginAuthMethod(parsed, runtime);
  if (method === "api-key") {
    return await loginWithApiKey(parsed, runtime, apiUrl, tokenStore);
  }
  return await loginWithPassword(parsed, runtime, apiUrl, tokenStore);
}

async function loginWithPassword(parsed: ParsedArgs, runtime: CliRuntime, apiUrl: string, tokenStore: CliTokenStore): Promise<number> {
  const email = optionalStringOption(parsed, "email") ?? await promptText(runtime, "Email: ");
  const password = await promptSecret(runtime, "Password: ");
  const loginResponse = await apiPost("/v1/auth/login", { email: email.trim(), password }, parsed, runtime);
  const session = loginResponse.mfaRequired === true
    ? await completeMfaLogin(loginResponse, parsed, runtime)
    : authSessionFromResponse(loginResponse);

  await tokenStore.set(apiUrl, {
    kind: "session",
    token: session.token,
    email: session.email,
    expiresAt: session.expiresAt,
  });
  await runtime.configStore?.setApiUrl(apiUrl);
  runtime.io.stdout(`${session.email ?? email.trim()}\tlogged-in\texpires=${session.expiresAt}`);
  return 0;
}

async function loginWithApiKey(parsed: ParsedArgs, runtime: CliRuntime, apiUrl: string, tokenStore: CliTokenStore): Promise<number> {
  const apiKey = await promptSecret(runtime, "API key: ");
  const response = await apiGet("/v1/me", parsed, runtime, apiKey);
  const user = response.user as { email?: string };
  await tokenStore.set(apiUrl, {
    kind: "api",
    token: apiKey,
    email: user.email,
  });
  await runtime.configStore?.setApiUrl(apiUrl);
  runtime.io.stdout(`${user.email ?? "api-key"}\tapi-key-stored`);
  return 0;
}

async function completeMfaLogin(loginResponse: Record<string, unknown>, parsed: ParsedArgs, runtime: CliRuntime): Promise<AuthSession> {
  const challengeToken = stringFromRecord(loginResponse, "challengeToken", "API login response is missing MFA challenge token.");
  const mfaValue = (await promptSecret(runtime, "MFA code or recovery code: ")).trim();
  if (!mfaValue) {
    throw new CliError("MFA code is required.", 2);
  }
  const verifyResponse = await apiPost(
    "/v1/auth/mfa/verify",
    /^[0-9]{6}$/.test(mfaValue)
      ? { challengeToken, code: mfaValue }
      : { challengeToken, recoveryCode: mfaValue },
    parsed,
    runtime,
  );
  return authSessionFromResponse(verifyResponse);
}

async function logoutCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const apiUrl = apiBaseUrl(parsed, runtime);
  let resolved: ResolvedToken | null;
  try { resolved = await resolveToken(parsed, runtime); }
  catch (error) {
    if (!runtime.tokenStore || parsed.options.token || runtime.env.MYSKILLS_TOKEN) throw error;
    try { await runtime.tokenStore.delete(apiUrl); }
    catch {
      throw new CliError("Stored credentials could not be read and local cleanup failed. Check credential-store access and retry logout. Remote revocation could not be confirmed.", 1, "LOGOUT_CLEANUP_FAILED");
    }
    runtime.io.stdout("local credentials removed\tremote-revocation-unconfirmed");
    throw new CliError("Stored credentials were unreadable. Local cleanup succeeded, but remote revocation could not be confirmed. Revoke the session or API token through the account settings.", 1, "LOGOUT_REMOTE_UNCONFIRMED");
  }
  if (!resolved) {
    throw new CliError("Not logged in. Run myskills login, set MYSKILLS_TOKEN, or pass --token.", 1);
  }
  if (resolved.source === "store" && resolved.stored.kind === "api") {
    await runtime.tokenStore?.delete(apiBaseUrl(parsed, runtime));
    runtime.io.stdout("logged out\tlocal-only\tapi-token-not-revoked");
    return 0;
  }
  await apiPost("/v1/auth/logout", {}, parsed, runtime, resolved.value);
  if (resolved.source === "store") {
    await runtime.tokenStore?.delete(apiBaseUrl(parsed, runtime));
    runtime.io.stdout("logged out\tserver-revoked");
  } else {
    runtime.io.stdout("logout requested\tstored-token-unchanged");
  }
  return 0;
}

async function whoamiCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const token = await tokenOption(parsed, runtime);
  if (!token) {
    throw new CliError("No token provided. Run myskills login, set MYSKILLS_TOKEN, or pass --token.", 1);
  }
  const response = await apiGet("/v1/me", parsed, runtime, token);
  if (parsed.options.json) {
    runtime.io.stdout(JSON.stringify(response, null, 2));
  } else {
    const user = response.user as { email: string; roles: string[]; mfaVerified: boolean };
    runtime.io.stdout(`${user.email}\troles=${user.roles.join(",")}\tmfa=${user.mfaVerified ? "verified" : "not-verified"}`);
  }
  return 0;
}

async function authCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const subcommand = parsed.args[0];
  if (subcommand === "status") {
    return await authStatusCommand(parsed, runtime);
  }
  throw new CliError("Usage: myskills auth status", 2, "USAGE_ERROR");
}

async function authStatusCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const api = apiBaseUrlResolution(parsed, runtime);
  const resolved = await resolveToken(parsed, runtime);
  if (!resolved) {
    const status = {
      apiUrl: api.url,
      apiUrlSource: api.source,
      status: "not_logged_in",
      tokenSource: "none",
      tokenStore: await tokenStoreInfo(runtime),
    };
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(status, null, 2));
    } else {
      runtime.io.stdout(`API URL: ${status.apiUrl} (${status.apiUrlSource})`);
      runtime.io.stdout("Status: not logged in");
      runtime.io.stdout(`Token store: ${status.tokenStore.backend}`);
    }
    return 0;
  }

  const response = await apiGet("/v1/me", parsed, runtime, resolved.value);
  const user = response.user as { email: string; roles: string[]; mfaVerified: boolean };
  const status = {
    apiUrl: api.url,
    apiUrlSource: api.source,
    status: "logged_in",
    tokenSource: resolved.source,
    tokenKind: resolved.stored.kind,
    tokenStore: await tokenStoreInfo(runtime),
    user: {
      email: user.email,
      roles: user.roles,
      mfaVerified: user.mfaVerified,
    },
    expiresAt: resolved.stored.expiresAt ?? null,
  };
  if (parsed.options.json) {
    runtime.io.stdout(JSON.stringify(status, null, 2));
  } else {
    runtime.io.stdout(`API URL: ${status.apiUrl} (${status.apiUrlSource})`);
    runtime.io.stdout(`Status: logged in (${status.tokenKind}, ${status.tokenSource})`);
    runtime.io.stdout(`User: ${user.email}`);
    runtime.io.stdout(`Roles: ${user.roles.join(",") || "-"}`);
    runtime.io.stdout(`MFA: ${user.mfaVerified ? "verified" : "not-verified"}`);
    runtime.io.stdout(`Expires: ${status.expiresAt ?? "-"}`);
    runtime.io.stdout(`Token store: ${status.tokenStore.backend}`);
  }
  return 0;
}

async function configCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const subcommand = parsed.args[0];
  const key = parsed.args[1];
  if (!runtime.configStore) {
    throw new CliError("No config store is configured.", 1, "CONFIG_STORE_UNAVAILABLE");
  }
  if (subcommand === "get" && key === "api-url") {
    const apiUrl = runtime.configStore.getApiUrl() ?? null;
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify({ apiUrl }, null, 2));
    } else {
      runtime.io.stdout(apiUrl ?? "unset");
    }
    return 0;
  }
  if (subcommand === "set" && key === "api-url") {
    const apiUrl = parsed.args[2];
    if (!apiUrl) {
      throw new CliError("Usage: myskills config set api-url <url>", 2, "USAGE_ERROR");
    }
    await runtime.configStore.setApiUrl(normalizeApiUrlOption(apiUrl));
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify({ apiUrl: normalizeApiUrlOption(apiUrl) }, null, 2));
    } else {
      runtime.io.stdout(`api-url=${normalizeApiUrlOption(apiUrl)}`);
    }
    return 0;
  }
  if (subcommand === "reset" && key === "api-url") {
    await runtime.configStore.resetApiUrl();
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify({ apiUrl: null }, null, 2));
    } else {
      runtime.io.stdout("api-url unset");
    }
    return 0;
  }
  if (subcommand === "list") {
    const resolved = apiBaseUrlResolution(parsed, runtime);
    const saved = runtime.configStore.getApiUrl() ?? null;
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify({ apiUrl: saved, resolvedApiUrl: resolved.url, resolvedApiUrlSource: resolved.source }, null, 2));
    } else {
      runtime.io.stdout(`api-url=${saved ?? "unset"}`);
      runtime.io.stdout(`resolved-api-url=${resolved.url}\tsource=${resolved.source}`);
    }
    return 0;
  }
  throw new CliError("Usage: myskills config get api-url | config set api-url <url> | config reset api-url | config list", 2, "USAGE_ERROR");
}

async function doctorCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const api = apiBaseUrlResolution(parsed, runtime);
  const checks: DoctorCheck[] = [];
  checks.push(nodeVersionCheck());
  checks.push({ name: "cli_version", ok: true, message: CLI_VERSION, details: { version: CLI_VERSION } });
  checks.push({ name: "api_url", ok: true, message: `${api.url} (${api.source})`, details: api });

  const health = await doctorHealthCheck(parsed, runtime);
  checks.push(health);
  const token = await resolveToken(parsed, runtime);
  checks.push(await doctorAuthCheck(parsed, runtime, token));
  checks.push(await doctorTokenStoreCheck(runtime));
  checks.push(await doctorInstallDirCheck(parsed, runtime));
  checks.push(await doctorCapabilitiesCheck(parsed, runtime));

  const failed = checks.filter((check) => !check.ok);
  const result = {
    cliVersion: CLI_VERSION,
    apiUrl: api.url,
    apiUrlSource: api.source,
    checks,
  };
  if (parsed.options.json) {
    runtime.io.stdout(JSON.stringify(result, null, 2));
  } else {
    runtime.io.stdout(`MySkills CLI ${CLI_VERSION}`);
    runtime.io.stdout("");
    for (const check of checks) {
      runtime.io.stdout(`${check.ok ? "ok" : "fail"}\t${check.name}\t${check.message}`);
    }
  }
  return failed.length === 0 ? 0 : 1;
}

async function tokenCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const token = await tokenOption(parsed, runtime);
  if (!token) {
    throw new CliError("No token provided. Run myskills login, set MYSKILLS_TOKEN, or pass --token.", 1);
  }
  const subcommand = parsed.args[0];
  if (subcommand === "create") {
    const name = stringOption(parsed, "name");
    const scopes = stringListOption(parsed, "scope");
    if (scopes.length === 0) {
      throw new CliError("--scope is required.", 2);
    }
    const expiresAt = optionalStringOption(parsed, "expires-at");
    const response = await apiPost("/v1/auth/api-tokens", {
      name,
      scopes,
      ...(expiresAt ? { expiresAt } : {}),
    }, parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      const created = response.token as {
        name: string;
        token: string;
        tokenPrefix: string;
        scopes: string[];
        expiresAt: string;
      };
      runtime.io.stdout(`${created.name}\t${created.tokenPrefix}\t${created.scopes.join(",")}\texpires=${created.expiresAt}`);
      runtime.io.stdout(`token: ${created.token}`);
    }
    return 0;
  }
  if (subcommand === "list") {
    const response = await apiGet("/v1/auth/api-tokens", parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      const tokens = response.tokens as Array<{
        id: string;
        name: string;
        tokenPrefix: string;
        scopes: string[];
        expiresAt: string;
        revokedAt: string | null;
      }>;
      if (tokens.length === 0) {
        runtime.io.stdout("No API tokens.");
      } else {
        for (const apiToken of tokens) {
          runtime.io.stdout(`${apiToken.id}\t${apiToken.name}\t${apiToken.tokenPrefix}\t${apiToken.scopes.join(",")}\texpires=${apiToken.expiresAt}\trevoked=${apiToken.revokedAt ?? "-"}`);
        }
      }
    }
    return 0;
  }
  if (subcommand === "revoke") {
    const tokenId = parsed.args[1];
    if (!tokenId) {
      throw new CliError("Usage: myskills token revoke <token-id>", 2);
    }
    const response = await apiDelete(`/v1/auth/api-tokens/${encodeURIComponent(tokenId)}`, parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      const revoked = response.token as { id: string; name: string; revokedAt: string | null };
      runtime.io.stdout(`${revoked.id}\t${revoked.name}\trevoked=${revoked.revokedAt ?? "-"}`);
    }
    return 0;
  }
  throw new CliError("Usage: myskills token create|list|revoke", 2);
}

async function reviewCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const token = await tokenOption(parsed, runtime);
  if (!token) {
    throw new CliError("No token provided. Run myskills login, set MYSKILLS_TOKEN, or pass --token.", 1);
  }
  const subcommand = parsed.args[0];
  if (subcommand === "submissions") {
    const response = await apiGet("/v1/review/submissions", parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      const submissions = response.submissions as Array<{
        id: string;
        slug: string;
        version: string;
        reviewStatus: string;
        securityStatus: string;
        findingCount: number;
      }>;
      if (submissions.length === 0) {
        runtime.io.stdout("No submissions awaiting review.");
      } else {
        for (const submission of submissions) {
          runtime.io.stdout(`${submission.id}\t${submission.slug}@${submission.version}\t${submission.reviewStatus}\t${submission.securityStatus}\tfindings=${submission.findingCount}`);
        }
      }
    }
    return 0;
  }
  if (subcommand === "action") {
    const submissionId = parsed.args[1];
    if (!submissionId) {
      throw new CliError("Usage: myskills review action <submission-id> --action <approve|request-changes|reject|publish> [--artifact-sha256 <hash>] [--reason <text>] [--api-url <url>] [--token <token>]", 2);
    }
    const action = stringOption(parsed, "action");
    if (action !== "approve" && action !== "request-changes" && action !== "reject" && action !== "publish") {
      throw new CliError("--action must be approve, request-changes, reject, or publish.", 2);
    }
    const reason = optionalStringOption(parsed, "reason");
    const artifactSha256 = optionalStringOption(parsed, "artifact-sha256")?.toLowerCase();
    if (action === "approve" && !isArtifactSha256(artifactSha256)) {
      throw new CliError("--artifact-sha256 is required when approving a submission and must be a 64-character SHA-256 hex digest.", 2);
    }
    const response = await apiPost(`/v1/review/submissions/${encodeURIComponent(submissionId)}/actions`, {
      action,
      ...(reason ? { reason } : {}),
      ...(action === "approve" ? { artifactSha256 } : {}),
    }, parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      const submission = response.submission as {
        slug: string;
        version: string;
        reviewStatus: string;
        securityStatus: string;
        publishedAt: string | null;
      };
      runtime.io.stdout(`${submission.slug}@${submission.version}\t${submission.reviewStatus}\t${submission.securityStatus}\tpublished=${submission.publishedAt ?? "-"}`);
    }
    return 0;
  }
  if (subcommand === "bundle") {
    const submissionId = parsed.args[1];
    if (!submissionId) {
      throw new CliError("Usage: myskills review bundle <submission-id> [--platform <name>] [--output <file>] [--api-url <url>] [--token <token>]", 2);
    }
    const platform = optionalStringOption(parsed, "platform");
    const query = platform ? `?platform=${encodeURIComponent(platform)}` : "";
    const response = await apiGetWithHeaders(`/v1/review/submissions/${encodeURIComponent(submissionId)}/bundle${query}`, parsed, runtime, token);
    const artifactSha256 = response.headers["x-myskills-artifact-sha256"] ?? "";
    if (!isArtifactSha256(artifactSha256)) {
      throw new CliError("Review bundle response is missing artifact hash.", 1);
    }
    const outputPath = optionalStringOption(parsed, "output");
    if (outputPath) {
      await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
      await writeFile(path.resolve(outputPath), response.text, { encoding: "utf8", mode: 0o600 });
    }
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify({
        artifactSha256,
        ...(outputPath ? { output: path.resolve(outputPath) } : {}),
        payload: parseJsonResponse(`/v1/review/submissions/${submissionId}/bundle`, apiBaseUrl(parsed, runtime), response.text),
      }, null, 2));
    } else {
      runtime.io.stdout(`artifactSha256=${artifactSha256}${outputPath ? `\toutput=${path.resolve(outputPath)}` : ""}`);
    }
    return 0;
  }
  throw new CliError("Usage: myskills review submissions | review bundle <submission-id> | review action <submission-id> --action <approve|request-changes|reject|publish> [--artifact-sha256 <hash>] [--reason <text>]", 2);
}

async function submissionsCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const token = await requireToken(parsed, runtime);
  const subcommand = parsed.args[0];
  if (subcommand === "list" || subcommand === "mine") {
    const response = await apiGet("/v1/submissions/mine", parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      const submissions = arrayField(response, "submissions");
      if (submissions.length === 0) {
        runtime.io.stdout("No submissions.");
      } else {
        for (const value of submissions) {
          const submission = recordField(value, "submission");
          runtime.io.stdout([
            requiredRecordString(submission, "id", "Submission response is missing id."),
            `${requiredRecordString(submission, "slug", "Submission response is missing slug.")}@${requiredRecordString(submission, "version", "Submission response is missing version.")}`,
            optionalRecordString(submission, "reviewStatus") ?? "-",
            optionalRecordString(submission, "lifecycleStatus") ?? "-",
            optionalRecordString(submission, "securityStatus") ?? "-",
          ].join("\t"));
        }
      }
    }
    return 0;
  }
  if (subcommand === "withdraw") {
    const submissionId = parsed.args[1];
    if (!submissionId) {
      throw new CliError("Usage: myskills submissions withdraw <submission-id> [--reason <text>] [--api-url <url>] [--token <token>]", 2);
    }
    const response = await apiPost(`/v1/submissions/${encodeURIComponent(submissionId)}/actions`, {
      action: "withdraw",
      ...reasonPayload(parsed),
    }, parsed, runtime, token);
    printNamedRecord(response, "submission", runtime.io, ["id", "slug", "version", "reviewStatus", "lifecycleStatus"]);
    return 0;
  }
  throw new CliError("Usage: myskills submissions list | submissions withdraw <submission-id> [--reason <text>] [--api-url <url>] [--token <token>]", 2);
}

async function skillsCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const subcommand = parsed.args[0];
  const slug = parsed.args[1];
  if (subcommand === "edit") {
    const token = await requireToken(parsed, runtime);
    if (!slug) {
      throw new CliError("Usage: myskills skills edit <skill-slug> [--title <text>] [--summary <text>] [--tag <tag>] [--visibility <scope>] [--reason <text>] [--api-url <url>] [--token <token>]", 2);
    }
    const organizationOptionProvided = parsed.options.organization !== undefined
      || parsed.options["organization-id"] !== undefined;
    if (parsed.options["clear-organizations"] === true || organizationOptionProvided) {
      throw new CliError("Organization grant options are only supported by myskills sharing set; the deprecated skills edit --visibility alias preserves omitted grants.", 2);
    }
    const visibility = Object.prototype.hasOwnProperty.call(parsed.options, "visibility")
      ? visibilityOption(parsed)
      : undefined;
    if (visibility !== undefined) {
      runtime.io.stderr("Warning: `skills edit --visibility` is deprecated; use `myskills sharing set <skill-slug> --visibility <scope>`.");
    }
    // Keep the beta.2 endpoint for API-token clients. The API compatibility
    // shim delegates this field to canonical complete-set sharing updates.
    const payload: Record<string, unknown> = {
      ...reasonPayload(parsed),
      ...(visibility === undefined ? {} : { visibility }),
    };
    const title = optionalStringOption(parsed, "title");
    const summary = optionalStringOption(parsed, "summary");
    const tags = stringListOption(parsed, "tag");
    if (title !== undefined) {
      payload.title = title;
    }
    if (summary !== undefined) {
      payload.summary = summary;
    }
    if (tags.length > 0) {
      payload.tags = tags;
    }
    if (title === undefined && summary === undefined && tags.length === 0 && visibility === undefined) {
      throw new CliError("At least one metadata option is required.", 2);
    }
    const response = await apiPut(`/v1/skills/${encodeURIComponent(parseInstallSlug(slug))}`, payload, parsed, runtime, token);
    printNamedRecord(response, "skill", runtime.io, ["slug", "title", "lifecycleStatus", "visibility"]);
    return 0;
  }
  const token = await requireToken(parsed, runtime);
  if (subcommand === "archive" || subcommand === "restore" || subcommand === "delete") {
    if (!slug) {
      throw new CliError("Usage: myskills skills archive|restore|delete <skill-slug> [--reason <text>] [--api-url <url>] [--token <token>]", 2);
    }
    const response = await apiPost(`/v1/skills/${encodeURIComponent(parseInstallSlug(slug))}/actions`, {
      action: subcommand,
      ...reasonPayload(parsed),
    }, parsed, runtime, token);
    printNamedRecord(response, "skill", runtime.io, ["slug", "title", "lifecycleStatus", "visibility"]);
    return 0;
  }
  throw new CliError("Usage: myskills skills edit|archive|restore|delete <skill-slug> [--api-url <url>] [--token <token>]", 2);
}

async function releasesCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const subcommand = parsed.args[0];
  if (subcommand === "list") {
    const slug = parsed.args[1];
    if (!slug) {
      throw new CliError("Usage: myskills releases list <skill-slug>", 2);
    }
    const token = await tokenOption(parsed, runtime) ?? undefined;
    const response = await apiGet(`/v1/skills/${encodeURIComponent(parseInstallSlug(slug))}/releases`, parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      const releases = arrayField(response, "releases");
      if (releases.length === 0) {
        runtime.io.stdout("No releases.");
      } else {
        for (const value of releases) {
          const release = recordField(value, "release");
          runtime.io.stdout([
            `${requiredRecordString(release, "slug", "Release response is missing slug.")}@${requiredRecordString(release, "version", "Release response is missing version.")}`,
            optionalRecordString(release, "lifecycleStatus") ?? "-",
            optionalRecordString(release, "reviewStatus") ?? "-",
            optionalRecordString(release, "securityStatus") ?? "-",
            `published=${optionalRecordString(release, "publishedAt") ?? "-"}`,
          ].join("\t"));
        }
      }
    }
    return 0;
  }
  if (["deprecate", "unpublish", "revoke", "restore", "delete"].includes(subcommand ?? "")) {
    const target = parsed.args[1];
    if (!target) {
      throw new CliError("Usage: myskills releases deprecate|unpublish|revoke|restore|delete <skill-slug>@<version> [--reason <text>] [--replacement <version>] [--api-url <url>] [--token <token>]", 2);
    }
    const { slug, version } = parseReleaseTarget(target);
    const token = await requireToken(parsed, runtime);
    const response = await apiPost(`/v1/skills/${encodeURIComponent(slug)}/releases/${encodeURIComponent(version)}/actions`, {
      action: subcommand,
      ...reasonPayload(parsed),
      ...(optionalStringOption(parsed, "replacement") ? { replacement: optionalStringOption(parsed, "replacement") } : {}),
    }, parsed, runtime, token);
    printNamedRecord(response, "release", runtime.io, ["slug", "version", "lifecycleStatus", "reviewStatus", "securityStatus"]);
    return 0;
  }
  throw new CliError("Usage: myskills releases list <skill-slug> | releases deprecate|unpublish|revoke|restore|delete <skill-slug>@<version> [--api-url <url>] [--token <token>]", 2);
}

async function teamsCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const token = await requireToken(parsed, runtime);
  const subcommand = parsed.args[0];
  if (subcommand === "list") {
    const response = await apiGet("/v1/teams", parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      printTeamDashboard(response, runtime.io);
    }
    return 0;
  }
  if (subcommand === "create") {
    const name = optionalStringOption(parsed, "name") ?? parsed.args.slice(1).join(" ").trim();
    if (!name) {
      throw new CliError("Usage: myskills teams create <team-name> [--name <team-name>]", 2);
    }
    const response = await apiPost("/v1/teams", { name }, parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      const team = teamFromResponse(response);
      runtime.io.stdout(`${team.id}\t${team.name}\tcreated\trole=${team.role}`);
    }
    return 0;
  }
  if (subcommand === "invite") {
    const teamId = parsed.args[1];
    if (!teamId) {
      throw new CliError("Usage: myskills teams invite <team-id> --email <email>", 2);
    }
    const email = stringOption(parsed, "email");
    const response = await apiPost(`/v1/teams/${encodeURIComponent(teamId)}/invitations`, { email }, parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      const invitation = invitationFromResponse(response);
      runtime.io.stdout(`${invitation.id}\t${invitation.email}\tinvited\tteam=${invitation.teamName}\tstatus=${invitation.status}`);
    }
    return 0;
  }
  if (subcommand === "accept") {
    const invitationId = parsed.args[1];
    if (!invitationId) {
      throw new CliError("Usage: myskills teams accept <invitation-id>", 2);
    }
    const response = await apiPost(`/v1/teams/invitations/${encodeURIComponent(invitationId)}/accept`, {}, parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      const invitation = invitationFromResponse(response);
      runtime.io.stdout(`${invitation.id}\t${invitation.teamName}\taccepted\tstatus=${invitation.status}`);
    }
    return 0;
  }
  if (subcommand === "skills" || subcommand === "shared-skills") {
    const response = await apiGet("/v1/teams/shared-skills", parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      printTeamSharedSkills(response, runtime.io);
    }
    return 0;
  }
  throw new CliError("Usage: myskills teams list|create|invite|accept|skills", 2);
}

async function sharingCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const token = await requireToken(parsed, runtime);
  const subcommand = parsed.args[0];
  const slug = parsed.args[1];
  if (subcommand === "get") {
    if (!slug) {
      throw new CliError("Usage: myskills sharing get <skill-slug>", 2);
    }
    const response = await apiGet(`/v1/skills/${encodeURIComponent(parseInstallSlug(slug))}/sharing`, parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      printSkillSharing(response, runtime.io);
    }
    return 0;
  }
  if (subcommand === "set") {
    if (!slug) {
      throw new CliError("Usage: myskills sharing set <skill-slug> --visibility <scope> [--team <team-id>] [--user <email>] [--organization <organization-id>] [--organization-id <organization-id>] [--clear-organizations]", 2);
    }
    const visibility = visibilityOption(parsed);
    const organizationIds = [
      ...stringListOption(parsed, "organization"),
      ...stringListOption(parsed, "organization-id"),
    ];
    const organizationOptionProvided = parsed.options.organization !== undefined
      || parsed.options["organization-id"] !== undefined;
    const clearOrganizations = parsed.options["clear-organizations"] === true;
    if (clearOrganizations && organizationOptionProvided) {
      throw new CliError("--clear-organizations cannot be combined with --organization or --organization-id.", 2);
    }
    const response = await apiPut(`/v1/skills/${encodeURIComponent(parseInstallSlug(slug))}/sharing`, {
      visibility,
      teamIds: stringListOption(parsed, "team"),
      userEmails: stringListOption(parsed, "user"),
      ...(clearOrganizations || organizationOptionProvided ? { organizationIds: clearOrganizations ? [] : organizationIds } : {}),
    }, parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      printSkillSharing(response, runtime.io);
    }
    return 0;
  }
  throw new CliError("Usage: myskills sharing get|set <skill-slug>", 2);
}

async function architecturesCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const subcommand = parsed.args[0] ?? "list";
  if (subcommand === "patterns") {
    const response = await apiGet(
      "/v1/architecture-patterns",
      parsed,
      runtime,
      await tokenOption(parsed, runtime) ?? undefined,
    );
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(safeArchitecturePatternsResponse(response), null, 2));
    } else {
      printArchitecturePatterns(response, runtime.io);
    }
    return 0;
  }

  if (subcommand === "observe" || subcommand === "health") {
    return await codexTargetObservationCommand(parsed, runtime, subcommand === "health");
  }

  const token = await requireToken(parsed, runtime);
  if (subcommand === "list") {
    const response = await apiGet("/v1/architectures", parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(safeArchitecturesResponse(response), null, 2));
    } else {
      printArchitectures(response, runtime.io);
    }
    return 0;
  }

  if (subcommand === "show") {
    const architectureId = parseArchitectureId(parsed.args[1]);
    const revisionId = architectureRevisionOption(parsed);
    const response = await apiGet(
      revisionId
        ? `/v1/architectures/${encodeURIComponent(architectureId)}/revisions/${encodeURIComponent(parseArchitectureRevisionId(revisionId))}`
        : `/v1/architectures/${encodeURIComponent(architectureId)}`,
      parsed,
      runtime,
      token,
    );
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(revisionId
        ? safeArchitectureRevisionResponse(response)
        : safeArchitectureDetailsResponse(response), null, 2));
    } else if (revisionId) {
      printArchitectureRevision(response, runtime.io);
    } else {
      printArchitectureDetails(response, runtime.io);
    }
    return 0;
  }

  if (subcommand === "preview" || subcommand === "compile") {
    const architectureId = parseArchitectureId(parsed.args[1]);
    const revisionId = architectureRevisionOption(parsed);
    const body = architecturePreviewOptions(parsed, revisionId);
    const response = await apiPost(
      `/v1/architectures/${encodeURIComponent(architectureId)}/preview`,
      body,
      parsed,
      runtime,
      token,
    );
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(safeArchitecturePreviewResponse(response), null, 2));
    } else {
      printArchitecturePreview(response, runtime.io, architectureId);
    }
    return 0;
  }

  if (subcommand === "plan" || subcommand === "dry-run") {
    const architectureId = parseArchitectureId(parsed.args[1]);
    const revisionId = architectureRevisionOption(parsed);
    const observedPath = optionalStringOption(parsed, "observed") ?? optionalStringOption(parsed, "observed-state");
    if (!observedPath) {
      throw new CliError("Usage: myskills architectures plan <architecture-id> --observed <fixture.json> [--revision <revision-id>] [--profile <profile-id>] [--environment <environment-id>] [--organization-id <organization-id>]", 2);
    }
    const observedState = await readObservedStateFixture(observedPath);
    const response = await apiPost(
      `/v1/architectures/${encodeURIComponent(architectureId)}/preview`,
      {
        ...architecturePreviewOptions(parsed, revisionId),
        fixture: apiSyncFixtureFromObservedState(observedState),
      },
      parsed,
      runtime,
      token,
    );
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(safeArchitecturePreviewResponse(response), null, 2));
    } else {
      printArchitecturePlan(response, runtime.io);
    }
    return 0;
  }

  throw new CliError("Usage: myskills architectures patterns | list | show <architecture-id> | preview|compile <architecture-id> [--revision <revision-id>] [--profile <profile-id>] [--environment <environment-id>] [--organization-id <organization-id>|--organization <organization-id>] | plan|dry-run <architecture-id> --observed <fixture.json> [--revision <revision-id>] [--profile <profile-id>] [--environment <environment-id>] [--organization-id <organization-id>|--organization <organization-id>] | observe|health", 2);
}

/**
 * Run the explicitly scoped local Codex adapter. This branch deliberately
 * stays before token resolution: it is a local read-only observation and does
 * not contact or upload to the API.
 */
async function codexTargetObservationCommand(
  parsed: ParsedArgs,
  runtime: CliRuntime,
  healthOnly: boolean,
): Promise<number> {
  assertCodexObservationOptions(parsed, healthOnly);
  const root = requiredCodexRoot(parsed);
  const profile = requiredCodexProfile(parsed);
  const context = await readCodexAdapterContext(parsed);
  const adapter = new CodexReadOnlyArchitectureTargetAdapter({
    root,
    profile,
    ...(runtime.codexAdapterClock ? { clock: runtime.codexAdapterClock } : {}),
  });

  if (healthOnly || parsed.options.health === true) {
    let health: ArchitectureTargetHealth;
    try {
      const result = validateArchitectureTargetHealth(await adapter.health(context));
      if (!result.valid) throw new Error("invalid health report");
      health = result.value;
    } catch {
      throw new CliError("Codex adapter returned an invalid metadata-only health report.", 1, "CODEX_TARGET_REPORT_INVALID");
    }
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(health, null, 2));
    } else {
      printCodexTargetHealth(health, runtime.io);
    }
    return 0;
  }

  let observation: ArchitectureTargetObservation;
  try {
    observation = assertValidArchitectureTargetObservation(await adapter.observe(context));
  } catch {
    throw new CliError("Codex adapter returned an invalid metadata-only observation.", 1, "CODEX_TARGET_REPORT_INVALID");
  }
  if (parsed.options.json) {
    runtime.io.stdout(JSON.stringify(observation, null, 2));
  } else {
    printCodexTargetObservation(observation, runtime.io);
  }
  return 0;
}

function assertCodexObservationOptions(parsed: ParsedArgs, healthOnly: boolean): void {
  if (parsed.args.length !== 1) {
    throw new CliError(
      `Usage: myskills architectures ${healthOnly ? "health" : "observe"} --root <absolute-dir> --profile <personal|work|shared> (--context <file> | --target-id <id> --generation <number> --architecture-id <id> --environment-id <id> --profile-id <id> --adapter-digest <sha256> --capabilities-digest <sha256>) [--json]`,
      2,
      "CODEX_TARGET_USAGE",
    );
  }
  for (const key of Object.keys(parsed.options)) {
    if (!CODEX_OBSERVATION_OPTIONS.has(key)) {
      throw new CliError("Codex target observation accepts only explicit root, profile, context, and metadata context options.", 2, "CODEX_TARGET_OPTION_INVALID");
    }
  }
  if (parsed.options.health !== undefined && parsed.options.health !== true) {
    throw new CliError("Codex target health mode must be a flag.", 2, "CODEX_TARGET_OPTION_INVALID");
  }
}

function requiredCodexRoot(parsed: ParsedArgs): string {
  const root = parsed.options.root;
  if (typeof root !== "string" || !root || hasControlCharacter(root) || !path.isAbsolute(root)) {
    throw new CliError("An explicit absolute --root is required; the CLI does not discover a Codex home or profile.", 2, "CODEX_TARGET_ROOT_INVALID");
  }
  return root;
}

function requiredCodexProfile(parsed: ParsedArgs): CodexAdapterProfile {
  const profile = parsed.options.profile;
  if (typeof profile !== "string" || !(codexAdapterProfiles as readonly string[]).includes(profile)) {
    throw new CliError("An explicit --profile of personal, work, or shared is required.", 2, "CODEX_TARGET_PROFILE_INVALID");
  }
  return profile as CodexAdapterProfile;
}

async function readCodexAdapterContext(parsed: ParsedArgs): Promise<ArchitectureTargetAdapterContext> {
  const contextOptions = ["context", "context-file"] as const;
  const suppliedContextPaths = contextOptions.filter((key) => parsed.options[key] !== undefined);
  if (suppliedContextPaths.length > 1) {
    throw new CliError("Pass one context JSON file, not multiple context options.", 2, "CODEX_TARGET_CONTEXT_INVALID");
  }

  const contextFlagNames = [
    "target-id",
    "generation",
    "architecture-id",
    "environment-id",
    "profile-id",
    "adapter-digest",
    "capabilities-digest",
  ] as const;
  const suppliedContextFlags = contextFlagNames.filter((key) => parsed.options[key] !== undefined);
  if (suppliedContextPaths.length > 0 && suppliedContextFlags.length > 0) {
    throw new CliError("Use either --context or all explicit context flags, not both.", 2, "CODEX_TARGET_CONTEXT_INVALID");
  }
  if (suppliedContextPaths.length === 0) {
    if (suppliedContextFlags.length !== contextFlagNames.length) {
      throw new CliError("Pass --context or all seven explicit context flags: --target-id, --generation, --architecture-id, --environment-id, --profile-id, --adapter-digest, and --capabilities-digest.", 2, "CODEX_TARGET_CONTEXT_INVALID");
    }
    const raw = {
      targetId: requiredCodexContextOption(parsed, "target-id"),
      targetGeneration: requiredCodexGeneration(parsed),
      architectureId: requiredCodexContextOption(parsed, "architecture-id"),
      environmentId: requiredCodexContextOption(parsed, "environment-id"),
      profileId: requiredCodexContextOption(parsed, "profile-id"),
      adapterDigest: requiredCodexContextOption(parsed, "adapter-digest"),
      capabilitiesDigest: requiredCodexContextOption(parsed, "capabilities-digest"),
    };
    return assertSafeCodexContext(raw);
  }

  const contextPath = parsed.options[suppliedContextPaths[0] as (typeof contextOptions)[number]];
  if (typeof contextPath !== "string" || !contextPath || hasControlCharacter(contextPath)) {
    throw new CliError("The context JSON file option is invalid.", 2, "CODEX_TARGET_CONTEXT_INVALID");
  }
  let text: string;
  try {
    text = await readFile(path.resolve(contextPath), "utf8");
  } catch {
    throw new CliError("The context JSON file could not be read.", 2, "CODEX_TARGET_CONTEXT_INVALID");
  }
  if (Buffer.byteLength(text, "utf8") > CODEX_CONTEXT_MAX_BYTES) {
    throw new CliError("The context JSON file exceeds the 16 KiB limit.", 2, "CODEX_TARGET_CONTEXT_INVALID");
  }
  let parsedContext: unknown;
  try {
    parsedContext = JSON.parse(text);
  } catch {
    throw new CliError("The context JSON file must contain valid JSON.", 2, "CODEX_TARGET_CONTEXT_INVALID");
  }
  if (!isPlainRecord(parsedContext)) {
    throw new CliError("The context JSON file must contain one metadata-only object.", 2, "CODEX_TARGET_CONTEXT_INVALID");
  }
  const keys = Object.keys(parsedContext);
  if (keys.length !== CODEX_CONTEXT_FIELDS.length || keys.some((key) => !(CODEX_CONTEXT_FIELDS as readonly string[]).includes(key))) {
    throw new CliError("The context JSON file must contain exactly the seven metadata context fields.", 2, "CODEX_TARGET_CONTEXT_INVALID");
  }
  return assertSafeCodexContext(parsedContext);
}

function requiredCodexContextOption(parsed: ParsedArgs, key: string): string {
  const value = parsed.options[key];
  if (typeof value !== "string" || !value || hasControlCharacter(value)) {
    throw new CliError(`--${key} is required and must be a safe metadata value.`, 2, "CODEX_TARGET_CONTEXT_INVALID");
  }
  return value;
}

function requiredCodexGeneration(parsed: ParsedArgs): number {
  const value = requiredCodexContextOption(parsed, "generation");
  if (!/^\d+$/.test(value)) {
    throw new CliError("--generation must be a positive integer.", 2, "CODEX_TARGET_CONTEXT_INVALID");
  }
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > architectureTargetLimits.generationMaximum) {
    throw new CliError("--generation must be a positive bounded integer.", 2, "CODEX_TARGET_CONTEXT_INVALID");
  }
  return generation;
}

function assertSafeCodexContext(input: unknown): ArchitectureTargetAdapterContext {
  try {
    return assertValidArchitectureTargetAdapterContext(input);
  } catch {
    throw new CliError("Codex target context is invalid or contains unsupported metadata.", 2, "CODEX_TARGET_CONTEXT_INVALID");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function printCodexTargetObservation(observation: ArchitectureTargetObservation, io: CliIo): void {
  io.stdout([
    "observation",
    terminalSafeText(observation.targetId),
    `generation=${observation.targetGeneration}`,
    `skills=${observation.skills.length}`,
    `findings=${observation.configFindings.length}`,
    `digest=${observation.observedDigest}`,
  ].join("\t"));
  for (const skill of observation.skills) {
    io.stdout([
      "skill",
      terminalSafeText(skill.slug),
      terminalSafeText(skill.version ?? "-"),
      terminalSafeText(skill.digest ?? "-"),
      terminalSafeText(skill.kind ?? "-"),
      `enabled=${skill.enabled === undefined ? "-" : skill.enabled}`,
      `exposure=${terminalSafeText(skill.runtimeExposure ?? "-")}`,
    ].join("\t"));
  }
  for (const finding of observation.configFindings) {
    io.stdout(`finding\t${terminalSafeText(finding.code)}\t${terminalSafeText(finding.severity)}\tcount=${finding.count}`);
  }
}

function printCodexTargetHealth(health: ArchitectureTargetHealth, io: CliIo): void {
  const metadata = health.metadata ?? {};
  io.stdout([
    "health",
    terminalSafeText(health.status),
    `profile=${terminalSafeText(typeof metadata.profile === "string" ? metadata.profile : "-")}`,
    `skills=${typeof metadata.skillCount === "number" ? metadata.skillCount : 0}`,
    `findings=${typeof metadata.findingCount === "number" ? metadata.findingCount : 0}`,
  ].join("\t"));
}

async function adminCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const token = await requireToken(parsed, runtime);
  const resource = parsed.args[0];
  const action = parsed.args[1];
  if (resource !== "sharing") {
    throw new CliError("Usage: myskills admin sharing get|set", 2);
  }
  if (action === "get") {
    const response = await apiGet("/v1/admin/sharing", parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      printSharingSettings(response, runtime.io);
    }
    return 0;
  }
  if (action === "set") {
    const updates = sharingSettingsOptionUpdates(parsed);
    if (Object.keys(updates).length === 0) {
      throw new CliError("At least one sharing setting option is required.", 2);
    }
    const currentResponse = await apiGet("/v1/admin/sharing", parsed, runtime, token);
    const current = sharingSettingsFromResponse(currentResponse);
    const response = await apiPut("/v1/admin/sharing", { ...current, ...updates }, parsed, runtime, token);
    if (parsed.options.json) {
      runtime.io.stdout(JSON.stringify(response, null, 2));
    } else {
      printSharingSettings(response, runtime.io);
    }
    return 0;
  }
  throw new CliError("Usage: myskills admin sharing get|set", 2);
}

async function submitCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const token = await tokenOption(parsed, runtime);
  if (!token) {
    throw new CliError("No token provided. Run myskills login, set MYSKILLS_TOKEN, or pass --token.", 1);
  }
  const packagePath = requiredPath(parsed);
  const { manifest, files, scan } = await readPackageSnapshot(packagePath);
  if (hasBlockingFindings(scan.findings)) {
    printScanResult(scan, runtime.io);
    throw new CliError("Package has blocking scan findings; submission was not sent.", 1);
  }
  const release = await releaseMetadataOptions(parsed);
  const response = await apiPost("/v1/submissions", { manifest, release, files }, parsed, runtime, token);
  if (parsed.options.json) {
    runtime.io.stdout(JSON.stringify(response, null, 2));
  } else {
    const submission = response.submission as {
      id: string;
      slug: string;
      version: string;
      reviewStatus: string;
      securityStatus: string;
    };
    const responseScan = response.scan as { findingCount: number };
    runtime.io.stdout(`${submission.slug}@${submission.version}\t${submission.reviewStatus}\t${submission.securityStatus}\tfindings=${responseScan.findingCount}`);
  }
  return 0;
}

async function releaseMetadataOptions(parsed: ParsedArgs): Promise<SkillReleaseMetadata> {
  const releaseNotesFile = optionalStringOption(parsed, "release-notes-file");
  const adapterContractVersion = optionalStringOption(parsed, "minimum-adapter-contract-version");
  const raw: Record<string, unknown> = {
    ...(releaseNotesFile ? { releaseNotes: await readFile(path.resolve(releaseNotesFile), "utf8") } : {}),
    ...(optionalStringOption(parsed, "change-kind") ? { changeKind: optionalStringOption(parsed, "change-kind") } : {}),
    ...(parsed.options["requires-user-action"] === true ? { requiresUserAction: true } : {}),
    compatibility: {
      ...(optionalStringOption(parsed, "minimum-myskills-version")
        ? { minimumMyskillsVersion: optionalStringOption(parsed, "minimum-myskills-version") }
        : {}),
      ...(adapterContractVersion ? { minimumAdapterContractVersion: Number(adapterContractVersion) } : {}),
      ...(optionalStringOption(parsed, "minimum-source-version")
        ? { minimumSourceVersion: optionalStringOption(parsed, "minimum-source-version") }
        : {}),
    },
  };
  try {
    return parseSkillReleaseMetadata(raw);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : "Invalid release metadata options.", 2);
  }
}

async function exportCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const slug = parsed.args[0];
  if (!slug) {
    throw new CliError("Usage: myskills export <skill-slug> --version <version> --platform <platform> --output <dir>", 2);
  }
  const version = stringOption(parsed, "version");
  const platform = stringOption(parsed, "platform");
  const outputDir = stringOption(parsed, "output");
  const token = await tokenOption(parsed, runtime) ?? undefined;
  const bundle = await downloadVerifiedBundle({ slug, version, platform }, parsed, runtime, token);
  const outputRoot = path.resolve(outputDir);
  await exportPackageTree(bundle.files, outputRoot);
  runtime.io.stdout(`${slug}@${version}\texported\tfiles=${bundle.files.length}\t${outputRoot}`);
  return 0;
}

async function installCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const slug = parsed.args[0];
  if (!slug) {
    throw new CliError("Usage: myskills install <skill-slug> [--version <version>] [--platform <platform>] [--dir <install-root>]", 2);
  }
  const token = await tokenOption(parsed, runtime) ?? undefined;
  const root = installRoot(parsed, runtime);
  const registry = await readInstallRegistry(root);
  const provenance = await registryProvenance(parsed, runtime, token);
  await assertWorkspaceBinding(parsed, runtime, provenance);
  if (registry.installations[slug]) assertMatchingProvenance(registry.installations[slug], provenance);
  const version = optionalStringOption(parsed, "version") ?? await latestCompatibleVersionForSkill(slug, registry.installations[slug], parsed, runtime, token);
  const installed = await installSkillVersion({
    slug,
    version,
    platform: optionalStringOption(parsed, "platform"),
    root,
    registry,
    parsed,
    runtime,
    token,
    provenance,
  });
  runtime.io.stdout(`${installed.slug}@${installed.version}\tinstalled\tplatform=${installed.platform}\t${installed.path}`);
  return 0;
}

async function listInstalledCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const root = installRoot(parsed, runtime);
  const registry = await readInstallRegistry(root);
  const installations = Object.values(registry.installations).sort((a, b) => a.slug.localeCompare(b.slug));
  if (parsed.options.json) {
    runtime.io.stdout(JSON.stringify({ installations }, null, 2));
    return 0;
  }
  if (installations.length === 0) {
    runtime.io.stdout("No installed skills.");
    return 0;
  }
  for (const installed of installations) {
    runtime.io.stdout(`${installed.slug}\t${installed.version}\t${installed.platform}\t${installed.path}`);
  }
  return 0;
}

async function updateCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const root = installRoot(parsed, runtime);
  const registry = await readInstallRegistry(root);
  const targets = parsed.args[0]
    ? [parseInstallSlug(parsed.args[0])]
    : Object.keys(registry.installations).sort();
  if (targets.length === 0) {
    runtime.io.stdout("No installed skills.");
    return 0;
  }
  const token = await tokenOption(parsed, runtime) ?? undefined;
  const explicitVersion = optionalStringOption(parsed, "version");
  const explicitPlatform = optionalStringOption(parsed, "platform");
  const dryRun = parsed.options["dry-run"] === true;
  const provenance = await registryProvenance(parsed, runtime, token);
  await assertWorkspaceBinding(parsed, runtime, provenance);
  const results: Array<{ slug: string; platform: string; evaluation: ReturnType<typeof evaluateSkillUpdate>; appliedVersion?: string }> = [];
  let blocked = false;

  for (const slug of targets) {
    const existing = registry.installations[slug];
    if (!existing) {
      throw new CliError(`${slug} is not installed. Run myskills install ${slug}.`, 1);
    }
    assertMatchingProvenance(existing, provenance);
    const platform = explicitPlatform ?? existing.platform;
    if (!existing.contentDigest || !await directoryMatchesDigest(existing.path, existing.contentDigest)) {
      const evaluation = localDriftEvaluation(existing.version);
      results.push({ slug, platform, evaluation });
      printUpdateEvaluation(slug, platform, evaluation, parsed, runtime);
      blocked = true;
      continue;
    }
    const releases = await releaseCandidatesForSkill(slug, parsed, runtime, token);
    const selectedReleases = explicitVersion
      ? releases.filter((release) => release.version === explicitVersion)
      : releases;
    if (explicitVersion && selectedReleases.length === 0) {
      throw new CliError(`${slug}@${explicitVersion} is not an available release.`, 1);
    }
    const evaluation = evaluateSkillUpdate({
      installed: {
        version: existing.version,
        platform,
        artifactSha256: existing.artifact.sha256 || undefined,
      },
      releases: selectedReleases,
      policy: { includePrerelease: parsed.options["include-prerelease"] === true },
      client: { myskillsVersion: CLI_VERSION, adapterContractVersion: parsed.options.workspace ? 2 : 1 },
    });
    const result = { slug, platform, evaluation, appliedVersion: undefined as string | undefined };
    results.push(result);
    printUpdateEvaluation(slug, platform, evaluation, parsed, runtime);
    if (dryRun || evaluation.status !== "update-available" || !evaluation.candidate) {
      if (evaluation.status !== "current" && evaluation.status !== "update-available") blocked = true;
      continue;
    }
    if (evaluation.candidate.requiresUserAction && parsed.options["accept-user-action"] !== true) {
      throw new CliError(
        `${slug}@${evaluation.candidate.version} requires user action. Review it with myskills updates ${slug}, then rerun with --accept-user-action.`,
        1,
      );
    }
    const updated = await installSkillVersion({
      slug,
      version: evaluation.candidate.version,
      platform,
      root,
      registry,
      parsed,
      runtime,
      token,
      provenance,
    });
    result.appliedVersion = updated.version;
    if (!parsed.options.json) runtime.io.stdout(`${updated.slug}@${updated.version}\tapplied\tplatform=${updated.platform}\tprevious=${existing.version}`);
  }
  if (parsed.options.json) runtime.io.stdout(JSON.stringify({ updates: results }, null, 2));
  return blocked && !dryRun ? 1 : 0;
}

async function updatesCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const root = installRoot(parsed, runtime);
  const registry = await readInstallRegistry(root);
  const targets = parsed.args[0]
    ? [parseInstallSlug(parsed.args[0])]
    : Object.keys(registry.installations).sort();
  if (targets.length === 0) {
    runtime.io.stdout(parsed.options.json ? JSON.stringify({ updates: [] }, null, 2) : "No installed skills.");
    return 0;
  }
  const token = await tokenOption(parsed, runtime) ?? undefined;
  const provenance = await registryProvenance(parsed, runtime, token);
  await assertWorkspaceBinding(parsed, runtime, provenance);
  const results: Array<{ slug: string; platform: string; evaluation: ReturnType<typeof evaluateSkillUpdate> }> = [];
  for (const slug of targets) {
    const installed = registry.installations[slug];
    if (!installed) throw new CliError(`${slug} is not installed. Run myskills install ${slug}.`, 1);
    assertMatchingProvenance(installed, provenance);
    if (!installed.contentDigest || !await directoryMatchesDigest(installed.path, installed.contentDigest)) {
      const evaluation = localDriftEvaluation(installed.version);
      results.push({ slug, platform: installed.platform, evaluation });
      if (!parsed.options.json) printUpdateEvaluation(slug, installed.platform, evaluation, parsed, runtime);
      continue;
    }
    const releases = await releaseCandidatesForSkill(slug, parsed, runtime, token);
    const evaluation = evaluateSkillUpdate({
      installed: {
        version: installed.version,
        platform: installed.platform,
        artifactSha256: installed.artifact.sha256 || undefined,
      },
      releases,
      policy: { includePrerelease: parsed.options["include-prerelease"] === true },
      client: { myskillsVersion: CLI_VERSION, adapterContractVersion: parsed.options.workspace ? 2 : 1 },
    });
    results.push({ slug, platform: installed.platform, evaluation });
    if (!parsed.options.json) printUpdateEvaluation(slug, installed.platform, evaluation, parsed, runtime);
  }
  if (parsed.options.json) runtime.io.stdout(JSON.stringify({ updates: results }, null, 2));
  return 0;
}

async function releaseCandidatesForSkill(
  slug: string,
  parsed: ParsedArgs,
  runtime: CliRuntime,
  token: string | undefined,
): Promise<SkillReleaseUpdateCandidate[]> {
  const response = await apiGet(`/v1/skills/${encodeURIComponent(parseInstallSlug(slug))}/releases`, parsed, runtime, token);
  if (!Array.isArray(response.releases)) {
    throw new CliError("API release list response is missing releases.", 1);
  }
  return response.releases.map((release, index) => parseReleaseCandidate(release, index));
}

function parseReleaseCandidate(input: unknown, index: number): SkillReleaseUpdateCandidate {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CliError(`API release list entry ${index + 1} is invalid.`, 1);
  }
  const record = input as Record<string, unknown>;
  if (typeof record.version !== "string" || !parseSemanticVersion(record.version)) {
    throw new CliError(`API release list entry ${index + 1} has an invalid version.`, 1);
  }
  if (record.lifecycleStatus !== "approved" && record.lifecycleStatus !== "deprecated") {
    throw new CliError(`API release list entry ${index + 1} is not installable.`, 1);
  }
  const artifact = parseReleaseArtifactValue(record.artifact, index);
  let release: SkillReleaseMetadata;
  try {
    release = parseSkillReleaseMetadata({
      releaseNotes: record.releaseNotes,
      changeKind: record.changeKind,
      requiresUserAction: record.requiresUserAction,
      compatibility: record.compatibility,
    });
  } catch {
    throw new CliError(`API release list entry ${index + 1} has invalid release metadata.`, 1);
  }
  return {
    version: record.version,
    lifecycleStatus: record.lifecycleStatus,
    publishedAt: typeof record.publishedAt === "string" ? record.publishedAt : "",
    platforms: parseReleasePlatforms(record.platforms),
    artifact,
    ...release,
  };
}

function parseReleaseArtifactValue(input: unknown, index: number): SkillReleaseUpdateCandidate["artifact"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CliError(`API release list entry ${index + 1} is missing artifact metadata.`, 1);
  }
  const record = input as Record<string, unknown>;
  if (
    typeof record.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(record.sha256)
    || typeof record.byteSize !== "number"
    || !Number.isSafeInteger(record.byteSize)
    || record.byteSize < 0
  ) {
    throw new CliError(`API release list entry ${index + 1} has invalid artifact metadata.`, 1);
  }
  return {
    sha256: record.sha256,
    byteSize: record.byteSize,
    contentType: typeof record.contentType === "string" ? record.contentType : "application/vnd.myskills-app.package+json",
  };
}

function printUpdateEvaluation(
  slug: string,
  platform: string,
  evaluation: ReturnType<typeof evaluateSkillUpdate>,
  parsed: ParsedArgs,
  runtime: CliRuntime,
): void {
  if (parsed.options.json) return;
  const candidate = evaluation.candidate ? `\tcandidate=${evaluation.candidate.version}` : "";
  const blockers = evaluation.blockers.length > 0 ? `\tblockers=${evaluation.blockers.join(",")}` : "";
  runtime.io.stdout(`${slug}@${evaluation.installedVersion}\t${evaluation.status}\tplatform=${platform}${candidate}${blockers}`);
  for (const release of evaluation.includedReleases) {
    runtime.io.stdout(
      `changes\t${release.version}\t${release.changeKind}\taction=${release.requiresUserAction ? "required" : "none"}\t${terminalSafeText(release.releaseNotes)}`,
    );
  }
}

function localDriftEvaluation(version: string): ReturnType<typeof evaluateSkillUpdate> {
  return {
    status: "drifted",
    installedVersion: version,
    includedReleases: [],
    blockers: [],
  };
}

async function rollbackCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const requestedSlug = parsed.args[0];
  if (!requestedSlug) {
    throw new CliError("Usage: myskills rollback <skill-slug> [--dir <install-root>]", 2);
  }
  const slug = parseInstallSlug(requestedSlug);
  const root = installRoot(parsed, runtime);
  const registry = await readInstallRegistry(root);
  const existing = registry.installations[slug];
  const previous = existing?.history.at(-1);
  if (!existing || !previous) {
    throw new CliError(`${slug} has no rollback snapshot.`, 1);
  }
  if (parsed.options.workspace && !runtime.beforeInstallPromotion) {
    const provenance = await registryProvenance(parsed, runtime, await requireToken(parsed, runtime));
    await assertWorkspaceBinding(parsed, runtime, provenance);
    assertMatchingProvenance(existing, provenance);
  }

  const outputRoot = skillInstallPath(root, slug);
  const sourceSnapshotPath = path.resolve(previous.snapshotPath);
  assertChildPath(path.join(root, ".myskills-app", "history"), sourceSnapshotPath);
  if (!await pathExists(outputRoot) || !await pathExists(sourceSnapshotPath)) {
    throw new CliError(`${slug} cannot roll back because its active install or snapshot is missing.`, 1);
  }
  const transactionId = randomUUID();
  const stageRoot = installStagePath(root, transactionId);
  const recoverySnapshotPath = historySnapshotPath(root, slug, existing.version, transactionId);
  await assertInstalledBytes(existing);
  if (!existing.provenance || !previous.provenance) throw new CliError("Rollback requires a snapshot with verified registry provenance.", 1);
  assertMatchingProvenance(previous, existing.provenance);
  if (!previous.contentDigest) throw new CliError("Rollback snapshot has no verified byte identity.", 1);
  const snapshot = await readPackageSnapshot(sourceSnapshotPath);
  if (parsed.options.workspace || runtime.beforeInstallPromotion) validateCodexSkill(snapshot.files, slug);
  const targetContentDigest = contentDigestForFiles(snapshot.files);
  if (targetContentDigest !== previous.contentDigest) throw new CliError("Rollback snapshot was modified. The current installation is unchanged.", 1);
  await writeNewPackageTree(root, stageRoot, snapshot.files);
  if (!await directoryMatchesDigest(stageRoot, targetContentDigest)) throw new CliError("Rollback staging failed byte verification.", 1);
  let transaction: InstallTransaction = {
    version: 1,
    id: transactionId,
    operation: "rollback",
    state: "prepared",
    slug,
    targetVersion: previous.version,
    targetPlatform: previous.platform,
    targetArtifact: previous.artifact,
    targetContentDigest,
    previous: existing,
    snapshotCreated: true,
    sourceSnapshotPath,
  };
  await writeInstallTransaction(root, transaction);
  await runtime.installFault?.("prepared");
  await runtime.beforeInstallPromotion?.();
  await assertInstalledBytes(existing);
  await ensureSafeDirectory(root, path.dirname(recoverySnapshotPath));
  await rename(outputRoot, recoverySnapshotPath);
  transaction = { ...transaction, state: "previous-staged" };
  await writeInstallTransaction(root, transaction);
  await runtime.installFault?.("previous-staged");
  await runtime.beforeInstallPromotion?.();
  await rename(stageRoot, outputRoot);
  transaction = { ...transaction, state: "installed" };
  await writeInstallTransaction(root, transaction);
  await runtime.installFault?.("installed");
  if (!await directoryMatchesDigest(outputRoot, targetContentDigest)) throw new CliError("Rollback verification failed. Recovery copies are retained.", 1);
  registry.installations[slug] = {
    slug,
    version: previous.version,
    platform: previous.platform,
    path: outputRoot,
    installedAt: new Date().toISOString(),
    artifact: previous.artifact,
    contentDigest: targetContentDigest,
    history: existing.history.slice(0, -1),
    provenance: previous.provenance,
  };
  await writeInstallRegistry(root, registry);
  transaction = { ...transaction, state: "registry-committed" };
  await writeInstallTransaction(root, transaction);
  await runtime.installFault?.("registry-committed");
  await rm(recoverySnapshotPath, { recursive: true, force: true });
  await rm(sourceSnapshotPath, { recursive: true, force: true });
  await rm(installTransactionPath(root, transactionId), { force: true });
  runtime.io.stdout(`${slug}@${previous.version}\trolled-back\tplatform=${previous.platform}\t${outputRoot}`);
  return 0;
}

interface WorkspaceBinding {
  schemaVersion: 1;
  rootDigest: string;
  provenance: RegistryProvenance;
  target: ArchitectureTarget;
}

function workspaceBindingPath(root: string): string { return path.join(root, ".myskills-app", "codex-workspace.json"); }

async function readWorkspaceBinding(root: string): Promise<WorkspaceBinding> {
  let input: Record<string, unknown>;
  try { input = JSON.parse(await readRegularText(workspaceBindingPath(root), 32 * 1024)) as Record<string, unknown>; }
  catch { throw new CliError("Workspace is not enrolled or its binding is unreadable. Run myskills codex enroll for this workspace.", 1); }
  const provenance = parseProvenance(input.provenance);
  if (input.schemaVersion !== 1 || input.rootDigest !== workspaceRootDigest(root) || !provenance) throw new CliError("Workspace binding does not match this local root.", 1);
  return { schemaVersion: 1, rootDigest: input.rootDigest, provenance, target: parseWorkspaceTarget(input.target) };
}

async function assertWorkspaceBinding(parsed: ParsedArgs, runtime: CliRuntime, provenance: RegistryProvenance): Promise<WorkspaceBinding | undefined> {
  if (!parsed.options.workspace && parsed.command !== "companion") return undefined;
  const binding = await readWorkspaceBinding(installRoot(parsed, runtime));
  assertMatchingProvenance(binding, provenance);
  if (binding.target.consent.status !== "granted" || binding.target.status === "revoked") throw new CliError("Workspace target has no active consent.", 1);
  if (parsed.command !== "companion") {
    const response = await apiGet(`/v1/architecture-targets/${encodeURIComponent(binding.target.id)}`, parsed, runtime, await requireToken(parsed, runtime));
    const current = parseWorkspaceTarget(response.target);
    if (current.generation !== binding.target.generation || current.identityDigest !== binding.target.identityDigest
      || current.status === "revoked" || current.consent.status !== "granted") throw new CliError("Workspace target binding or consent changed. Re-enroll before modifying this workspace.", 1);
  }
  return binding;
}

async function codexWorkspaceCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const root = installRoot(parsed, runtime);
  if (parsed.args[0] === "enroll") {
    const token = await requireToken(parsed, runtime);
    const provenance = await registryProvenance(parsed, runtime, token);
    let binding: WorkspaceBinding | undefined;
    try { await lstat(workspaceBindingPath(root)); binding = await readWorkspaceBinding(root); }
    catch (error) { if (!isNodeError(error) || error.code !== "ENOENT") throw error; }
    if (binding) assertMatchingProvenance(binding, provenance);
    const requestedTarget = optionalStringOption(parsed, "target-id");
    if (!binding && requestedTarget) throw new CliError("A new workspace must register its own target with architecture, environment, and profile IDs. --target-id only resumes this workspace's existing binding.", 2);
    if (binding && requestedTarget && requestedTarget !== binding.target.id) throw new CliError("Workspace is already bound to another target. Use a new workspace.", 1);
    const targetId = binding?.target.id ?? requestedTarget;
    let target: ArchitectureTarget;
    if (targetId) {
      target = parseWorkspaceTarget((await apiGet(`/v1/architecture-targets/${encodeURIComponent(parseArchitectureReference(targetId, "target"))}`, parsed, runtime, token)).target);
      if (binding && target.identityDigest !== binding.target.identityDigest) throw new CliError("Target identity changed; this workspace cannot be rebound implicitly.", 1);
    } else {
      target = parseWorkspaceTarget((await apiPost("/v1/architecture-targets", {
        name: optionalStringOption(parsed, "name") ?? "Codex workspace",
        architectureId: parseArchitectureReference(stringOption(parsed, "architecture-id"), "architecture"),
        environmentId: parseArchitectureReference(stringOption(parsed, "environment-id"), "environment"),
        profileId: parseArchitectureReference(stringOption(parsed, "profile-id"), "profile"),
        adapter: codexWorkspaceDescriptor,
        capabilities: codexWorkspaceCapabilities,
        identityDigest: createHash("sha256").update(randomUUID()).digest("hex"),
      }, parsed, runtime, token)).target);
    }
    binding = { schemaVersion: 1, rootDigest: workspaceRootDigest(root), provenance, target };
    // Persist registration before consent so an interrupted enrollment can resume
    // against the same target without creating an orphan duplicate.
    await atomicPrivateWrite(root, workspaceBindingPath(root), `${JSON.stringify(binding, null, 2)}\n`);
    if (target.consent.status !== "granted") {
      target = parseWorkspaceTarget((await apiPost(`/v1/architecture-targets/${encodeURIComponent(target.id)}/consent`, { decision: "grant" }, parsed, runtime, token)).target);
      binding.target = target;
      await atomicPrivateWrite(root, workspaceBindingPath(root), `${JSON.stringify(binding, null, 2)}\n`);
    }
    if (target.status === "revoked" || target.consent.status !== "granted") throw new CliError("Enrollment did not produce an active consented target.", 1);
    runtime.io.stdout(JSON.stringify({ targetId: target.id, generation: target.generation, adapter: target.adapter, enrolled: true, runtimeRecognized: false }));
    return 0;
  }
  if (parsed.args[0] === "observe") {
    const binding = await readWorkspaceBinding(root);
    const observation = await observeWorkspace(root, binding);
    if (parsed.options.upload === true) {
      const token = await requireToken(parsed, runtime);
      const provenance = await registryProvenance(parsed, runtime, token);
      await assertWorkspaceBinding(parsed, runtime, provenance);
      await apiPost(`/v1/architecture-targets/${encodeURIComponent(binding.target.id)}/observations`, observation, parsed, runtime, token);
      const health = {
        status: observation.configFindings.length ? "degraded" : "healthy",
        checkedAt: observation.observedAt,
        metadata: { verification: "filesystem", runtimeRecognized: false },
      };
      const target = parseWorkspaceTarget((await apiPost(`/v1/architecture-targets/${encodeURIComponent(binding.target.id)}/health`, health, parsed, runtime, token)).target);
      await atomicPrivateWrite(root, workspaceBindingPath(root), `${JSON.stringify({ ...binding, target }, null, 2)}\n`);
    }
    runtime.io.stdout(JSON.stringify({ observation, uploaded: parsed.options.upload === true, runtimeRecognized: false }, null, 2));
    return 0;
  }
  throw new CliError("Usage: myskills codex enroll|observe --workspace <absolute-dir> [--upload]", 2);
}

async function observeWorkspace(root: string, binding: WorkspaceBinding): Promise<ArchitectureTargetObservation> {
  const registry = await readInstallRegistry(root);
  const skills: ArchitectureTargetObservation["skills"] = [];
  const unmanagedCount = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.name !== ".myskills-app"
    && (entry.isDirectory() || entry.isSymbolicLink()) && !Object.hasOwn(registry.installations, entry.name)).length;
  let driftCount = 0;
  for (const installed of Object.values(registry.installations)) {
    assertMatchingProvenance(installed, binding.provenance);
    try {
      const snapshot = await readPackageSnapshot(installed.path);
      validateCodexSkill(snapshot.files, installed.slug);
      if (contentDigestForFiles(snapshot.files) !== installed.contentDigest) throw new Error("drift");
      skills.push({ slug: installed.slug, version: installed.version, digest: installed.artifact.sha256,
        kind: "leaf", enabled: true, runtimeExposure: "leaf", configured: true, managed: true, supported: true,
        metadata: { platform: "codex", verification: "filesystem" } });
    } catch { driftCount += 1; }
  }
  const observation = {
    schemaVersion: 1 as const,
    targetId: binding.target.id,
    targetGeneration: binding.target.generation,
    adapterDigest: architectureTargetAdapterDigest(binding.target.adapter),
    capabilitiesDigest: architectureTargetCapabilitiesDigest(binding.target.capabilities, 2),
    observedAt: new Date().toISOString(),
    skills: skills.sort((left, right) => left.slug.localeCompare(right.slug)),
    configFindings: [
      ...(driftCount ? [{ code: "managed-skill-drift", severity: "error" as const, count: driftCount }] : []),
      ...(unmanagedCount ? [{ code: "unmanaged-skill-directory", severity: "warning" as const, count: unmanagedCount }] : []),
    ],
    promptAwareness: { detected: false, count: 0, redacted: true },
    metadata: { verification: "filesystem", runtimeRecognized: false },
  };
  return assertValidArchitectureTargetObservation({ ...observation, observedDigest: architectureTargetObservationDigest(observation) });
}

async function companionCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const subcommand = parsed.args[0];
  if (subcommand !== "run-once") {
    throw new CliError("Usage: myskills companion run-once --target-id <id> --generation <number> --holder <id> [--dir <install-root>]", 2);
  }
  const token = await tokenOption(parsed, runtime);
  if (!token) throw new CliError("A targets:execute API token is required for the companion.", 1);
  const provenance = await registryProvenance(parsed, runtime, token);
  const binding = await assertWorkspaceBinding(parsed, runtime, provenance);
  if (!binding) throw new CliError("Companion execution requires an enrolled workspace.", 1);
  const targetId = binding.target.id;
  const generation = binding.target.generation;
  if ((parsed.options["target-id"] && stringOption(parsed, "target-id") !== targetId)
    || (parsed.options.generation && positiveIntegerOption(parsed, "generation") !== generation)) throw new CliError("Companion target flags do not match the enrolled root.", 1);
  const holderId = parseArchitectureReference(stringOption(parsed, "holder"), "holder");
  const claimResponse = await apiPost("/v1/target-operations/claim", {
    targetId,
    targetGeneration: generation,
    holderId,
    leaseSeconds: 300,
  }, parsed, runtime, token);
  if (claimResponse.claim === null) {
    runtime.io.stdout("No queued target operations.");
    return 0;
  }
  const claim = parseTargetOperationClaim(claimResponse.claim, targetId, generation);
  const operation = claim.operation;
  const statePayload = {
    holderId,
    claimToken: claim.claimToken,
    fencingToken: operation.fencingToken,
    leaseSeconds: 300,
  };
  const lease = new CompanionLease(operation.leaseExpiresAt, async (state) => {
    const response = await apiPost(`/v1/target-operations/${encodeURIComponent(operation.id)}/state`, { ...statePayload, state }, parsed, runtime, token);
    const renewed = recordField(response.operation, "renewed operation");
    if (renewed.id !== operation.id || renewed.fencingToken !== operation.fencingToken || renewed.state !== state) throw new CliError("Companion renewal does not match the current claim.", 1);
    return requiredRecordString(renewed, "leaseExpiresAt", "Companion renewal is missing lease expiry.");
  });

  try {
    await lease.checkpoint("applying");
    const executionRuntime: CliRuntime = {
      ...runtime,
      beforeInstallPromotion: async () => {
        await runtime.beforeInstallPromotion?.();
        await lease.checkpoint("applying");
      },
    };
    const executionArgs = { ...parsed, options: { ...parsed.options, "accept-user-action": true, "include-prerelease": true } };
    const installed = await executeTargetOperation(operation, executionArgs, executionRuntime, token);
    await lease.checkpoint("verifying");
    const root = installRoot(parsed, runtime);
    const registry = await readInstallRegistry(root);
    const current = registry.installations[operation.skillSlug];
    if (
      !current
      || current.version !== operation.toVersion
      || current.artifact.sha256 !== operation.artifact.sha256
      || !current.contentDigest
      || !await directoryMatchesDigest(current.path, current.contentDigest)
    ) {
      throw new CliError("Target operation readback does not match the claimed plan.", 1);
    }
    await lease.checkpoint("verifying");
    await apiPost(`/v1/target-operations/${encodeURIComponent(operation.id)}/receipt`, {
      holderId,
      claimToken: claim.claimToken,
      fencingToken: operation.fencingToken,
      result: {
        status: "succeeded",
        code: "operation.succeeded",
        installedVersion: current.version,
        artifactSha256: current.artifact.sha256,
        contentDigest: current.contentDigest,
      },
    }, parsed, runtime, token);
    runtime.io.stdout(`${operation.id}\tsucceeded\t${installed.slug}@${installed.version}\t${operation.action}`);
    return 0;
  } catch (error) {
    try {
      await apiPost(`/v1/target-operations/${encodeURIComponent(operation.id)}/receipt`, {
        holderId,
        claimToken: claim.claimToken,
        fencingToken: operation.fencingToken,
        result: { status: "failed", code: "operation.failed" },
      }, parsed, runtime, token);
    } catch {
      // The original failure remains primary; a stale lease is recoverable by a later fenced claim.
    }
    throw error;
  } finally {
    await lease.stop();
  }
}

async function executeTargetOperation(
  operation: TargetSkillOperation,
  parsed: ParsedArgs,
  runtime: CliRuntime,
  token: string,
): Promise<InstalledSkillRecord> {
  if (operation.platform !== "codex") throw new CliError("Enrolled Codex workspace cannot execute another platform's operation.", 1);
  const root = installRoot(parsed, runtime);
  const registry = await readInstallRegistry(root);
  const existing = registry.installations[operation.skillSlug];
  const provenance = await registryProvenance(parsed, runtime, token);
  if (existing) assertMatchingProvenance(existing, provenance);
  if (
    existing
    && existing.version === operation.toVersion
    && existing.artifact.sha256 === operation.artifact.sha256
    && existing.contentDigest
    && await directoryMatchesDigest(existing.path, existing.contentDigest)
  ) return existing;
  if (operation.action === "install" && existing) {
    throw new CliError("Target install state changed after the operation was planned.", 1);
  }
  if (operation.action !== "install" && (!existing || existing.version !== operation.fromVersion)) {
    throw new CliError("Target source version changed after the operation was planned.", 1);
  }
  if (existing?.contentDigest && !await directoryMatchesDigest(existing.path, existing.contentDigest)) {
    throw new CliError("Target skill has local drift and cannot be changed automatically.", 1);
  }
  if (operation.action === "rollback") {
    const previous = existing?.history.at(-1);
    if (!previous || previous.version !== operation.toVersion || previous.artifact.sha256 !== operation.artifact.sha256 || previous.artifact.byteSize !== operation.artifact.byteSize) {
      throw new CliError("The required rollback snapshot is not available on this target.", 1);
    }
    const rollbackParsed: ParsedArgs = {
      command: "rollback",
      args: [operation.skillSlug],
      options: { ...parsed.options, dir: root },
    };
    await rollbackCommand(rollbackParsed, runtime);
    const after = (await readInstallRegistry(root)).installations[operation.skillSlug];
    if (!after) throw new CliError("Rollback did not produce an installed skill.", 1);
    return after;
  }
  return installSkillVersion({
    slug: operation.skillSlug,
    version: operation.toVersion,
    platform: operation.platform,
    root,
    registry,
    parsed,
    runtime,
    token,
    expectedArtifact: operation.artifact,
    provenance,
  });
}

function parseTargetOperationClaim(input: unknown, targetId: string, generation: number): {
  operation: TargetSkillOperation;
  claimToken: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CliError("Target operation claim is invalid.", 1);
  const record = input as Record<string, unknown>;
  if (typeof record.claimToken !== "string" || record.claimToken.length < 32 || !record.operation || typeof record.operation !== "object" || Array.isArray(record.operation)) {
    throw new CliError("Target operation claim is invalid.", 1);
  }
  const operation = record.operation as Record<string, unknown>;
  const artifact = parseReleaseArtifactValue(operation.artifact, 0);
  if (
    operation.schemaVersion !== 1
    || typeof operation.id !== "string"
    || !OBSERVED_IDENTIFIER_PATTERN.test(operation.id)
    || operation.targetId !== targetId
    || operation.targetGeneration !== generation
    || (operation.action !== "install" && operation.action !== "update" && operation.action !== "rollback")
    || typeof operation.skillSlug !== "string"
    || typeof operation.toVersion !== "string"
    || !parseSemanticVersion(operation.toVersion)
    || (operation.fromVersion !== undefined && (typeof operation.fromVersion !== "string" || !parseSemanticVersion(operation.fromVersion)))
    || typeof operation.platform !== "string"
    || typeof operation.planDigest !== "string"
    || !OBSERVED_DIGEST_PATTERN.test(operation.planDigest)
    || operation.state !== "claimed"
    || typeof operation.fencingToken !== "number"
    || !Number.isInteger(operation.fencingToken)
    || operation.fencingToken < 1
  ) throw new CliError("Target operation claim is invalid.", 1);
  const normalized = {
    schemaVersion: 1 as const,
    id: operation.id,
    targetId,
    targetGeneration: generation,
    action: operation.action,
    skillSlug: parseInstallSlug(operation.skillSlug),
    ...(typeof operation.fromVersion === "string" ? { fromVersion: operation.fromVersion } : {}),
    toVersion: operation.toVersion,
    platform: operation.platform,
    artifact,
    planDigest: operation.planDigest,
    state: "claimed" as const,
    fencingToken: operation.fencingToken,
    ...(typeof operation.leaseExpiresAt === "string" ? { leaseExpiresAt: operation.leaseExpiresAt } : {}),
    createdAt: typeof operation.createdAt === "string" ? operation.createdAt : "",
    updatedAt: typeof operation.updatedAt === "string" ? operation.updatedAt : "",
  } satisfies TargetSkillOperation;
  if (targetSkillOperationPlanDigest(normalized) !== normalized.planDigest) {
    throw new CliError("Target operation plan digest is invalid.", 1);
  }
  return { operation: normalized, claimToken: record.claimToken };
}

function positiveIntegerOption(parsed: ParsedArgs, key: string): number {
  const value = Number(stringOption(parsed, key));
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000_000) throw new CliError(`--${key} must be a positive integer.`, 2);
  return value;
}

async function latestCompatibleVersionForSkill(slug: string, existing: InstalledSkillRecord | undefined, parsed: ParsedArgs, runtime: CliRuntime, token: string | undefined): Promise<string> {
  const releases = await releaseCandidatesForSkill(slug, parsed, runtime, token);
  const platform = optionalStringOption(parsed, "platform") ?? existing?.platform ?? "codex";
  const compatible = releases.filter((release) => {
    try {
      if (release.lifecycleStatus !== "approved") return false;
      if (!release.platforms.some((item) => item.name === platform && item.status === "supported")) return false;
      assertReleaseEligibility(release, existing, parsed, false);
      return true;
    } catch { return false; }
  }).sort((left, right) => compareSemanticVersions(left.version, right.version));
  const selected = compatible.at(-1);
  if (!selected) throw new CliError(`${slug} has no compatible release. Inspect its releases and compatibility requirements.`, 1);
  return selected.version;
}

interface RegistryProvenance { origin: string; instanceId: string }

async function registryProvenance(parsed: ParsedArgs, runtime: CliRuntime, token?: string): Promise<RegistryProvenance> {
  const response = await apiGet("/v1/capabilities", parsed, runtime, token);
  if (typeof response.instanceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(response.instanceId)) {
    throw new CliError("The API does not expose a stable instance identity. Upgrade the server before installing or updating packages.", 1, "REGISTRY_IDENTITY_REQUIRED");
  }
  return { origin: new URL(apiBaseUrl(parsed, runtime)).href.replace(/\/+$/, ""), instanceId: response.instanceId.toLowerCase() };
}

function parseProvenance(input: unknown): RegistryProvenance | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CliError("Installed registry provenance is invalid.", 1);
  const record = input as Record<string, unknown>;
  if (typeof record.origin !== "string" || typeof record.instanceId !== "string" || !/^[0-9a-f-]{36}$/i.test(record.instanceId)) throw new CliError("Installed registry provenance is invalid.", 1);
  return { origin: new URL(normalizeApiUrlOption(record.origin)).href.replace(/\/+$/, ""), instanceId: record.instanceId.toLowerCase() };
}

function assertMatchingProvenance(installed: { provenance?: RegistryProvenance }, expected: RegistryProvenance): void {
  if (!installed.provenance) throw new CliError("Legacy installation has no registry identity. Keep its files as a backup and install into a new root after reviewing the source; automatic adoption is disabled.", 1, "INSTALL_PROVENANCE_REQUIRED");
  if (installed.provenance.origin !== expected.origin || installed.provenance.instanceId !== expected.instanceId) {
    throw new CliError("This installation belongs to a different registry. Use its original API or choose a new installation root.", 1, "INSTALL_REGISTRY_MISMATCH");
  }
}

function assertReleaseEligibility(release: SkillReleaseMetadata & { version: string }, existing: InstalledSkillRecord | undefined, parsed: ParsedArgs, requireAction = true): void {
  if (!parseSemanticVersion(release.version)) throw new CliError("Release version is invalid.", 1);
  if (parseSemanticVersion(release.version)!.prerelease.length > 0 && parsed.options["include-prerelease"] !== true) throw new CliError("A prerelease requires --include-prerelease.", 1);
  if (existing && compareSemanticVersions(release.version, existing.version) < 0) throw new CliError("Use rollback to restore a verified earlier snapshot; install cannot downgrade an existing package.", 1);
  const compatibility = release.compatibility;
  if (compatibility.minimumMyskillsVersion && compareSemanticVersions(CLI_VERSION, compatibility.minimumMyskillsVersion) < 0) throw new CliError("Release requires a newer MySkills CLI.", 1);
  if (compatibility.minimumAdapterContractVersion && compatibility.minimumAdapterContractVersion > (parsed.options.workspace || parsed.command === "companion" ? 2 : 1)) throw new CliError("Release requires a newer adapter contract.", 1);
  if (compatibility.minimumSourceVersion && (!existing || compareSemanticVersions(existing.version, compatibility.minimumSourceVersion) < 0)) throw new CliError("Release requires a different installed source version.", 1);
  if (requireAction && release.requiresUserAction && parsed.options["accept-user-action"] !== true) throw new CliError("Release requires user action. Review its release notes and rerun with --accept-user-action.", 1);
}

async function installSkillVersion(input: {
  slug: string;
  version: string;
  platform?: string;
  root: string;
  registry: InstallRegistry;
  parsed: ParsedArgs;
  runtime: CliRuntime;
  token?: string;
  expectedArtifact?: ReleaseArtifact;
  provenance?: RegistryProvenance;
}): Promise<InstalledSkillRecord> {
  const slug = parseInstallSlug(input.slug);
  const outputRoot = skillInstallPath(input.root, slug);
  const provenance = input.provenance ?? await registryProvenance(input.parsed, input.runtime, input.token);
  await assertWorkspaceBinding(input.parsed, input.runtime, provenance);
  const existing = input.registry.installations[slug];
  if (existing) {
    assertMatchingProvenance(existing, provenance);
    await assertInstalledBytes(existing);
  }
  const bundle = await downloadVerifiedBundle({
    slug,
    version: input.version,
    platform: input.parsed.options.workspace || input.parsed.command === "companion" ? "codex" : input.platform,
  }, input.parsed, input.runtime, input.token);
  assertReleaseEligibility({ ...bundle.release, version: bundle.version }, existing, input.parsed);
  if (existing && compareSemanticVersions(bundle.version, existing.version) > 0 && input.parsed.options["accept-user-action"] !== true) {
    const releases = await releaseCandidatesForSkill(slug, input.parsed, input.runtime, input.token);
    if (releases.some((release) => release.requiresUserAction && compareSemanticVersions(release.version, existing.version) > 0
      && compareSemanticVersions(release.version, bundle.version) <= 0)) throw new CliError("An intervening release requires user action. Review the upgrade notes and rerun with --accept-user-action.", 1);
  }
  if (input.parsed.options.workspace || input.parsed.command === "companion") validateCodexSkill(bundle.files, slug);
  if (existing?.version === bundle.version && existing.artifact.sha256 !== bundle.artifact.sha256) throw new CliError("An immutable installed version changed its artifact identity.", 1);
  if (
    input.expectedArtifact
    && (bundle.artifact.sha256 !== input.expectedArtifact.sha256 || bundle.artifact.byteSize !== input.expectedArtifact.byteSize)
  ) {
    throw new CliError("Downloaded bundle does not match the claimed target operation.", 1);
  }
  const history = existing ? [...existing.history] : [];
  if (!existing && await pathExists(outputRoot)) {
    throw new CliError(`${slug} already exists outside the MySkills install registry.`, 1);
  }

  const transactionId = randomUUID();
  const stageRoot = installStagePath(input.root, transactionId);
  const snapshotPath = existing && await pathExists(outputRoot)
    ? historySnapshotPath(input.root, slug, existing.version, transactionId)
    : null;
  const contentDigest = contentDigestForFiles(bundle.files);
  await writeNewPackageTree(input.root, stageRoot, bundle.files);
  if (!await directoryMatchesDigest(stageRoot, contentDigest)) throw new CliError("Staged package does not match its verified bytes.", 1);
  let transaction: InstallTransaction = {
    version: 1,
    id: transactionId,
    operation: existing ? "update" : "install",
    state: "prepared",
    slug,
    targetVersion: bundle.version,
    targetPlatform: bundle.platform.name,
    targetArtifact: bundle.artifact,
    targetContentDigest: contentDigest,
    previous: existing ?? null,
    snapshotCreated: snapshotPath !== null,
  };
  await writeInstallTransaction(input.root, transaction);
  await input.runtime.installFault?.("prepared");
  await input.runtime.beforeInstallPromotion?.();
  if (!input.runtime.beforeInstallPromotion) {
    await assertWorkspaceBinding(input.parsed, input.runtime, provenance);
    const currentRelease = releaseMetadata(await apiGet(`/v1/skills/${encodeURIComponent(slug)}/releases/${encodeURIComponent(bundle.version)}`, input.parsed, input.runtime, input.token), { slug, version: bundle.version });
    if (currentRelease.artifact.sha256 !== bundle.artifact.sha256 || currentRelease.artifact.byteSize !== bundle.artifact.byteSize) throw new CliError("Release identity changed before promotion.", 1);
    assertReleaseEligibility({ ...currentRelease.metadata, version: currentRelease.version }, existing, input.parsed);
  }
  if (existing) await assertInstalledBytes(existing);
  else if (await pathExists(outputRoot)) throw new CliError("Installation appeared after planning.", 1);

  if (snapshotPath) {
    await ensureSafeDirectory(input.root, path.dirname(snapshotPath));
    await rename(outputRoot, snapshotPath);
    history.push({
      version: existing.version,
      platform: existing.platform,
      installedAt: existing.installedAt,
      artifact: existing.artifact,
      contentDigest: existing.contentDigest,
      provenance,
      snapshotPath,
    });
    transaction = { ...transaction, state: "previous-staged" };
    await writeInstallTransaction(input.root, transaction);
    await input.runtime.installFault?.("previous-staged");
  }

  await input.runtime.beforeInstallPromotion?.();
  await ensureSafeDirectory(input.root, path.dirname(outputRoot));
  await rename(stageRoot, outputRoot);
  transaction = { ...transaction, state: "installed" };
  await writeInstallTransaction(input.root, transaction);
  await input.runtime.installFault?.("installed");
  if (!await directoryMatchesDigest(outputRoot, contentDigest)) throw new CliError("Promoted installation failed byte verification. Recovery is retained.", 1);
  const installed: InstalledSkillRecord = {
    slug,
    version: bundle.version,
    platform: bundle.platform.name,
    path: outputRoot,
    installedAt: new Date().toISOString(),
    artifact: bundle.artifact,
    contentDigest,
    provenance,
    history,
  };
  input.registry.installations[slug] = installed;
  await writeInstallRegistry(input.root, input.registry);
  transaction = { ...transaction, state: "registry-committed" };
  await writeInstallTransaction(input.root, transaction);
  await input.runtime.installFault?.("registry-committed");
  await rm(installTransactionPath(input.root, transactionId), { force: true });
  return installed;
}

async function downloadVerifiedBundle(input: {
  slug: string;
  version: string;
  platform?: string;
}, parsed: ParsedArgs, runtime: CliRuntime, token?: string): Promise<VerifiedBundle> {
  const slug = parseInstallSlug(input.slug);
  const version = input.version;
  const releaseResponse = await apiGet(
    `/v1/skills/${encodeURIComponent(slug)}/releases/${encodeURIComponent(version)}`,
    parsed,
    runtime,
    token,
  );
  const release = releaseMetadata(releaseResponse, { slug, version });
  const platform = selectReleasePlatform(release, input.platform);
  const bundleText = await apiGetText(
    `/v1/skills/${encodeURIComponent(slug)}/releases/${encodeURIComponent(version)}/bundle?platform=${encodeURIComponent(platform.name)}`,
    parsed,
    runtime,
    token,
  );
  const byteSize = Buffer.byteLength(bundleText);
  const sha256 = createHash("sha256").update(bundleText).digest("hex");
  if (byteSize !== release.artifact.byteSize || sha256 !== release.artifact.sha256) {
    throw new CliError("Downloaded bundle did not match release metadata.", 1);
  }

  const files = parseBundlePayload(bundleText);
  validatePortableFilePaths(files);
  for (const file of files) {
    safeBundlePath(file.path);
  }
  let manifest;
  try {
    manifest = loadSkillManifestFromPackageFiles(files);
  } catch {
    throw new CliError("Downloaded bundle has an invalid package manifest.", 1);
  }
  if (manifest.name !== release.slug || manifest.version !== release.version) {
    throw new CliError("Downloaded bundle manifest does not match release metadata.", 1);
  }
  if (release.slug !== slug || release.version !== version) throw new CliError("API release identity does not match the requested package.", 1);
  return {
    slug: release.slug,
    version: release.version,
    artifact: release.artifact,
    platform,
    files,
    release: release.metadata,
  };
}

interface VerifiedBundle {
  slug: string;
  version: string;
  platform: ReleasePlatform;
  artifact: ReleaseArtifact;
  files: Array<{ path: string; content: string }>;
  release: SkillReleaseMetadata;
}

interface ReleasePlatform {
  name: string;
  installTarget: string;
  status: "supported" | "deprecated" | "planned";
}

interface ReleaseArtifact {
  sha256: string;
  byteSize: number;
}

interface ReleaseInfo {
  slug: string;
  version: string;
  platforms: ReleasePlatform[];
  artifact: ReleaseArtifact;
  metadata: SkillReleaseMetadata;
}

interface InstallRegistry {
  version: 1;
  installations: Record<string, InstalledSkillRecord>;
}

interface InstalledSkillRecord {
  slug: string;
  version: string;
  platform: string;
  path: string;
  installedAt: string;
  artifact: ReleaseArtifact;
  contentDigest: string;
  history: InstalledSkillSnapshot[];
  provenance?: RegistryProvenance;
}

interface InstalledSkillSnapshot {
  version: string;
  platform: string;
  installedAt: string;
  artifact: ReleaseArtifact;
  contentDigest: string;
  snapshotPath: string;
  provenance?: RegistryProvenance;
}

interface InstallTransaction {
  version: 1;
  id: string;
  operation: "install" | "update" | "rollback";
  state: InstallFaultPoint;
  slug: string;
  targetVersion: string;
  targetPlatform: string;
  targetArtifact: ReleaseArtifact;
  targetContentDigest: string;
  previous: InstalledSkillRecord | null;
  snapshotCreated: boolean;
  sourceSnapshotPath?: string;
}

type CliVisibilityScope = (typeof CLI_VISIBILITY_SCOPES)[number];

interface CliSharingSettings {
  publicVisibilityEnabled: boolean;
  authenticatedVisibilityEnabled: boolean;
  teamsEnabled: boolean;
  teamVisibilityEnabled: boolean;
  userVisibilityEnabled: boolean;
  organizationVisibilityEnabled?: boolean;
}

interface CliTeamSummary {
  id: string;
  name: string;
  role: string;
}

interface CliUserSummary {
  id: string;
  email: string;
  name: string;
}

interface CliOrganizationSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  role: string;
}

interface CliSkillSharingDetails {
  slug: string;
  title: string;
  visibility: string;
  settings: CliSharingSettings | null;
  availableTeams: CliTeamSummary[];
  teamGrants: CliTeamSummary[];
  userGrants: CliUserSummary[];
  availableOrganizations: CliOrganizationSummary[];
  organizationGrants: CliOrganizationSummary[];
}

interface CliTeamRecord {
  id: string;
  name: string;
  role: string;
  members: unknown[];
  invitations: CliTeamInvitation[];
}

interface CliTeamInvitation {
  id: string;
  teamId: string;
  teamName: string;
  email: string;
  status: string;
}

interface CliSkillRow {
  slug: string;
  title: string;
  latestVersion: string | null;
}

function releaseMetadata(response: Record<string, unknown>, fallback: { slug: string; version: string }): ReleaseInfo {
  const release = response.release;
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new CliError("API release response is missing release metadata.", 1);
  }
  const record = release as Record<string, unknown>;
  return {
    slug: typeof record.slug === "string" && record.slug ? record.slug : fallback.slug,
    version: typeof record.version === "string" && record.version ? record.version : fallback.version,
    platforms: parseReleasePlatforms(record.platforms),
    artifact: releaseArtifact(response),
    metadata: parseSkillReleaseMetadata({
      releaseNotes: record.releaseNotes,
      changeKind: record.changeKind,
      requiresUserAction: record.requiresUserAction,
      compatibility: record.compatibility,
    }),
  };
}

function parseReleasePlatforms(input: unknown): ReleasePlatform[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.flatMap((platform) => {
    if (!platform || typeof platform !== "object" || Array.isArray(platform)) {
      return [];
    }
    const record = platform as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.installTarget !== "string") {
      return [];
    }
    return [{
      name: record.name,
      installTarget: record.installTarget,
      status: record.status === "deprecated" || record.status === "planned" ? record.status : "supported",
    }];
  });
}

function selectReleasePlatform(release: ReleaseInfo, requestedPlatform: string | undefined): ReleasePlatform {
  const platform = requestedPlatform
    ? release.platforms.find((candidate) => candidate.name === requestedPlatform)
    : release.platforms.find((candidate) => candidate.name === "codex" && candidate.status === "supported")
      ?? release.platforms.find((candidate) => candidate.status === "supported")
      ?? release.platforms[0];
  if (requestedPlatform && !platform) {
    throw new CliError(`Platform is not available for this release: ${requestedPlatform}`, 1);
  }
  if (platform && platform.status !== "supported") {
    throw new CliError(`Platform is not supported for this release: ${platform.name}`, 1);
  }
  return platform ?? {
    name: requestedPlatform ?? "codex",
    installTarget: "unknown",
    status: "supported",
  };
}

function installRoot(parsed: ParsedArgs, runtime: CliRuntime): string {
  if (parsed.command === "codex" && !optionalStringOption(parsed, "workspace")) throw new CliError("Codex commands require an explicit --workspace <absolute-dir>.", 2);
  const workspace = optionalStringOption(parsed, "workspace");
  if (workspace && (!path.isAbsolute(workspace) || path.resolve(workspace) === os.homedir() || path.resolve(workspace) === path.join(os.homedir(), ".codex"))) throw new CliError("Choose an absolute project workspace, not the home or global Codex directory.", 2);
  const configured = optionalStringOption(parsed, "dir")
    ?? (workspace ? path.join(workspace, ".agents", "skills") : undefined)
    ?? runtime.env.MYSKILLS_INSTALL_DIR
    ?? (runtime.env.XDG_DATA_HOME ? path.join(runtime.env.XDG_DATA_HOME, "myskills-app", "skills") : undefined)
    ?? (runtime.env.HOME ? path.join(runtime.env.HOME, ".local", "share", "myskills-app", "skills") : undefined)
    ?? path.join(process.cwd(), ".myskills-app", "skills");
  return path.resolve(configured);
}

async function readInstallRegistry(root: string): Promise<InstallRegistry> {
  assertInstallRootLocked(root);
  await recoverInstallTransactions(root);
  return readInstallRegistryFile(root);
}

async function readInstallRegistryFile(root: string): Promise<InstallRegistry> {
  try {
    return parseInstallRegistry(await readRegularText(installRegistryPath(root)), root);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: 1, installations: {} };
    }
    throw error;
  }
}

async function writeInstallRegistry(root: string, registry: InstallRegistry): Promise<void> {
  const filePath = installRegistryPath(root);
  assertInstallRootLocked(root);
  await atomicPrivateWrite(root, filePath, `${JSON.stringify(registry, null, 2)}\n`);
}

function parseInstallRegistry(raw: string, root: string): InstallRegistry {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("Install registry must contain a JSON object.", 1);
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || !record.installations || typeof record.installations !== "object" || Array.isArray(record.installations)) {
    throw new CliError("Install registry has an unsupported format.", 1);
  }
  const installations: Record<string, InstalledSkillRecord> = {};
  for (const [slug, value] of Object.entries(record.installations as Record<string, unknown>)) {
    const installed = parseInstalledSkillRecord(slug, value, root);
    if (installed) {
      installations[slug] = installed;
    }
  }
  return { version: 1, installations };
}

function parseInstalledSkillRecord(slug: string, input: unknown, root: string): InstalledSkillRecord | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.version !== "string" || !parseSemanticVersion(record.version) || typeof record.platform !== "string") {
    return null;
  }
  const normalizedSlug = parseInstallSlug(slug);
  const installPath = skillInstallPath(root, normalizedSlug);
  return {
    slug: normalizedSlug,
    version: record.version,
    platform: record.platform,
    path: installPath,
    installedAt: typeof record.installedAt === "string" ? record.installedAt : "",
    artifact: parseStoredArtifact(record.artifact),
    contentDigest: typeof record.contentDigest === "string" && /^[a-f0-9]{64}$/.test(record.contentDigest)
      ? record.contentDigest
      : "",
    history: parseInstallHistory(record.history, root),
    provenance: parseProvenance(record.provenance),
  };
}

function parseInstallHistory(input: unknown, root: string): InstalledSkillSnapshot[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (typeof record.version !== "string" || !parseSemanticVersion(record.version) || typeof record.platform !== "string" || typeof record.snapshotPath !== "string") {
      return [];
    }
    const snapshotPath = path.resolve(record.snapshotPath);
    assertChildPath(path.join(root, ".myskills-app", "history"), snapshotPath);
    return [{
      version: record.version,
      platform: record.platform,
      installedAt: typeof record.installedAt === "string" ? record.installedAt : "",
      artifact: parseStoredArtifact(record.artifact),
      contentDigest: typeof record.contentDigest === "string" && /^[a-f0-9]{64}$/.test(record.contentDigest)
        ? record.contentDigest
        : "",
      snapshotPath,
      provenance: parseProvenance(record.provenance),
    }];
  });
}

function parseStoredArtifact(input: unknown): ReleaseArtifact {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { sha256: "", byteSize: 0 };
  }
  const record = input as Record<string, unknown>;
  return {
    sha256: typeof record.sha256 === "string" ? record.sha256 : "",
    byteSize: typeof record.byteSize === "number" ? record.byteSize : 0,
  };
}

function printTeamDashboard(response: Record<string, unknown>, io: CliIo): void {
  const teams = arrayField(response, "teams").map(teamFromRecord);
  const invitations = arrayField(response, "invitations").map(invitationFromRecord);
  if (teams.length === 0 && invitations.length === 0) {
    io.stdout("No teams or pending invitations.");
    return;
  }
  for (const team of teams) {
    io.stdout(`team\t${team.id}\t${team.name}\trole=${team.role}\tmembers=${team.members.length}\tpending=${team.invitations.length}`);
  }
  for (const invitation of invitations) {
    io.stdout(`invitation\t${invitation.id}\t${invitation.teamName}\t${invitation.email}\tstatus=${invitation.status}`);
  }
}

function printTeamSharedSkills(response: Record<string, unknown>, io: CliIo): void {
  const groups = arrayField(response, "teams");
  if (groups.length === 0) {
    io.stdout("No team-shared skills.");
    return;
  }
  for (const groupInput of groups) {
    const group = recordField(groupInput, "team shared-skill group");
    const team = teamSummaryFromRecord(group.team);
    const sharingWithTeam = arrayField(group, "sharingWithTeam").map(skillRowFromRecord);
    const sharedWithMe = arrayField(group, "sharedWithMe").map(skillRowFromRecord);
    io.stdout(`team\t${team.id}\t${team.name}\trole=${team.role}\tsharing-out=${sharingWithTeam.length}\tshared-in=${sharedWithMe.length}`);
    for (const skill of sharingWithTeam) {
      io.stdout(`sharing-out\t${team.id}\t${skill.slug}\t${skill.latestVersion ?? "-"}\t${skill.title}`);
    }
    for (const skill of sharedWithMe) {
      io.stdout(`shared-in\t${team.id}\t${skill.slug}\t${skill.latestVersion ?? "-"}\t${skill.title}`);
    }
  }
}

function printSkillSharing(response: Record<string, unknown>, io: CliIo): void {
  const sharing = skillSharingFromResponse(response);
  const teams = sharing.teamGrants.map((team) => `${team.name}(${team.id})`).join(",") || "-";
  const users = sharing.userGrants.map((user) => user.email).join(",") || "-";
  const organizations = sharing.organizationGrants.map((organization) => `${organization.name}(${organization.id})`).join(",") || "-";
  const organizationField = sharing.organizationGrants.length > 0 || sharing.availableOrganizations.length > 0
    ? `\torganizations=${organizations}`
    : "";
  io.stdout(`${sharing.slug}\tvisibility=${sharing.visibility}\tteams=${teams}\tusers=${users}${organizationField}`);
}

/**
 * Architecture JSON is a public projection, not a pass-through of the API
 * response. Keep this allowlist in the CLI boundary so an API error, storage
 * implementation, or future response field cannot accidentally expose a
 * package body, local path, credential, or provider endpoint to stdout.
 */
function safeArchitecturePatternsResponse(response: Record<string, unknown>): Record<string, unknown> {
  const patterns = arrayField(response, "patterns").map(safeArchitecturePatternJson);
  return {
    patterns,
    count: patterns.length,
  };
}

function safeArchitecturePatternJson(input: unknown): Record<string, unknown> {
  const pattern = jsonRecord(input);
  if (!pattern) return {};
  return {
    ...(jsonString(pattern, "id") ? { id: jsonString(pattern, "id") } : {}),
    ...(jsonString(pattern, "key") ? { key: jsonString(pattern, "key") } : {}),
    ...(jsonString(pattern, "name") ? { name: jsonString(pattern, "name") } : {}),
    ...(jsonString(pattern, "title") ? { title: jsonString(pattern, "title") } : {}),
    ...(jsonString(pattern, "description") ? { description: jsonString(pattern, "description") } : {}),
    ...(jsonString(pattern, "status") ? { status: jsonString(pattern, "status") } : {}),
    ...(jsonNumber(pattern, "maxRouterDepth") !== undefined ? { maxRouterDepth: jsonNumber(pattern, "maxRouterDepth") } : {}),
    ...(jsonBoolean(pattern, "supportsNestedRouters") !== undefined ? { supportsNestedRouters: jsonBoolean(pattern, "supportsNestedRouters") } : {}),
  };
}

function safeArchitecturesResponse(response: Record<string, unknown>): Record<string, unknown> {
  const architectures = arrayField(response, "architectures").map((value) => safeArchitectureRecordJson(value));
  return {
    architectures,
    count: architectures.length,
  };
}

function safeArchitectureDetailsResponse(response: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(response, "architecture")) {
    return safeArchitectureRecordJson(response);
  }
  const architectureSource = jsonRecord(response.architecture);
  const result: Record<string, unknown> = {
    architecture: safeArchitectureRecordJson(architectureSource),
  };
  const revisions = arrayField(architectureSource ?? {}, "revisions").length > 0
    ? arrayField(architectureSource ?? {}, "revisions")
    : arrayField(response, "revisions");
  if (revisions.length > 0) {
    result.revisions = revisions.map(safeArchitectureRevisionJson);
  }
  if (Object.prototype.hasOwnProperty.call(response, "latestRevision")) {
    result.latestRevision = response.latestRevision === null
      ? null
      : safeArchitectureRevisionJson(response.latestRevision);
  }
  return result;
}

function safeArchitectureRevisionResponse(response: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(response, "revision")) {
    return safeArchitectureRevisionJson(response);
  }
  return { revision: safeArchitectureRevisionJson(response.revision) };
}

function safeArchitectureRecordJson(input: unknown): Record<string, unknown> {
  const wrapper = jsonRecord(input) ?? {};
  const source = jsonRecord(Object.prototype.hasOwnProperty.call(wrapper, "architecture") ? wrapper.architecture : input) ?? {};
  const access = jsonRecord(source.access);
  const nestedRevisions = arrayField(source, "revisions");
  const wrapperRevisions = arrayField(wrapper, "revisions");
  const revisions = nestedRevisions.length > 0 ? nestedRevisions : wrapperRevisions;
  const organizationIds = safeArchitectureOrganizationIdsJson(
    Object.prototype.hasOwnProperty.call(source, "allowedOrganizationIds")
      ? source.allowedOrganizationIds
      : access?.allowedOrganizationIds,
  );
  const hasLatestRevision = Object.prototype.hasOwnProperty.call(wrapper, "latestRevision")
    || Object.prototype.hasOwnProperty.call(source, "latestRevision");
  const latestRevision = Object.prototype.hasOwnProperty.call(wrapper, "latestRevision")
    ? wrapper.latestRevision
    : source.latestRevision;
  return {
    ...(jsonString(source, "id") ? { id: jsonString(source, "id") } : {}),
    ...(jsonString(source, "name") ? { name: jsonString(source, "name") } : {}),
    ...(jsonString(source, "title") ? { title: jsonString(source, "title") } : {}),
    ...(jsonString(source, "description") ? { description: jsonString(source, "description") } : {}),
    ...(jsonString(source, "patternId") ? { patternId: jsonString(source, "patternId") } : {}),
    ...(jsonString(source, "scope") ? { scope: jsonString(source, "scope") } : {}),
    ...(jsonString(source, "status") ? { status: jsonString(source, "status") } : {}),
    ...(jsonString(source, "currentRevisionId") ? { currentRevisionId: jsonString(source, "currentRevisionId") } : {}),
    ...(jsonNumber(source, "revisionCount") !== undefined ? { revisionCount: jsonNumber(source, "revisionCount") } : {}),
    ...(jsonString(source, "createdAt") ? { createdAt: jsonString(source, "createdAt") } : {}),
    ...(jsonString(source, "updatedAt") ? { updatedAt: jsonString(source, "updatedAt") } : {}),
    ...(organizationIds ? { allowedOrganizationIds: organizationIds } : {}),
    ...(revisions.length > 0 ? { revisions: revisions.map(safeArchitectureRevisionJson) } : {}),
    ...(hasLatestRevision
      ? { latestRevision: latestRevision === null ? null : safeArchitectureRevisionJson(latestRevision) }
      : {}),
  };
}

function safeArchitectureRevisionJson(input: unknown): Record<string, unknown> {
  const revision = jsonRecord(input) ?? {};
  return {
    ...(jsonString(revision, "id") ? { id: jsonString(revision, "id") } : {}),
    ...(jsonString(revision, "architectureId") ? { architectureId: jsonString(revision, "architectureId") } : {}),
    ...(jsonNumber(revision, "revision") !== undefined ? { revision: jsonNumber(revision, "revision") } : {}),
    ...(jsonNumber(revision, "revisionNumber") !== undefined ? { revisionNumber: jsonNumber(revision, "revisionNumber") } : {}),
    ...(jsonString(revision, "version") ? { version: jsonString(revision, "version") } : {}),
    ...(jsonString(revision, "message") ? { message: jsonString(revision, "message") } : {}),
    ...(jsonString(revision, "patternId") ? { patternId: jsonString(revision, "patternId") } : {}),
    ...(jsonNumber(revision, "nodeCount") !== undefined ? { nodeCount: jsonNumber(revision, "nodeCount") } : {}),
    ...(jsonNumber(revision, "skillCount") !== undefined ? { skillCount: jsonNumber(revision, "skillCount") } : {}),
    ...(jsonString(revision, "createdAt") ? { createdAt: jsonString(revision, "createdAt") } : {}),
  };
}

function safeArchitecturePreviewResponse(response: Record<string, unknown>): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(response, "preview")) {
    return { preview: safeArchitecturePreviewRecordJson(response.preview) };
  }
  return safeArchitecturePreviewRecordJson(response);
}

function safeArchitecturePreviewRecordJson(input: unknown): Record<string, unknown> {
  const preview = jsonRecord(input) ?? {};
  const revision = jsonRecord(preview.revision);
  const compiled = jsonRecord(preview.compiled);
  const graph = jsonRecord(preview.graph);
  const topology = jsonRecord(preview.topology);
  const plan = jsonRecord(preview.plan ?? preview.syncPlan);
  const effective = jsonRecord(preview.effective);
  const exposure = jsonRecord(preview.exposure);
  const outline = safeArchitectureOutlineJson(preview.outline);
  const diagram = safeArchitectureDiagramJson(preview.diagram);
  const architectureId = jsonString(revision ?? {}, "architectureId")
    ?? jsonString(preview, "architectureId")
    ?? jsonString(compiled ?? {}, "architectureId");
  const revisionId = jsonString(revision ?? {}, "id") ?? jsonString(preview, "revisionId");
  const revisionNumber = jsonNumber(revision ?? {}, "revisionNumber");
  const topologySource = topology && Object.keys(topology).length > 0 ? topology : graph ?? {};
  const nodes = arrayField(topologySource, "nodes");
  const edges = arrayField(topologySource, "edges");
  const compiledNodes = arrayField(compiled ?? {}, "nodes");
  return {
    ...(architectureId ? { architectureId } : {}),
    ...(revisionId ? { revisionId } : {}),
    ...(revisionNumber !== undefined ? { revisionNumber } : {}),
    ...(jsonNumber(preview, "revision") !== undefined ? { revision: jsonNumber(preview, "revision") } : {}),
    ...(revision ? { revision: safeArchitectureRevisionJson(revision) } : {}),
    ...(jsonString(preview, "mermaid", true) ? { mermaid: jsonString(preview, "mermaid", true) } : {}),
    ...(graph && Object.keys(graph).length > 0 ? { graph: safeArchitectureGraphJson(graph) } : {}),
    topology: {
      nodes: (nodes.length > 0 ? nodes : compiledNodes).map(safeArchitectureTopologyNodeJson),
      edges: (edges.length > 0 ? edges : arrayField(compiled ?? {}, "edges")).map(safeArchitectureTopologyEdgeJson),
    },
    ...(outline ? { outline } : {}),
    ...(compiled && Object.keys(compiled).length > 0 ? { compiled: safeArchitectureCompiledJson(compiled) } : {}),
    ...(effective && Object.keys(effective).length > 0 ? { effective: safeArchitectureEffectiveJson(effective) } : {}),
    ...(exposure && Object.keys(exposure).length > 0 ? { exposure: safeArchitectureExposureJson(exposure) } : {}),
    ...(plan && Object.keys(plan).length > 0 ? { plan: safeArchitecturePlanJson(plan) } : {}),
    ...(Object.keys(diagram).length > 0 ? { diagram } : {}),
  };
}

function safeArchitectureGraphJson(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(jsonString(input, "digest") ? { digest: jsonString(input, "digest") } : {}),
    nodes: arrayField(input, "nodes").map(safeArchitectureTopologyNodeJson),
    edges: arrayField(input, "edges").map(safeArchitectureTopologyEdgeJson),
    ...(jsonString(input, "mermaid", true) ? { mermaid: jsonString(input, "mermaid", true) } : {}),
  };
}

function safeArchitectureOutlineJson(input: unknown): Record<string, unknown> | Array<Record<string, unknown>> | undefined {
  if (Array.isArray(input)) {
    return input.length > 0 ? input.map(safeArchitectureOutlineNodeJson) : undefined;
  }
  const outline = jsonRecord(input);
  if (!outline) return undefined;
  const tree = arrayField(outline, "tree");
  return {
    ...(jsonString(outline, "title") ? { title: jsonString(outline, "title") } : {}),
    ...(jsonString(outline, "text", true) ? { text: jsonString(outline, "text", true) } : {}),
    ...(tree.length > 0 ? { tree: tree.map(safeArchitectureOutlineNodeJson) } : {}),
  };
}

function safeArchitectureTopologyNodeJson(input: unknown): Record<string, unknown> {
  const node = jsonRecord(input) ?? {};
  return {
    ...(jsonString(node, "id") ? { id: jsonString(node, "id") } : {}),
    ...(jsonString(node, "kind") ? { kind: jsonString(node, "kind") } : {}),
    ...(jsonString(node, "label") ? { label: jsonString(node, "label") } : {}),
    ...(jsonString(node, "slug") ? { slug: jsonString(node, "slug") } : {}),
    ...(jsonString(node, "skillRefId") ? { skillRefId: jsonString(node, "skillRefId") } : {}),
    ...(jsonString(node, "title") ? { title: jsonString(node, "title") } : {}),
    ...(jsonString(node, "description") ? { description: jsonString(node, "description") } : {}),
    ...(jsonNumber(node, "depth") !== undefined ? { depth: jsonNumber(node, "depth") } : {}),
    ...(jsonNumber(node, "x") !== undefined ? { x: jsonNumber(node, "x") } : {}),
    ...(jsonNumber(node, "y") !== undefined ? { y: jsonNumber(node, "y") } : {}),
  };
}

function safeArchitectureTopologyEdgeJson(input: unknown): Record<string, unknown> {
  const edge = jsonRecord(input) ?? {};
  return {
    ...(jsonString(edge, "id") ? { id: jsonString(edge, "id") } : {}),
    ...(jsonString(edge, "from") ? { from: jsonString(edge, "from") } : {}),
    ...(jsonString(edge, "to") ? { to: jsonString(edge, "to") } : {}),
    ...(jsonString(edge, "relationship") ? { relationship: jsonString(edge, "relationship") } : {}),
    ...(jsonString(edge, "kind") ? { kind: jsonString(edge, "kind") } : {}),
    ...(jsonString(edge, "label") ? { label: jsonString(edge, "label") } : {}),
  };
}

function safeArchitectureOutlineNodeJson(input: unknown): Record<string, unknown> {
  const node = jsonRecord(input) ?? {};
  const children = arrayField(node, "children");
  return {
    ...(jsonString(node, "id") ? { id: jsonString(node, "id") } : {}),
    ...(jsonString(node, "kind") ? { kind: jsonString(node, "kind") } : {}),
    ...(jsonString(node, "label") ? { label: jsonString(node, "label") } : {}),
    ...(jsonString(node, "skillRefId") ? { skillRefId: jsonString(node, "skillRefId") } : {}),
    ...(jsonNumber(node, "depth") !== undefined ? { depth: jsonNumber(node, "depth") } : {}),
    ...(children.length > 0 ? { children: children.map(safeArchitectureOutlineNodeJson) } : {}),
  };
}

function safeArchitecturePlanJson(input: Record<string, unknown>): Record<string, unknown> {
  const items = arrayField(input, "items");
  const changes = arrayField(input, "changes");
  const summary = jsonRecord(input.summary);
  const safeSummary = summary
    ? Object.fromEntries(["changeCount", "installCount", "updateCount", "removeCount", "unsupportedCount", "conflictCount"]
      .flatMap((key) => {
        const value = jsonNumber(summary, key);
        return value === undefined ? [] : [[key, value]];
      }))
    : undefined;
  return {
    ...(jsonString(input, "status") ? { status: jsonString(input, "status") } : {}),
    ...(jsonString(input, "target") ? { target: jsonString(input, "target") } : {}),
    ...(jsonBoolean(input, "dryRun") !== undefined ? { dryRun: jsonBoolean(input, "dryRun") } : {}),
    ...(jsonBoolean(input, "canApply") !== undefined ? { canApply: jsonBoolean(input, "canApply") } : {}),
    ...(jsonBoolean(input, "requiresApproval") !== undefined ? { requiresApproval: jsonBoolean(input, "requiresApproval") } : {}),
    ...(jsonString(input, "targetId") ? { targetId: jsonString(input, "targetId") } : {}),
    ...(jsonString(input, "environmentId") ? { environmentId: jsonString(input, "environmentId") } : {}),
    ...(jsonString(input, "architectureId") ? { architectureId: jsonString(input, "architectureId") } : {}),
    ...(jsonString(input, "revisionDigest") ? { revisionDigest: jsonString(input, "revisionDigest") } : {}),
    ...(safeSummary && Object.keys(safeSummary).length > 0 ? { summary: safeSummary } : {}),
    ...(items.length > 0 ? { items: items.map(safeArchitecturePlanItemJson) } : {}),
    ...(changes.length > 0 ? { changes: changes.map(safeArchitecturePlanChangeJson) } : {}),
  };
}

function safeArchitecturePlanItemJson(input: unknown): Record<string, unknown> {
  const item = jsonRecord(input) ?? {};
  const desired = safeArchitecturePlanStateJson(item.desired);
  const observed = safeArchitecturePlanStateJson(item.observed);
  return {
    ...(jsonString(item, "action") ? { action: jsonString(item, "action") } : {}),
    ...(jsonString(item, "type") ? { type: jsonString(item, "type") } : {}),
    ...(jsonString(item, "nodeId") ? { nodeId: jsonString(item, "nodeId") } : {}),
    ...(jsonString(item, "kind") ? { kind: jsonString(item, "kind") } : {}),
    ...(jsonString(item, "skillRefId") ? { skillRefId: jsonString(item, "skillRefId") } : {}),
    ...(jsonString(item, "reason") ? { reason: jsonString(item, "reason") } : {}),
    ...(desired ? { desired } : {}),
    ...(observed ? { observed } : {}),
  };
}

function safeArchitecturePlanStateJson(input: unknown): Record<string, unknown> | undefined {
  const state = jsonRecord(input);
  if (!state) return undefined;
  const result = {
    ...(jsonString(state, "version") ? { version: jsonString(state, "version") } : {}),
    ...(jsonString(state, "digest") ? { digest: jsonString(state, "digest") } : {}),
    ...(jsonBoolean(state, "enabled") !== undefined ? { enabled: jsonBoolean(state, "enabled") } : {}),
    ...(jsonString(state, "runtimeExposure") ? { runtimeExposure: jsonString(state, "runtimeExposure") } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeArchitecturePlanChangeJson(input: unknown): Record<string, unknown> {
  const change = jsonRecord(input) ?? {};
  return {
    ...(jsonString(change, "id") ? { id: jsonString(change, "id") } : {}),
    ...(jsonString(change, "type") ? { type: jsonString(change, "type") } : {}),
    ...(jsonString(change, "action") ? { action: jsonString(change, "action") } : {}),
    ...(jsonString(change, "subject") ? { subject: jsonString(change, "subject") } : {}),
    ...(jsonString(change, "detail") ? { detail: jsonString(change, "detail") } : {}),
    ...(jsonString(change, "severity") ? { severity: jsonString(change, "severity") } : {}),
  };
}

function safeArchitectureCompiledJson(input: Record<string, unknown>): Record<string, unknown> {
  const pattern = jsonRecord(input.pattern);
  const disabledNodeIds = jsonStringArray(input, "disabledNodeIds");
  const nodes = arrayField(input, "nodes");
  const allNodes = arrayField(input, "allNodes");
  const edges = arrayField(input, "edges");
  const skills = arrayField(input, "skills");
  const routers = arrayField(input, "routers");
  return {
    ...(jsonNumber(input, "schemaVersion") !== undefined ? { schemaVersion: jsonNumber(input, "schemaVersion") } : {}),
    ...(jsonString(input, "architectureId") ? { architectureId: jsonString(input, "architectureId") } : {}),
    ...(jsonString(pattern ?? {}, "id") ? { patternId: jsonString(pattern ?? {}, "id") } : {}),
    ...(jsonString(input, "rootNodeId") ? { rootNodeId: jsonString(input, "rootNodeId") } : {}),
    ...(jsonString(input, "profileId") ? { profileId: jsonString(input, "profileId") } : {}),
    ...(jsonString(input, "environmentId") ? { environmentId: jsonString(input, "environmentId") } : {}),
    ...(disabledNodeIds ? { disabledNodeIds } : {}),
    ...(nodes.length > 0 ? { nodes: nodes.map(safeArchitectureCompiledNodeJson) } : {}),
    ...(allNodes.length > 0 ? { allNodes: allNodes.map(safeArchitectureCompiledNodeJson) } : {}),
    ...(edges.length > 0 ? { edges: edges.map(safeArchitectureTopologyEdgeJson) } : {}),
    ...(skills.length > 0 ? { skills: skills.map(safeArchitectureCompiledSkillJson) } : {}),
    ...(routers.length > 0 ? { routers: routers.map(safeArchitectureCompiledRouterJson) } : {}),
    ...(jsonString(input, "entrypoint") ? { entrypoint: jsonString(input, "entrypoint") } : {}),
    ...(jsonString(input, "bundleName") ? { bundleName: jsonString(input, "bundleName") } : {}),
    ...(jsonString(input, "revisionDigest") ? { digest: jsonString(input, "revisionDigest"), revisionDigest: jsonString(input, "revisionDigest") } : {}),
  };
}

function safeArchitectureCompiledNodeJson(input: unknown): Record<string, unknown> {
  const node = jsonRecord(input) ?? {};
  const childNodeIds = jsonStringArray(node, "childNodeIds");
  return {
    ...(jsonString(node, "id") ? { id: jsonString(node, "id") } : {}),
    ...(jsonString(node, "kind") ? { kind: jsonString(node, "kind") } : {}),
    ...(jsonString(node, "label") ? { label: jsonString(node, "label") } : {}),
    ...(jsonString(node, "skillRefId") ? { skillRefId: jsonString(node, "skillRefId") } : {}),
    ...(jsonString(node, "slug") ? { slug: jsonString(node, "slug") } : {}),
    ...(jsonString(node, "runtimeExposure") ? { runtimeExposure: jsonString(node, "runtimeExposure") } : {}),
    ...(childNodeIds ? { childNodeIds } : {}),
  };
}

function safeArchitectureCompiledRouterJson(input: unknown): Record<string, unknown> {
  const router = jsonRecord(input) ?? {};
  const childNodeIds = jsonStringArray(router, "childNodeIds");
  const routes = arrayField(router, "routes");
  return {
    ...(jsonString(router, "nodeId") ? { nodeId: jsonString(router, "nodeId") } : {}),
    ...(childNodeIds ? { childNodeIds } : {}),
    ...(routes.length > 0 ? { routes: routes.map(safeArchitectureTopologyEdgeJson) } : {}),
    ...(jsonString(router, "digest") ? { digest: jsonString(router, "digest") } : {}),
  };
}

function safeArchitectureCompiledSkillJson(input: unknown): Record<string, unknown> {
  const skill = jsonRecord(input) ?? {};
  const tags = jsonStringArray(skill, "tags");
  return {
    ...(jsonString(skill, "id") ? { id: jsonString(skill, "id") } : {}),
    ...(jsonString(skill, "skillRefId") ? { skillRefId: jsonString(skill, "skillRefId") } : {}),
    ...(jsonString(skill, "slug") ? { slug: jsonString(skill, "slug") } : {}),
    ...(jsonString(skill, "title") ? { title: jsonString(skill, "title") } : {}),
    ...(jsonString(skill, "summary") ? { summary: jsonString(skill, "summary") } : {}),
    ...(jsonString(skill, "version") ? { version: jsonString(skill, "version") } : {}),
    ...(jsonString(skill, "digest") ? { digest: jsonString(skill, "digest") } : {}),
    ...(jsonString(skill, "packageVisibility") ? { packageVisibility: jsonString(skill, "packageVisibility") } : {}),
    ...(tags ? { tags } : {}),
    ...(jsonString(skill, "runtimeExposure") ? { runtimeExposure: jsonString(skill, "runtimeExposure") } : {}),
  };
}

function safeArchitectureEffectiveJson(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(arrayField(input, "skills").length > 0 ? { skills: arrayField(input, "skills").map(safeArchitectureCompiledSkillJson) } : {}),
    ...(arrayField(input, "includedSkills").length > 0 ? { includedSkills: arrayField(input, "includedSkills").map(safeArchitectureCompiledSkillJson) } : {}),
    ...(arrayField(input, "excludedSkills").length > 0 ? { excludedSkills: arrayField(input, "excludedSkills").map(safeArchitectureCompiledSkillJson) } : {}),
    ...(jsonString(input, "summary") ? { summary: jsonString(input, "summary") } : {}),
  };
}

function safeArchitectureExposureJson(input: Record<string, unknown>): Record<string, unknown> {
  const included = jsonStringArray(input, "included");
  const excluded = jsonStringArray(input, "excluded");
  return {
    ...(jsonString(input, "summary") ? { summary: jsonString(input, "summary") } : {}),
    ...(included ? { included } : {}),
    ...(excluded ? { excluded } : {}),
  };
}

function safeArchitectureDiagramJson(input: unknown): Record<string, unknown> {
  const diagram = jsonRecord(input) ?? {};
  return {
    ...(jsonNumber(diagram, "schemaVersion") !== undefined ? { schemaVersion: jsonNumber(diagram, "schemaVersion") } : {}),
    ...(jsonString(diagram, "architectureId") ? { architectureId: jsonString(diagram, "architectureId") } : {}),
    ...(jsonString(diagram, "revisionDigest") ? { revisionDigest: jsonString(diagram, "revisionDigest") } : {}),
    ...(jsonString(diagram, "profileId") ? { profileId: jsonString(diagram, "profileId") } : {}),
    ...(jsonString(diagram, "environmentId") ? { environmentId: jsonString(diagram, "environmentId") } : {}),
    ...(jsonString(diagram, "accessibleTitle") ? { accessibleTitle: jsonString(diagram, "accessibleTitle") } : {}),
    ...(jsonString(diagram, "accessibleDescription") ? { accessibleDescription: jsonString(diagram, "accessibleDescription") } : {}),
    ...(jsonString(diagram, "mermaid", true) ? { mermaid: jsonString(diagram, "mermaid", true) } : {}),
    ...(jsonString(diagram, "mermaidSha256") ? { mermaidSha256: jsonString(diagram, "mermaidSha256") } : {}),
    ...(jsonString(diagram, "accessibleOutline", true) ? { accessibleOutline: jsonString(diagram, "accessibleOutline", true) } : {}),
    ...(jsonString(diagram, "artifactDigest") ? { artifactDigest: jsonString(diagram, "artifactDigest") } : {}),
  };
}

function safeArchitectureOrganizationIdsJson(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const ids = input.filter((value): value is string => (
    typeof value === "string"
      && value.length > 0
      && value.length <= 120
      && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ));
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

function jsonRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function jsonString(record: Record<string, unknown>, key: string, multiline = false): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? redactProjectionText(terminalSafeText(value, multiline)) : undefined;
}

function jsonNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function jsonBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function jsonStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return (value as string[]).map((item) => redactProjectionText(terminalSafeText(item)));
}

function redactProjectionText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>\]\}\),;]+/giu, "[redacted URL]")
    .replace(LOCAL_PATH_PATTERN, "[redacted path]");
}

function printSharingSettings(response: Record<string, unknown>, io: CliIo): void {
  const sharing = sharingSettingsFromResponse(response);
  io.stdout([
    `public=${enabledLabel(sharing.publicVisibilityEnabled)}`,
    `authenticated=${enabledLabel(sharing.authenticatedVisibilityEnabled)}`,
    `teams=${enabledLabel(sharing.teamsEnabled)}`,
    `team-visibility=${enabledLabel(sharing.teamVisibilityEnabled)}`,
    `user-visibility=${enabledLabel(sharing.userVisibilityEnabled)}`,
    `organization-visibility=${sharing.organizationVisibilityEnabled === undefined
      ? "unknown"
      : enabledLabel(sharing.organizationVisibilityEnabled)}`,
  ].join("\t"));
}

function printArchitecturePatterns(response: Record<string, unknown>, io: CliIo): void {
  const patterns = arrayField(response, "patterns");
  if (patterns.length === 0) {
    io.stdout("No architecture patterns.");
    return;
  }
  for (const value of patterns) {
    const pattern = recordField(value, "architecture pattern");
    io.stdout([
      terminalSafeText(optionalRecordString(pattern, "id") ?? optionalRecordString(pattern, "key") ?? "-"),
      terminalSafeText(optionalRecordString(pattern, "name") ?? optionalRecordString(pattern, "title") ?? "-"),
      terminalSafeText(optionalRecordString(pattern, "description") ?? "-"),
      terminalSafeText(optionalRecordString(pattern, "status") ?? "available"),
    ].join("\t"));
  }
}

function printArchitectures(response: Record<string, unknown>, io: CliIo): void {
  const architectures = arrayField(response, "architectures");
  if (architectures.length === 0) {
    io.stdout("No architectures.");
    return;
  }
  for (const value of architectures) {
    const architecture = recordField(value, "architecture");
    const revision = architecture.latestRevision;
    const latestRevision = revision && typeof revision === "object" && !Array.isArray(revision)
      ? revision as Record<string, unknown>
      : undefined;
    io.stdout([
      terminalSafeText(optionalRecordString(architecture, "id") ?? "-"),
      terminalSafeText(optionalRecordString(architecture, "name") ?? optionalRecordString(architecture, "title") ?? "-"),
      terminalSafeText(optionalRecordString(architecture, "patternId") ?? optionalRecordString(architecture, "pattern") ?? "-"),
      terminalSafeText(optionalRecordString(latestRevision ?? {}, "id") ?? optionalRecordString(architecture, "currentRevisionId") ?? "-"),
      terminalSafeText(optionalRecordString(architecture, "updatedAt") ?? "-"),
    ].join("\t"));
  }
}

function printArchitectureDetails(response: Record<string, unknown>, io: CliIo): void {
  const architecture = recordField(response.architecture ?? response, "architecture");
  io.stdout([
    terminalSafeText(optionalRecordString(architecture, "id") ?? "-"),
    terminalSafeText(optionalRecordString(architecture, "name") ?? optionalRecordString(architecture, "title") ?? "-"),
    terminalSafeText(optionalRecordString(architecture, "patternId") ?? optionalRecordString(architecture, "pattern") ?? "-"),
    terminalSafeText(optionalRecordString(architecture, "currentRevisionId") ?? "-"),
    terminalSafeText(optionalRecordString(architecture, "updatedAt") ?? "-"),
  ].join("\t"));
  const revisions = arrayField(architecture, "revisions").length > 0
    ? arrayField(architecture, "revisions")
    : arrayField(response, "revisions");
  for (const value of revisions) {
    const revision = recordField(value, "architecture revision");
    io.stdout([
      "revision",
      terminalSafeText(optionalRecordString(revision, "id") ?? "-"),
      terminalSafeText(optionalRecordString(revision, "message") ?? "-"),
      terminalSafeText(optionalRecordString(revision, "createdAt") ?? "-"),
    ].join("\t"));
  }
}

function printArchitectureRevision(response: Record<string, unknown>, io: CliIo): void {
  const revision = recordField(response.revision ?? response, "architecture revision");
  io.stdout([
    "revision",
    terminalSafeText(optionalRecordString(revision, "id") ?? "-"),
    terminalSafeText(optionalRecordString(revision, "message") ?? "-"),
    terminalSafeText(optionalRecordString(revision, "createdAt") ?? "-"),
  ].join("\t"));
}

function printArchitecturePreview(response: Record<string, unknown>, io: CliIo, architectureId?: string): void {
  const preview = recordField(response.preview ?? response, "architecture preview");
  const compiled = preview.compiled && typeof preview.compiled === "object" && !Array.isArray(preview.compiled)
    ? preview.compiled as Record<string, unknown>
    : {};
  const graph = preview.graph && typeof preview.graph === "object" && !Array.isArray(preview.graph)
    ? preview.graph as Record<string, unknown>
    : {};
  const topology = preview.topology && typeof preview.topology === "object" && !Array.isArray(preview.topology)
    ? preview.topology as Record<string, unknown>
    : Object.keys(graph).length > 0 ? graph : { nodes: arrayField(compiled, "nodes") };
  const nodes = arrayField(topology, "nodes");
  const rawPlan = preview.plan ?? preview.syncPlan;
  const syncPlan = rawPlan && typeof rawPlan === "object" && !Array.isArray(rawPlan)
    ? rawPlan as Record<string, unknown>
    : undefined;
  const revision = preview.revision && typeof preview.revision === "object" && !Array.isArray(preview.revision)
    ? preview.revision as Record<string, unknown>
    : {};
  io.stdout([
    "preview",
    terminalSafeText(optionalRecordString(preview, "architectureId") ?? architectureId ?? "-"),
    terminalSafeText(optionalRecordString(preview, "revisionId") ?? optionalRecordString(revision, "id") ?? optionalRecordString(preview, "revision") ?? "-"),
    `nodes=${nodes.length}`,
    `plan=${terminalSafeText(optionalRecordString(syncPlan ?? {}, "status") ?? "not-generated")}`,
  ].join("\t"));
  const mermaid = optionalRecordString(preview, "mermaid") ?? optionalRecordString(graph, "mermaid");
  if (mermaid) {
    io.stdout(redactProjectionText(terminalSafeText(mermaid, true)));
  }
}

function printArchitecturePlan(response: Record<string, unknown>, io: CliIo): void {
  const plan = recordField(response.plan ?? response.syncPlan ?? response, "sync plan");
  const changes = Array.isArray(plan.items) ? arrayField(plan, "items") : arrayField(plan, "changes");
  const actions = changes.map((value) => optionalRecordString(recordField(value, "sync change"), "action") ?? optionalRecordString(recordField(value, "sync change"), "type") ?? "unknown");
  const status = optionalRecordString(plan, "status")
    ?? (actions.includes("conflict") ? "conflict" : actions.includes("unsupported") ? "unsupported" : actions.some((action) => action !== "noop") ? "changes" : "noop");
  io.stdout([
    "dry-run",
    terminalSafeText(status),
    `changes=${changes.length}`,
  ].join("\t"));
  for (const value of changes) {
    const change = recordField(value, "sync change");
    io.stdout([
      "change",
      terminalSafeText(optionalRecordString(change, "type") ?? optionalRecordString(change, "action") ?? "unknown"),
      terminalSafeText(optionalRecordString(change, "subject") ?? optionalRecordString(change, "resourceRef") ?? optionalRecordString(change, "nodeId") ?? "-"),
      terminalSafeText(optionalRecordString(change, "detail") ?? optionalRecordString(change, "reason") ?? "-"),
    ].join("\t"));
  }
}

function architecturePreviewOptions(parsed: ParsedArgs, revisionId: string | undefined): Record<string, string> {
  const profileId = architectureOptionAlias(parsed, "profile", "profile-id");
  const environmentId = architectureOptionAlias(parsed, "environment", "environment-id");
  const organizationId = architectureOptionAlias(parsed, "organization-id", "organization");
  return {
    ...(profileId ? { profileId: parseArchitectureReference(profileId, "profile") } : {}),
    ...(environmentId ? { environmentId: parseArchitectureReference(environmentId, "environment") } : {}),
    ...(organizationId ? { organizationId: parseArchitectureReference(organizationId, "organization") } : {}),
    ...(revisionId ? { revisionId: parseArchitectureRevisionId(revisionId) } : {}),
  };
}

/** Resolve canonical/legacy architecture flags without silently choosing one. */
function architectureOptionAlias(
  parsed: ParsedArgs,
  canonicalKey: string,
  aliasKey: string,
): string | undefined {
  const canonical = oneStringOption(parsed, canonicalKey);
  const alias = oneStringOption(parsed, aliasKey);
  if (canonical !== undefined && alias !== undefined && canonical !== alias) {
    throw new CliError(`--${canonicalKey} and --${aliasKey} must match when both are provided.`, 2);
  }
  return canonical ?? alias;
}

function oneStringOption(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.options[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.length !== 1 || !value[0]) {
      throw new CliError(`--${key} accepts one value.`, 2);
    }
    return value[0];
  }
  return undefined;
}

function architectureRevisionOption(parsed: ParsedArgs): string | undefined {
  const aliases = [
    ["revision", oneStringOption(parsed, "revision")],
    ["revision-id", oneStringOption(parsed, "revision-id")],
    ["version", oneStringOption(parsed, "version")],
  ] as const;
  const values = aliases.flatMap(([, value]) => value === undefined ? [] : [value]);
  if (new Set(values).size > 1) {
    throw new CliError("--revision, --revision-id, and --version must match when multiple are provided.", 2);
  }
  return values[0];
}

async function readObservedStateFixture(inputPath: string): Promise<Record<string, unknown>> {
  if (hasControlCharacter(inputPath)) {
    throw new CliError("Observed-state fixture path contains control characters.", 2, "OBSERVED_STATE_INVALID");
  }
  const resolvedPath = path.resolve(inputPath);
  let text: string;
  try {
    text = await readFile(resolvedPath, "utf8");
  } catch {
    throw new CliError("Observed-state fixture could not be read.", 2, "OBSERVED_STATE_INVALID");
  }
  if (Buffer.byteLength(text, "utf8") > 256 * 1024) {
    throw new CliError("Observed-state fixture exceeds the 256 KiB limit.", 2, "OBSERVED_STATE_TOO_LARGE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("Observed-state fixture must contain valid JSON.", 2, "OBSERVED_STATE_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("Observed-state fixture must be a JSON object.", 2, "OBSERVED_STATE_INVALID");
  }
  const record = parsed as Record<string, unknown>;
  rejectObservedFixtureKeys(record, ["schemaVersion", "environment", "inventory"], "fixture");
  if (record.schemaVersion !== "myskills.observed-state.v1") {
    throw new CliError("Observed-state fixture schemaVersion must be myskills.observed-state.v1.", 2, "OBSERVED_STATE_INVALID");
  }
  if (!record.environment || typeof record.environment !== "object" || Array.isArray(record.environment)) {
    throw new CliError("Observed-state fixture must include an environment object.", 2, "OBSERVED_STATE_INVALID");
  }
  const environment = record.environment as Record<string, unknown>;
  rejectObservedFixtureKeys(environment, ["environmentKey", "toolKind", "adapterVersion", "capabilities"], "environment");
  validateObservedIdentifier(environment.environmentKey, "environment.environmentKey", 256);
  validateObservedText(environment.toolKind, "environment.toolKind", 128);
  validateObservedText(environment.adapterVersion, "environment.adapterVersion", 128);
  if (!environment.capabilities || typeof environment.capabilities !== "object" || Array.isArray(environment.capabilities)) {
    throw new CliError("Observed-state fixture environment must include capabilities.", 2, "OBSERVED_STATE_INVALID");
  }
  validateObservedCapabilities(environment.capabilities as Record<string, unknown>);
  const inventory = record.inventory;
  if (!Array.isArray(inventory) || inventory.length > 500 || inventory.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new CliError("Observed-state fixture inventory must be an array of at most 500 objects.", 2, "OBSERVED_STATE_INVALID");
  }
  for (const item of inventory) {
    const entry = item as Record<string, unknown>;
    rejectObservedFixtureKeys(entry, [
      "kind",
      "source",
      "ref",
      "id",
      "slug",
      "version",
      "artifactSha256",
      "enabled",
      "exposureMode",
      "managed",
      "supported",
      "configurationDigest",
      "configured",
    ], "inventory entry");
    if (!["skill", "router", "profile", "unknown"].includes(String(entry.kind))) {
      throw new CliError("Observed-state fixture inventory entries have an invalid kind.", 2, "OBSERVED_STATE_INVALID");
    }
    if (typeof entry.source !== "string" || !["myskills", "local", "unknown"].includes(entry.source)) {
      throw new CliError("Observed-state fixture inventory entries have an invalid source.", 2, "OBSERVED_STATE_INVALID");
    }
    validateObservedOptionalIdentifier(entry.ref, "inventory.ref");
    validateObservedOptionalIdentifier(entry.id, "inventory.id");
    validateObservedOptionalSlug(entry.slug, "inventory.slug");
    validateObservedOptionalVersion(entry.version, "inventory.version");
    validateObservedOptionalDigest(entry.artifactSha256, "inventory.artifactSha256");
    validateObservedOptionalDigest(entry.configurationDigest, "inventory.configurationDigest");
    validateObservedOptionalBoolean(entry.enabled, "inventory.enabled");
    validateObservedOptionalBoolean(entry.managed, "inventory.managed");
    validateObservedOptionalBoolean(entry.supported, "inventory.supported");
    validateObservedOptionalBoolean(entry.configured, "inventory.configured");
    validateObservedOptionalExposure(entry.exposureMode, "inventory.exposureMode");
    if (entry.ref === undefined && entry.slug === undefined && entry.id === undefined) {
      throw new CliError("Observed-state fixture inventory entries require ref, slug, or id.", 2, "OBSERVED_STATE_INVALID");
    }
  }
  return record;
}

function rejectObservedFixtureKeys(record: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (hasControlCharacter(key)) {
      throw new CliError(`Observed-state fixture ${label} contains a control-character field.`, 2, "OBSERVED_STATE_INVALID");
    }
    if (OBSERVED_FIXTURE_KEY_PATTERN.test(key) || !allowed.includes(key)) {
      throw new CliError(`Observed-state fixture field is not accepted: ${key}.`, 2, "OBSERVED_STATE_INVALID");
    }
  }
}

function validateObservedCapabilities(input: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(input)) {
    if (hasControlCharacter(key) || !OBSERVED_IDENTIFIER_PATTERN.test(key) || typeof value !== "boolean") {
      throw new CliError("Observed-state fixture capabilities must contain identifier keys and boolean values.", 2, "OBSERVED_STATE_INVALID");
    }
  }
}

function validateObservedIdentifier(value: unknown, label: string, maxLength = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || hasControlCharacter(value) || !OBSERVED_IDENTIFIER_PATTERN.test(value)) {
    throw new CliError(`Observed-state fixture ${label} is invalid.`, 2, "OBSERVED_STATE_INVALID");
  }
  return value;
}

function validateObservedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || hasControlCharacter(value)) {
    throw new CliError(`Observed-state fixture ${label} is invalid.`, 2, "OBSERVED_STATE_INVALID");
  }
  return value;
}

function validateObservedOptionalIdentifier(value: unknown, label: string): void {
  if (value !== undefined) {
    validateObservedIdentifier(value, label);
  }
}

function validateObservedOptionalSlug(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0 || value.length > 120 || hasControlCharacter(value) || !OBSERVED_SLUG_PATTERN.test(value)) {
    throw new CliError(`Observed-state fixture ${label} is invalid.`, 2, "OBSERVED_STATE_INVALID");
  }
}

function validateObservedOptionalVersion(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || hasControlCharacter(value) || !OBSERVED_VERSION_PATTERN.test(value)) {
    throw new CliError(`Observed-state fixture ${label} is invalid.`, 2, "OBSERVED_STATE_INVALID");
  }
}

function validateObservedOptionalDigest(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !OBSERVED_DIGEST_PATTERN.test(value) || hasControlCharacter(value)) {
    throw new CliError(`Observed-state fixture ${label} is invalid.`, 2, "OBSERVED_STATE_INVALID");
  }
}

function validateObservedOptionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new CliError(`Observed-state fixture ${label} is invalid.`, 2, "OBSERVED_STATE_INVALID");
  }
}

function validateObservedOptionalExposure(value: unknown, label: string): void {
  if (value !== undefined && value !== "disabled" && value !== "router" && value !== "leaf") {
    throw new CliError(`Observed-state fixture ${label} is invalid.`, 2, "OBSERVED_STATE_INVALID");
  }
}

function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

function terminalSafeText(value: string, multiline = false): string {
  return value.replace(CONTROL_CHARACTER_GLOBAL_PATTERN, (character) => multiline && character === "\n" ? "\n" : " ");
}

function apiSyncFixtureFromObservedState(observedState: Record<string, unknown>): Record<string, unknown> {
  const inventory = Array.isArray(observedState.inventory) ? observedState.inventory : [];
  const environment = observedState.environment as Record<string, unknown>;
  const environmentKey = String(environment.environmentKey);
  const nodes = inventory.map((item) => {
    const entry = item as Record<string, unknown>;
    const id = typeof entry.ref === "string" && entry.ref
      ? entry.ref
      : typeof entry.slug === "string" && entry.slug
        ? entry.slug
        : typeof entry.id === "string" && entry.id
          ? entry.id
          : undefined;
    if (!id) {
      throw new CliError("Observed-state fixture inventory entries require ref, slug, or id.", 2, "OBSERVED_STATE_INVALID");
    }
    return {
      nodeId: id,
      ...(entry.kind === "skill" && typeof entry.ref === "string" ? { skillRefId: entry.ref, kind: "leaf" } : {}),
      ...(entry.kind === "router" ? { kind: "router" } : {}),
      ...(typeof entry.slug === "string" && entry.slug ? { slug: entry.slug } : {}),
      ...(typeof entry.version === "string" && entry.version ? { version: entry.version } : {}),
      ...(typeof entry.artifactSha256 === "string" && entry.artifactSha256 ? { digest: entry.artifactSha256 } : {}),
      ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
      ...(typeof entry.exposureMode === "string" ? { runtimeExposure: entry.exposureMode } : {}),
      ...(typeof entry.managed === "boolean" ? { managed: entry.managed } : {}),
      ...(typeof entry.supported === "boolean" ? { supported: entry.supported } : {}),
      ...(typeof entry.configurationDigest === "string" ? { configurationDigest: entry.configurationDigest } : {}),
      ...(typeof entry.configured === "boolean" ? { configured: entry.configured } : {}),
    };
  });
  return { targetId: environmentKey, environmentId: environmentKey, nodes };
}

function teamFromResponse(response: Record<string, unknown>): CliTeamRecord {
  return teamFromRecord(response.team);
}

function invitationFromResponse(response: Record<string, unknown>): CliTeamInvitation {
  return invitationFromRecord(response.invitation);
}

function skillSharingFromResponse(response: Record<string, unknown>): CliSkillSharingDetails {
  const record = recordField(response.sharing, "skill sharing");
  return {
    slug: requiredRecordString(record, "slug", "Skill sharing response is missing slug."),
    title: requiredRecordString(record, "title", "Skill sharing response is missing title."),
    visibility: requiredRecordString(record, "visibility", "Skill sharing response is missing visibility."),
    settings: record.settings && typeof record.settings === "object" && !Array.isArray(record.settings)
      ? sharingSettingsFromRecord(record.settings)
      : null,
    availableTeams: arrayField(record, "availableTeams").map(teamSummaryFromRecord),
    teamGrants: arrayField(record, "teamGrants").map(teamSummaryFromRecord),
    userGrants: arrayField(record, "userGrants").map(userSummaryFromRecord),
    availableOrganizations: arrayField(record, "availableOrganizations").map(organizationSummaryFromRecord),
    organizationGrants: arrayField(record, "organizationGrants").map(organizationSummaryFromRecord),
  };
}

function sharingSettingsFromResponse(response: Record<string, unknown>): CliSharingSettings {
  return sharingSettingsFromRecord(response.sharing);
}

function sharingSettingsFromRecord(input: unknown): CliSharingSettings {
  const record = recordField(input, "sharing settings");
  return {
    publicVisibilityEnabled: requiredRecordBoolean(record, "publicVisibilityEnabled"),
    authenticatedVisibilityEnabled: requiredRecordBoolean(record, "authenticatedVisibilityEnabled"),
    teamsEnabled: requiredRecordBoolean(record, "teamsEnabled"),
    teamVisibilityEnabled: requiredRecordBoolean(record, "teamVisibilityEnabled"),
    userVisibilityEnabled: requiredRecordBoolean(record, "userVisibilityEnabled"),
    ...(optionalRecordBoolean(record, "organizationVisibilityEnabled") === undefined
      ? {}
      : { organizationVisibilityEnabled: optionalRecordBoolean(record, "organizationVisibilityEnabled") }),
  };
}

function teamFromRecord(input: unknown): CliTeamRecord {
  const record = recordField(input, "team");
  return {
    id: requiredRecordString(record, "id", "Team response is missing id."),
    name: requiredRecordString(record, "name", "Team response is missing name."),
    role: optionalRecordString(record, "role") ?? "-",
    members: arrayField(record, "members"),
    invitations: arrayField(record, "invitations").map(invitationFromRecord),
  };
}

function invitationFromRecord(input: unknown): CliTeamInvitation {
  const record = recordField(input, "team invitation");
  return {
    id: requiredRecordString(record, "id", "Team invitation response is missing id."),
    teamId: requiredRecordString(record, "teamId", "Team invitation response is missing teamId."),
    teamName: requiredRecordString(record, "teamName", "Team invitation response is missing teamName."),
    email: requiredRecordString(record, "email", "Team invitation response is missing email."),
    status: requiredRecordString(record, "status", "Team invitation response is missing status."),
  };
}

function teamSummaryFromRecord(input: unknown): CliTeamSummary {
  const record = recordField(input, "team summary");
  return {
    id: requiredRecordString(record, "id", "Team summary response is missing id."),
    name: requiredRecordString(record, "name", "Team summary response is missing name."),
    role: optionalRecordString(record, "role") ?? "-",
  };
}

function userSummaryFromRecord(input: unknown): CliUserSummary {
  const record = recordField(input, "user summary");
  return {
    id: requiredRecordString(record, "id", "User summary response is missing id."),
    email: requiredRecordString(record, "email", "User summary response is missing email."),
    name: optionalRecordString(record, "name") ?? "",
  };
}

function organizationSummaryFromRecord(input: unknown): CliOrganizationSummary {
  const record = recordField(input, "organization summary");
  return {
    id: requiredRecordString(record, "id", "Organization summary response is missing id."),
    name: optionalRecordString(record, "name") ?? "",
    slug: optionalRecordString(record, "slug") ?? "",
    status: optionalRecordString(record, "status") ?? "",
    role: optionalRecordString(record, "role") ?? "",
  };
}

function skillRowFromRecord(input: unknown): CliSkillRow {
  const record = recordField(input, "skill");
  const latestVersion = record.latestVersion;
  return {
    slug: requiredRecordString(record, "slug", "Skill response is missing slug."),
    title: requiredRecordString(record, "title", "Skill response is missing title."),
    latestVersion: typeof latestVersion === "string" ? latestVersion : null,
  };
}

function sharingSettingsOptionUpdates(parsed: ParsedArgs): Partial<CliSharingSettings> {
  const updates: Partial<CliSharingSettings> = {};
  const publicVisibilityEnabled = optionalBooleanOption(parsed, "public") ?? optionalBooleanOption(parsed, "public-visibility");
  const authenticatedVisibilityEnabled = optionalBooleanOption(parsed, "authenticated") ?? optionalBooleanOption(parsed, "authenticated-visibility");
  const teamsEnabled = optionalBooleanOption(parsed, "teams");
  const teamVisibilityEnabled = optionalBooleanOption(parsed, "team-visibility");
  const userVisibilityEnabled = optionalBooleanOption(parsed, "user-visibility");
  const organizationVisibilityEnabled = optionalBooleanOption(parsed, "organization-visibility");
  if (publicVisibilityEnabled !== undefined) {
    updates.publicVisibilityEnabled = publicVisibilityEnabled;
  }
  if (authenticatedVisibilityEnabled !== undefined) {
    updates.authenticatedVisibilityEnabled = authenticatedVisibilityEnabled;
  }
  if (teamsEnabled !== undefined) {
    updates.teamsEnabled = teamsEnabled;
  }
  if (teamVisibilityEnabled !== undefined) {
    updates.teamVisibilityEnabled = teamVisibilityEnabled;
  }
  if (userVisibilityEnabled !== undefined) {
    updates.userVisibilityEnabled = userVisibilityEnabled;
  }
  if (organizationVisibilityEnabled !== undefined) {
    updates.organizationVisibilityEnabled = organizationVisibilityEnabled;
  }
  return updates;
}

function visibilityOption(parsed: ParsedArgs): CliVisibilityScope {
  const value = stringOption(parsed, "visibility");
  if (!CLI_VISIBILITY_SCOPES.includes(value as CliVisibilityScope)) {
    throw new CliError(`--visibility must be one of: ${CLI_VISIBILITY_SCOPES.join(", ")}.`, 2);
  }
  return value as CliVisibilityScope;
}

function optionalBooleanOption(parsed: ParsedArgs, key: string): boolean | undefined {
  const value = optionalStringOption(parsed, key);
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  throw new CliError(`--${key} must be true or false.`, 2);
}

function enabledLabel(value: boolean): string {
  return value ? "enabled" : "disabled";
}

function recordField(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CliError(`API response is missing ${label}.`, 1);
  }
  return input as Record<string, unknown>;
}

function printNamedRecord(response: Record<string, unknown>, key: string, io: CliIo, fields: string[]): void {
  const record = recordField(response[key], key);
  io.stdout(fields.map((field) => optionalRecordString(record, field) ?? "-").join("\t"));
}

function reasonPayload(parsed: ParsedArgs): Record<string, string> {
  const reason = optionalStringOption(parsed, "reason");
  return reason ? { reason } : {};
}

function parseReleaseTarget(target: string): { slug: string; version: string } {
  const separator = target.lastIndexOf("@");
  if (separator <= 0 || separator === target.length - 1) {
    throw new CliError("Release target must be <skill-slug>@<version>.", 2);
  }
  const slug = parseInstallSlug(target.slice(0, separator));
  const version = target.slice(separator + 1);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new CliError("Release version is invalid.", 2);
  }
  return { slug, version };
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function requiredRecordString(record: Record<string, unknown>, key: string, message: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new CliError(message, 1);
  }
  return value;
}

function optionalRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function requiredRecordBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new CliError(`API sharing settings response is missing ${key}.`, 1);
  }
  return value;
}

function optionalRecordBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function installRegistryPath(root: string): string {
  return path.join(root, ".myskills-app", "installed.json");
}

function installTransactionsRoot(root: string): string {
  return path.join(root, ".myskills-app", "transactions");
}

function installTransactionPath(root: string, transactionId: string): string {
  return path.join(installTransactionsRoot(root), `${transactionId}.json`);
}

function installStagePath(root: string, transactionId: string): string {
  return path.join(root, ".myskills-app", "staging", transactionId);
}

function skillInstallPath(root: string, slug: string): string {
  return path.join(root, parseInstallSlug(slug));
}

function historySnapshotPath(root: string, slug: string, version: string, transactionId: string = randomUUID()): string {
  return path.join(root, ".myskills-app", "history", parseInstallSlug(slug), `${transactionId}-${version}`);
}

async function writeInstallTransaction(root: string, transaction: InstallTransaction): Promise<void> {
  assertInstallRootLocked(root);
  await atomicPrivateWrite(
    root,
    installTransactionPath(root, transaction.id),
    `${JSON.stringify(transaction, null, 2)}\n`,
  );
}

async function recoverInstallTransactions(root: string): Promise<void> {
  assertInstallRootLocked(root);
  let entries;
  try {
    await assertRegularDirectory(installTransactionsRoot(root));
    entries = await readdir(installTransactionsRoot(root), { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) return;
  const registry = await readInstallRegistryFile(root);
  for (const filename of files) {
    const journalPath = path.join(installTransactionsRoot(root), filename);
    const transaction = parseInstallTransaction(await readRegularText(journalPath), filename, root);
    const outputRoot = skillInstallPath(root, transaction.slug);
    const stageRoot = installStagePath(root, transaction.id);
    const snapshotPath = transaction.previous && transaction.snapshotCreated
      ? historySnapshotPath(root, transaction.slug, transaction.previous.version, transaction.id)
      : null;
    if (snapshotPath) await ensureSafeDirectory(root, path.dirname(snapshotPath));
    await ensureSafeDirectory(root, path.dirname(stageRoot));
    const installed = registry.installations[transaction.slug];
    const candidateCommitted = Boolean(
      installed
      && installed.version === transaction.targetVersion
      && installed.platform === transaction.targetPlatform
      && installed.artifact.sha256 === transaction.targetArtifact.sha256
      && installed.contentDigest === transaction.targetContentDigest
      && await pathExists(outputRoot)
      && await directoryMatchesDigest(outputRoot, transaction.targetContentDigest),
    );
    if (candidateCommitted) {
      await rm(stageRoot, { recursive: true, force: true });
      if (transaction.operation === "rollback") {
        if (snapshotPath) await rm(snapshotPath, { recursive: true, force: true });
        if (transaction.sourceSnapshotPath) {
          await rm(transaction.sourceSnapshotPath, { recursive: true, force: true });
        }
      }
      await rm(journalPath, { force: true });
      continue;
    }

    const previousAtOutput = Boolean(transaction.previous?.contentDigest
      && await directoryMatchesDigest(outputRoot, transaction.previous.contentDigest));
    if (await pathExists(outputRoot) && !previousAtOutput && !await directoryMatchesDigest(outputRoot, transaction.targetContentDigest)) {
      throw new CliError("Recovery found active files that match neither the previous nor staged package. Preserve the active files and recovery copies for operator recovery.", 1);
    }

    if (snapshotPath && await pathExists(snapshotPath)) {
      if (!transaction.previous?.contentDigest || !await directoryMatchesDigest(snapshotPath, transaction.previous.contentDigest)) {
        throw new CliError("Recovery snapshot does not match its verified bytes. Preserve both copies for operator recovery.", 1);
      }
      if (!previousAtOutput) {
        await rm(outputRoot, { recursive: true, force: true });
        await ensureSafeDirectory(root, path.dirname(outputRoot));
        await rename(snapshotPath, outputRoot);
      }
    } else if (transaction.snapshotCreated) {
      // A previous recovery may have restored the directory before it could
      // persist the registry. Accept only that exact verified previous tree.
      if (!transaction.previous?.contentDigest || !await directoryMatchesDigest(outputRoot, transaction.previous.contentDigest)) {
        throw new CliError(`Install recovery for ${transaction.slug} requires manual intervention; its rollback snapshot is missing.`, 1);
      }
    } else if (!transaction.previous || transaction.state !== "prepared") {
      await rm(outputRoot, { recursive: true, force: true });
    }
    await rm(stageRoot, { recursive: true, force: true });
    if (transaction.previous) {
      registry.installations[transaction.slug] = transaction.previous;
    } else {
      delete registry.installations[transaction.slug];
    }
    // Commit restored metadata before discarding the recovery journal. Repeating
    // recovery after interruption then converges on the same previous bytes.
    await writeInstallRegistry(root, registry);
    if (previousAtOutput && snapshotPath) await rm(snapshotPath, { recursive: true, force: true });
    await rm(journalPath, { force: true });
  }
}

function parseInstallTransaction(raw: string, filename: string, root: string): InstallTransaction {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new CliError("Install transaction journal is invalid.", 1);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CliError("Install transaction journal is invalid.", 1);
  }
  const record = input as Record<string, unknown>;
  const id = filename.slice(0, -5);
  const states: InstallFaultPoint[] = ["prepared", "previous-staged", "installed", "registry-committed"];
  if (
    record.version !== 1
    || record.id !== id
    || (record.operation !== "install" && record.operation !== "update" && record.operation !== "rollback")
    || typeof record.state !== "string"
    || !states.includes(record.state as InstallFaultPoint)
    || typeof record.slug !== "string"
    || typeof record.targetVersion !== "string"
    || !parseSemanticVersion(record.targetVersion)
    || typeof record.targetPlatform !== "string"
    || typeof record.targetContentDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(record.targetContentDigest)
    || typeof record.snapshotCreated !== "boolean"
  ) {
    throw new CliError("Install transaction journal is invalid.", 1);
  }
  const slug = parseInstallSlug(record.slug);
  const targetArtifact = parseStoredArtifact(record.targetArtifact);
  if (!/^[a-f0-9]{64}$/.test(targetArtifact.sha256) || !Number.isSafeInteger(targetArtifact.byteSize)) {
    throw new CliError("Install transaction journal has invalid artifact metadata.", 1);
  }
  const previous = record.previous === null ? null : parseInstalledSkillRecord(slug, record.previous, root);
  if (record.previous !== null && !previous) {
    throw new CliError("Install transaction journal has invalid previous state.", 1);
  }
  let sourceSnapshotPath: string | undefined;
  if (record.operation === "rollback") {
    if (typeof record.sourceSnapshotPath !== "string") {
      throw new CliError("Install rollback transaction is missing its source snapshot.", 1);
    }
    sourceSnapshotPath = path.resolve(record.sourceSnapshotPath);
    assertChildPath(path.join(root, ".myskills-app", "history"), sourceSnapshotPath);
  } else if (record.sourceSnapshotPath !== undefined) {
    throw new CliError("Install transaction journal is invalid.", 1);
  }
  return {
    version: 1,
    id,
    operation: record.operation,
    state: record.state as InstallFaultPoint,
    slug,
    targetVersion: record.targetVersion,
    targetPlatform: record.targetPlatform,
    targetArtifact,
    targetContentDigest: record.targetContentDigest,
    previous,
    snapshotCreated: record.snapshotCreated,
    ...(sourceSnapshotPath ? { sourceSnapshotPath } : {}),
  };
}

function contentDigestForFiles(files: Array<{ path: string; content: string }>): string {
  const normalized = files
    .map((file) => ({ path: safeBundlePath(file.path), content: file.content }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function directoryMatchesDigest(root: string, expected: string): Promise<boolean> {
  try {
    return await directoryContentDigest(root) === expected;
  } catch {
    return false;
  }
}

async function directoryContentDigest(root: string): Promise<string> {
  return contentDigestForFiles((await readPackageSnapshot(root)).files);
}

async function assertInstalledBytes(existing: InstalledSkillRecord): Promise<void> {
  if (!existing.contentDigest || !await directoryMatchesDigest(existing.path, existing.contentDigest)) {
    throw new CliError("Installed skill has local drift or no verified byte identity. Its files were not replaced.", 1, "INSTALL_LOCAL_DRIFT");
  }
}

function parseInstallSlug(slug: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new CliError("Skill slug is invalid.", 2);
  }
  return slug;
}

function parseArchitectureId(value: string | undefined): string {
  if (!value || value.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new CliError("Architecture id is invalid.", 2);
  }
  return value;
}

function parseArchitectureReference(value: string, label: string): string {
  if (value.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new CliError(`${label} id is invalid.`, 2);
  }
  return value;
}

function parseArchitectureRevisionId(value: string): string {
  if (value.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new CliError("Architecture revision id is invalid.", 2);
  }
  return value;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertChildPath(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CliError("Install registry contains an unsafe path.", 1);
  }
}

async function apiGet(pathname: string, parsed: ParsedArgs, runtime: CliRuntime, token?: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return await apiJsonRequest(pathname, parsed, runtime, { headers });
}

async function apiGetWithHeaders(pathname: string, parsed: ParsedArgs, runtime: CliRuntime, token?: string): Promise<{ headers: Record<string, string>; text: string }> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await apiFetch(pathname, parsed, runtime, { headers });
  if (!response.ok) {
    const body = parseJsonResponse(pathname, apiBaseUrl(parsed, runtime), response.text);
    throw apiErrorFromBody(pathname, apiBaseUrl(parsed, runtime), response.status, body, response.text);
  }
  return {
    headers: response.headers,
    text: response.text,
  };
}

async function apiGetText(pathname: string, parsed: ParsedArgs, runtime: CliRuntime, token?: string): Promise<string> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await apiFetch(pathname, parsed, runtime, { headers });
  if (!response.ok) {
    throw apiErrorFromResponse(pathname, apiBaseUrl(parsed, runtime), response.status, response.text);
  }
  return response.text;
}

async function apiPost(pathname: string, payload: unknown, parsed: ParsedArgs, runtime: CliRuntime, token?: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return await apiJsonRequest(pathname, parsed, runtime, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

async function apiPut(pathname: string, payload: unknown, parsed: ParsedArgs, runtime: CliRuntime, token?: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return await apiJsonRequest(pathname, parsed, runtime, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload),
  });
}

async function apiDelete(pathname: string, parsed: ParsedArgs, runtime: CliRuntime, token: string): Promise<Record<string, unknown>> {
  return await apiJsonRequest(pathname, parsed, runtime, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
}

async function apiJsonRequest(
  pathname: string,
  parsed: ParsedArgs,
  runtime: CliRuntime,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Record<string, unknown>> {
  const baseUrl = apiBaseUrl(parsed, runtime);
  const response = await apiFetch(pathname, parsed, runtime, init);
  const body = parseJsonResponse(pathname, baseUrl, response.text);
  if (!response.ok) {
    throw apiErrorFromBody(pathname, baseUrl, response.status, body, response.text);
  }
  return body;
}

async function apiFetch(
  pathname: string,
  parsed: ParsedArgs,
  runtime: CliRuntime,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ headers: Record<string, string>; ok: boolean; status: number; text: string }> {
  const baseUrl = apiBaseUrl(parsed, runtime);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await runtime.fetch(`${baseUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new CliError([
      "Could not reach the MySkills API.",
      "",
      `API URL: ${safeApiUrlForDisplay(baseUrl)}`,
      "Check that the API is running, or use:",
      "  myskills <command> --api-url https://myskills.sh/api",
    ].join("\n"), 1, "API_UNREACHABLE");
  }
  return {
    headers: responseHeaders(response.headers),
    ok: response.ok,
    status: response.status,
    text: await response.text(),
  };
}

function responseHeaders(input: Headers | Record<string, string> | undefined): Record<string, string> {
  if (!input) {
    return {};
  }
  if (input instanceof Headers) {
    return Object.fromEntries([...input.entries()].map(([key, value]) => [key.toLowerCase(), value]));
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key.toLowerCase(), value]));
}

function parseJsonResponse(pathname: string, baseUrl: string, text: string): Record<string, unknown> {
  if (!text) {
    return {};
  }
  if (/^\s*</.test(text)) {
    throw htmlApiError(baseUrl);
  }
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("not object");
    }
    return body as Record<string, unknown>;
  } catch {
    throw new CliError(`API response for ${pathname} was not valid JSON.`, 1, "API_INVALID_JSON");
  }
}

function apiErrorFromBody(pathname: string, baseUrl: string, status: number, body: Record<string, unknown>, text: string): CliError {
  if (status === 404 && isUnsupportedEndpointBody(body, text)) {
    const command = unsupportedCommandForPath(pathname);
    if (command) {
      return new CliError([
        `This MySkills server does not support the \`${command}\` command yet.`,
        "",
        `CLI version: ${CLI_VERSION}`,
        `API URL: ${safeApiUrlForDisplay(baseUrl)}`,
        "Run `myskills doctor` to inspect server capabilities.",
      ].join("\n"), 1, "API_UNSUPPORTED_ENDPOINT", status);
    }
  }
  const error = jsonRecord(body.error);
  const message = typeof error?.message === "string" ? error.message : undefined;
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.code)
    ? error.code
    : "API_REQUEST_FAILED";
  return new CliError(safeApiErrorMessage(pathname, message, status), 1, code, status);
}

function apiErrorFromResponse(pathname: string, baseUrl: string, status: number, text: string): CliError {
  if (/^\s*</.test(text)) {
    return htmlApiError(baseUrl);
  }
  try {
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    return apiErrorFromBody(pathname, baseUrl, status, body, text);
  } catch {
    return new CliError(`API request failed with ${status}.`, 1, "API_REQUEST_FAILED", status);
  }
}

function htmlApiError(baseUrl: string): CliError {
  return new CliError([
    "The API URL returned HTML instead of JSON.",
    "You may be pointing the CLI at the web app.",
    "",
    `Current API URL: ${safeApiUrlForDisplay(baseUrl)}`,
    "Try: myskills <command> --api-url https://myskills.sh/api",
  ].join("\n"), 1, "API_RETURNED_HTML");
}

function safeApiErrorMessage(pathname: string, message: string | undefined, status: number): string {
  const fallback = `API request failed with ${status}.`;
  if (!message || !message.trim()) return fallback;
  const sanitized = terminalSafeText(message.trim());
  if (isArchitectureApiPath(pathname) && API_ERROR_SENSITIVE_PATTERN.test(sanitized)) {
    return "The architecture request could not be completed.";
  }
  return sanitized;
}

function safeApiUrlForDisplay(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "[redacted API URL]";
  }
}

const API_ERROR_SENSITIVE_PATTERN = /\b(?:bearer|secret|token|password|credential|private(?:[-_ ]?key|[-_ ]?path)?|storage(?:key)?|package|content|prompt|endpoint|url)\b|https?:\/\/|(?:^|[\s"'`])(?:\/(?:Users|private|tmp|var|etc)\b|[A-Za-z]:[\\/])/i;

function isArchitectureApiPath(pathname: string): boolean {
  return pathname.startsWith("/v1/architecture") || pathname.startsWith("/v1/architectures");
}

function isUnsupportedEndpointBody(body: Record<string, unknown>, text: string): boolean {
  return typeof body.message === "string" && /Route .+ not found/.test(body.message)
    || typeof body.error === "string" && body.error === "Not Found"
    || /Route .+ not found/.test(text);
}

function unsupportedCommandForPath(pathname: string): string | null {
  if (pathname.startsWith("/v1/teams")) {
    return "teams";
  }
  if (pathname.startsWith("/v1/architecture") || pathname.startsWith("/v1/architectures") || pathname.startsWith("/v1/sync-runs")) {
    return "architectures";
  }
  if (pathname.includes("/sharing") || pathname.startsWith("/v1/admin/sharing")) {
    return "sharing";
  }
  return null;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  details?: object;
}

function nodeVersionCheck(): DoctorCheck {
  const version = process.versions.node;
  const major = Number.parseInt(version.split(".")[0] ?? "0", 10);
  return {
    name: "node",
    ok: major >= 20,
    message: `v${version} (${major >= 20 ? "satisfies >=20" : "requires >=20"})`,
    details: { version, engine: ">=20" },
  };
}

async function doctorHealthCheck(parsed: ParsedArgs, runtime: CliRuntime): Promise<DoctorCheck> {
  const baseUrl = apiBaseUrl(parsed, runtime);
  try {
    const response = await apiFetch("/health", parsed, runtime);
    const body = parseJsonResponse("/health", baseUrl, response.text);
    return {
      name: "api_health",
      ok: response.ok,
      message: response.ok ? "ok" : `HTTP ${response.status}`,
      details: { status: response.status, body },
    };
  } catch (error) {
    return {
      name: "api_health",
      ok: false,
      message: error instanceof Error ? firstLine(error.message) : "failed",
    };
  }
}

async function doctorAuthCheck(parsed: ParsedArgs, runtime: CliRuntime, resolved: ResolvedToken | null): Promise<DoctorCheck> {
  if (!resolved) {
    return {
      name: "auth",
      ok: true,
      message: "not logged in",
      details: { status: "not_logged_in" },
    };
  }
  try {
    const response = await apiGet("/v1/me", parsed, runtime, resolved.value);
    const user = response.user as { email?: string; roles?: string[]; mfaVerified?: boolean };
    return {
      name: "auth",
      ok: true,
      message: `${user.email ?? "unknown"} (${resolved.stored.kind}, ${resolved.source})`,
      details: {
        status: "logged_in",
        tokenSource: resolved.source,
        tokenKind: resolved.stored.kind,
        expiresAt: resolved.stored.expiresAt ?? null,
        user,
      },
    };
  } catch (error) {
    return {
      name: "auth",
      ok: false,
      message: error instanceof Error ? firstLine(error.message) : "failed",
    };
  }
}

async function doctorTokenStoreCheck(runtime: CliRuntime): Promise<DoctorCheck> {
  const info = await tokenStoreInfo(runtime);
  if (info.backend === "file" && info.filePath) {
    const permissions = await filePermissions(info.filePath);
    if (permissions && permissions !== "600") {
      return {
        name: "token_store",
        ok: false,
        message: `file permissions ${permissions}; expected 600`,
        details: { ...info, permissions },
      };
    }
    return {
      name: "token_store",
      ok: true,
      message: permissions ? `file ${info.filePath} (${permissions})` : `file ${info.filePath} (not created)`,
      details: { ...info, permissions },
    };
  }
  return {
    name: "token_store",
    ok: true,
    message: info.backend,
    details: info,
  };
}

async function doctorInstallDirCheck(parsed: ParsedArgs, runtime: CliRuntime): Promise<DoctorCheck> {
  const root = installRoot(parsed, runtime);
  const testFile = path.join(root, ".myskills-app", `doctor-write-test-${randomUUID()}`);
  try {
    assertInstallRootLocked(root);
    await atomicPrivateWrite(root, testFile, "ok\n");
    await rm(testFile, { force: true });
    return {
      name: "install_dir",
      ok: true,
      message: `writable ${root}`,
      details: { path: root },
    };
  } catch (error) {
    return {
      name: "install_dir",
      ok: false,
      message: error instanceof Error ? firstLine(error.message) : "not writable",
      details: { path: root },
    };
  }
}

async function doctorCapabilitiesCheck(parsed: ParsedArgs, runtime: CliRuntime): Promise<DoctorCheck> {
  try {
    const response = await apiGet("/v1/capabilities", parsed, runtime);
    const capabilities = response.capabilities && typeof response.capabilities === "object" && !Array.isArray(response.capabilities)
      ? response.capabilities as Record<string, unknown>
      : {};
    const supported = Object.entries(capabilities)
      .filter(([, value]) => value === true)
      .map(([key]) => key);
    const unsupported = Object.entries(capabilities)
      .filter(([, value]) => value === false)
      .map(([key]) => key);
    return {
      name: "capabilities",
      ok: true,
      message: `supported=${supported.join(",") || "-"} unsupported=${unsupported.join(",") || "-"}`,
      details: response,
    };
  } catch (error) {
    return {
      name: "capabilities",
      ok: true,
      message: `unknown (${error instanceof Error ? firstLine(error.message) : "not available"})`,
    };
  }
}

async function tokenStoreInfo(runtime: CliRuntime): Promise<CliTokenStoreInfo> {
  return await runtime.tokenStore?.describe?.() ?? { backend: "memory" };
}

async function filePermissions(filePath: string): Promise<string | null> {
  try {
    return ((await stat(filePath)).mode & 0o777).toString(8).padStart(3, "0");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

function printScanResult(result: PackageScanResult, io: CliIo): void {
  if (result.findings.length === 0) {
    io.stdout(`clean files=${result.filesScanned} bytes=${result.bytesScanned}`);
    return;
  }
  for (const finding of result.findings) {
    io.stdout(`${finding.severity}\t${finding.category}\t${finding.path ?? "-"}\t${finding.message}`);
  }
}

function requiredPath(parsed: ParsedArgs): string {
  const value = parsed.options.path ?? parsed.args[0];
  if (typeof value !== "string" || !value) {
    throw new CliError("A package path is required. Pass --path <file-directory-or-zip>.", 2);
  }
  return value;
}

type ApiUrlSource = "option" | "env" | "config" | "default";

function apiBaseUrlResolution(parsed: ParsedArgs, runtime: CliRuntime): { url: string; source: ApiUrlSource } {
  const optionValue = optionalStringOption(parsed, "api-url");
  if (optionValue) {
    return { url: normalizeApiUrlOption(optionValue), source: "option" };
  }
  if (runtime.env.MYSKILLS_API_URL) {
    return { url: normalizeApiUrlOption(runtime.env.MYSKILLS_API_URL), source: "env" };
  }
  const configuredApiUrl = runtime.configStore?.getApiUrl();
  if (configuredApiUrl) {
    return { url: normalizeApiUrlOption(configuredApiUrl), source: "config" };
  }
  return { url: DEFAULT_API_URL, source: "default" };
}

function apiBaseUrl(parsed: ParsedArgs, runtime: CliRuntime): string {
  return apiBaseUrlResolution(parsed, runtime).url;
}

interface ResolvedToken {
  value: string;
  source: "option" | "env" | "store";
  stored: StoredCliToken;
}

async function tokenOption(parsed: ParsedArgs, runtime: CliRuntime): Promise<string | null> {
  return (await resolveToken(parsed, runtime))?.value ?? null;
}

async function requireToken(parsed: ParsedArgs, runtime: CliRuntime): Promise<string> {
  const token = await tokenOption(parsed, runtime);
  if (!token) {
    throw new CliError("No token provided. Run myskills login, set MYSKILLS_TOKEN, or pass --token.", 1);
  }
  return token;
}

async function resolveToken(parsed: ParsedArgs, runtime: CliRuntime): Promise<ResolvedToken | null> {
  const token = parsed.options.token;
  if (typeof token === "string" && token) {
    return {
      value: token,
      source: "option",
      stored: { kind: "session", token },
    };
  }
  if (runtime.env.MYSKILLS_TOKEN) {
    return {
      value: runtime.env.MYSKILLS_TOKEN,
      source: "env",
      stored: { kind: "session", token: runtime.env.MYSKILLS_TOKEN },
    };
  }
  const stored = await runtime.tokenStore?.get(apiBaseUrl(parsed, runtime));
  if (!stored?.token) {
    return null;
  }
  return {
    value: stored.token,
    source: "store",
    stored,
  };
}

async function promptText(runtime: CliRuntime, label: string): Promise<string> {
  if (!runtime.prompt) {
    throw new CliError("Interactive input is unavailable. Set MYSKILLS_TOKEN for one-off commands.", 1);
  }
  const value = (await runtime.prompt.text(label)).trim();
  if (!value) {
    throw new CliError(`${label.replace(/:\s*$/, "")} is required.`, 2);
  }
  return value;
}

async function promptSecret(runtime: CliRuntime, label: string): Promise<string> {
  if (!runtime.prompt) {
    throw new CliError("Interactive input is unavailable. Set MYSKILLS_TOKEN for one-off commands.", 1);
  }
  const value = await runtime.prompt.secret(label);
  if (!value) {
    throw new CliError(`${label.replace(/:\s*$/, "")} is required.`, 2);
  }
  return value;
}

async function promptOptionalText(runtime: CliRuntime, label: string): Promise<string> {
  if (!runtime.prompt) {
    throw new CliError("Interactive input is unavailable. Set MYSKILLS_TOKEN for one-off commands.", 1);
  }
  return (await runtime.prompt.text(label)).trim();
}

type LoginAuthMethod = (typeof LOGIN_AUTH_METHODS)[number];

async function loginApiUrl(parsed: ParsedArgs, runtime: CliRuntime): Promise<string> {
  const resolved = apiBaseUrlResolution(parsed, runtime);
  if (resolved.source === "option" || resolved.source === "env" || !runtime.prompt) {
    return resolved.url;
  }
  const defaultUrl = resolved.source === "config" ? resolved.url : DEFAULT_API_URL;
  const input = await promptOptionalText(runtime, `API URL [${defaultUrl}]: `);
  return input ? normalizeApiUrlOption(input) : defaultUrl;
}

async function loginAuthMethod(parsed: ParsedArgs, runtime: CliRuntime): Promise<LoginAuthMethod> {
  if (parsed.options["api-key"] === true) {
    return "api-key";
  }
  const methodOption = optionalStringOption(parsed, "auth-method") ?? optionalStringOption(parsed, "method");
  if (methodOption) {
    return parseLoginAuthMethod(methodOption);
  }
  if (optionalStringOption(parsed, "email") || !runtime.prompt) {
    return "password";
  }
  const input = await promptOptionalText(runtime, "Authentication method [password] (password/api-key): ");
  return input ? parseLoginAuthMethod(input) : "password";
}

function parseLoginAuthMethod(input: string): LoginAuthMethod {
  const normalized = input.trim().toLowerCase();
  if (normalized === "password" || normalized === "email" || normalized === "user" || normalized === "username") {
    return "password";
  }
  if (normalized === "api-key" || normalized === "apikey" || normalized === "api" || normalized === "key") {
    return "api-key";
  }
  if (normalized === "browser" || normalized === "web") {
    throw new CliError("Browser login is not available in this CLI/API version yet. Choose password or api-key.", 2);
  }
  throw new CliError(`Authentication method must be one of: ${LOGIN_AUTH_METHODS.join(", ")}.`, 2);
}

function normalizeApiUrlOption(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("embedded credentials and query parameters are not supported");
    }
    return trimmed;
  } catch {
    throw new CliError("API URL must be a valid http:// or https:// URL.", 2);
  }
}

interface AuthSession {
  token: string;
  expiresAt: string;
  email?: string;
}

function authSessionFromResponse(response: Record<string, unknown>): AuthSession {
  const user = response.user;
  let email: string | undefined;
  if (user && typeof user === "object" && !Array.isArray(user)) {
    const userEmail = (user as Record<string, unknown>).email;
    email = typeof userEmail === "string" ? userEmail : undefined;
  }
  return {
    token: stringFromRecord(response, "token", "API login response is missing session token."),
    expiresAt: stringFromRecord(response, "expiresAt", "API login response is missing session expiry."),
    email,
  };
}

function stringFromRecord(record: Record<string, unknown>, key: string, message: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new CliError(message, 1);
  }
  return value;
}

function stringOption(parsed: ParsedArgs, key: string): string {
  const value = parsed.options[key];
  if (typeof value !== "string" || !value) {
    throw new CliError(`--${key} is required.`, 2);
  }
  return value;
}

function optionalStringOption(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.options[key];
  return typeof value === "string" && value ? value : undefined;
}

function isArtifactSha256(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function stringListOption(parsed: ParsedArgs, key: string): string[] {
  const value = parsed.options[key];
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => item.split(",").map((scope) => scope.trim()).filter(Boolean));
  }
  return [];
}

function releaseArtifact(response: Record<string, unknown>): { sha256: string; byteSize: number } {
  const release = response.release;
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new CliError("API release response is missing release metadata.", 1);
  }
  const artifact = (release as { artifact?: unknown }).artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new CliError("API release response is missing artifact metadata.", 1);
  }
  const record = artifact as Record<string, unknown>;
  if (typeof record.sha256 !== "string" || typeof record.byteSize !== "number") {
    throw new CliError("API release response has invalid artifact metadata.", 1);
  }
  return {
    sha256: record.sha256,
    byteSize: record.byteSize,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseBundlePayload(text: string): Array<{ path: string; content: string }> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CliError("Bundle response is not valid JSON.", 1);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CliError("Bundle response must be an object.", 1);
  }
  const files = (body as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    throw new CliError("Bundle response is missing files.", 1);
  }
  return files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new CliError("Bundle file entries must be objects.", 1);
    }
    const record = file as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.content !== "string") {
      throw new CliError("Bundle file entries require path and content.", 1);
    }
    return {
      path: record.path,
      content: record.content,
    };
  });
}

function safeBundlePath(inputPath: string): string {
  try {
    return normalizePackageFilePath(inputPath);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : "Invalid bundle path.", 1);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const args: string[] = [];
  const options: ParsedArgs["options"] = {};

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) {
      args.push(value);
      continue;
    }
    const key = value.slice(2);
    if (
      key === "json"
      || key === "api-key"
      || key === "health"
      || key === "clear-organizations"
      || key === "dry-run"
      || key === "upload"
      || key === "include-prerelease"
      || key === "requires-user-action"
      || key === "accept-user-action"
    ) {
      options[key] = true;
      continue;
    }
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      throw new CliError(`Option --${key} requires a value.`, 2);
    }
    const existing = options[key];
    if (typeof existing === "string") {
      options[key] = [existing, next];
    } else if (Array.isArray(existing)) {
      existing.push(next);
    } else {
      options[key] = next;
    }
    index += 1;
  }

  return { command, args, options };
}

function helpText(): string {
  return [
    "myskills <command>",
    "",
    "Commands:",
    "  version",
    "  validate --path <file-directory-or-zip>",
    "  scan --path <file-directory-or-zip>",
    "  search [query] [--api-url <url>]",
    "  info <skill-slug> [--api-url <url>]",
    "  login [--api-url <url>] [--method <password|api-key>] [--email <email>]",
    "  login --api-key [--api-url <url>]",
    "  logout [--api-url <url>] [--token <token>]",
    "  whoami [--api-url <url>] [--token <token>]",
    "  auth status [--api-url <url>] [--token <token>]",
    "  doctor [--api-url <url>] [--json]",
    "  config get api-url",
    "  config set api-url <url>",
    "  config reset api-url",
    "  config list",
    "  submit --path <file-directory-or-zip> [--release-notes-file <file>] [--change-kind <fix|feature|breaking|security|maintenance>] [--requires-user-action] [--minimum-myskills-version <version>] [--minimum-adapter-contract-version <number>] [--minimum-source-version <version>] [--api-url <url>] [--token <token>]",
    "  review submissions [--api-url <url>] [--token <token>]",
    "  review bundle <submission-id> [--platform <name>] [--output <file>] [--api-url <url>] [--token <token>]",
    "  review action <submission-id> --action <approve|request-changes|reject|publish> [--artifact-sha256 <hash>] [--reason <text>] [--api-url <url>] [--token <token>]",
    "  submissions list [--api-url <url>] [--token <token>]",
    "  submissions withdraw <submission-id> [--reason <text>] [--api-url <url>] [--token <token>]",
    "  skills edit <skill-slug> [--title <text>] [--summary <text>] [--tag <tag>] [--visibility <scope>] [--reason <text>] [--api-url <url>] [--token <token>] (deprecated visibility alias; use sharing set)",
    "  skills archive|restore|delete <skill-slug> [--reason <text>] [--api-url <url>] [--token <token>]",
    "  releases list <skill-slug> [--api-url <url>] [--token <token>]",
    "  releases deprecate|unpublish|revoke|restore|delete <skill-slug>@<version> [--reason <text>] [--replacement <version>] [--api-url <url>] [--token <token>]",
    "  teams list|skills [--api-url <url>] [--token <token>]",
    "  teams create <team-name> [--name <team-name>] [--api-url <url>] [--token <token>]",
    "  teams invite <team-id> --email <email> [--api-url <url>] [--token <token>]",
    "  teams accept <invitation-id> [--api-url <url>] [--token <token>]",
    "  sharing get <skill-slug> [--api-url <url>] [--token <token>]",
    "  sharing set <skill-slug> --visibility <scope> [--team <team-id>] [--user <email>] [--organization <organization-id>] [--organization-id <organization-id>] [--clear-organizations]",
    "  architectures patterns [--api-url <url>] [--token <token>]",
    "  architectures list [--api-url <url>] [--token <token>]",
    "  architectures show <architecture-id> [--revision <revision-id>] [--api-url <url>] [--token <token>]",
    "  architectures preview|compile <architecture-id> [--revision <revision-id>] [--profile <profile-id>] [--environment <environment-id>] [--organization-id <organization-id>|--organization <organization-id>] [--api-url <url>] [--token <token>]",
    "  architectures plan|dry-run <architecture-id> --observed <fixture.json> [--revision <revision-id>] [--profile <profile-id>] [--environment <environment-id>] [--organization-id <organization-id>|--organization <organization-id>] [--api-url <url>] [--token <token>]",
    "  architectures observe --root <absolute-dir> --profile <personal|work|shared> (--context <file> | --target-id <id> --generation <number> --architecture-id <id> --environment-id <id> --profile-id <id> --adapter-digest <sha256> --capabilities-digest <sha256>) [--json]",
    "  architectures health --root <absolute-dir> --profile <personal|work|shared> (--context <file> | --target-id <id> --generation <number> --architecture-id <id> --environment-id <id> --profile-id <id> --adapter-digest <sha256> --capabilities-digest <sha256>) [--json]",
    "  admin sharing get [--api-url <url>] [--token <token>]",
    "  admin sharing set [--public <true|false>] [--authenticated <true|false>] [--teams <true|false>] [--team-visibility <true|false>] [--user-visibility <true|false>] [--organization-visibility <true|false>]",
    "  export <skill-slug> --version <version> --platform <platform> --output <dir>",
    "  install <skill-slug> [--version <version>] [--platform <platform>] [--dir <install-root>]",
    "  list [--dir <install-root>]",
    "  updates [skill-slug] [--include-prerelease] [--dir <install-root>] [--json]",
    "  update [skill-slug] [--version <version>] [--platform <platform>] [--include-prerelease] [--dry-run] [--accept-user-action] [--dir <install-root>]",
    "  rollback <skill-slug> [--dir <install-root>]",
    "  companion run-once --workspace <absolute-dir> --holder <id> [--api-url <url>] [--token <targets:execute-token>]",
    "  codex enroll --workspace <absolute-dir> --architecture-id <id> --environment-id <id> --profile-id <id> [--name <name>] [--api-url <url>]",
    "  codex observe --workspace <absolute-dir> [--upload] [--api-url <url>]",
    "  token create --name <name> --scope <scope> [--scope <scope>]",
    "  token list",
    "  token revoke <token-id>",
    "",
    "Options:",
    "  --version           Print CLI version.",
    "  --json              Print machine-readable JSON.",
    "  --api-url <url>     API base URL. Defaults to MYSKILLS_API_URL, saved config, or http://localhost:3001.",
    "  --token <token>     Bearer token. Defaults to MYSKILLS_TOKEN, then stored login token.",
  ].join("\n");
}

class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly code = "CLI_ERROR",
    public readonly status?: number,
  ) {
    super(message);
  }

  toJSON(): { code: string; message: string; status?: number } {
    return {
      code: this.code,
      message: this.message,
      ...(this.status !== undefined ? { status: this.status } : {}),
    };
  }
}
