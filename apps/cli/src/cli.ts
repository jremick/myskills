import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  hasBlockingFindings,
  loadSkillManifestFromPath,
  normalizePackageFilePath,
  readPackageFilesFromPath,
  scanPackagePath,
  type PackageScanResult,
} from "@myskills-app/skill-package";

const DEFAULT_API_URL = "http://localhost:3001";
const CLI_VERSION = process.env.MYSKILLS_CLI_VERSION ?? "0.0.0-dev";
const CLI_VISIBILITY_SCOPES = ["public", "authenticated", "organization", "team", "private", "explicit-users"] as const;
const LOGIN_AUTH_METHODS = ["password", "api-key"] as const;

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
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
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
}

interface ParsedArgs {
  command: string;
  args: string[];
  options: Record<string, string | boolean | string[]>;
}

export async function runCli(argv: string[], runtime: CliRuntime): Promise<number> {
  const parsed = parseArgs(argv);
  try {
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
      case "rollback":
        return await rollbackCommand(parsed, runtime);
      case "token":
        return await tokenCommand(parsed, runtime);
      default:
        throw new CliError(`Unknown command: ${parsed.command}`, 2);
    }
  } catch (error) {
    if (error instanceof CliError) {
      if (parsed.options.json) {
        runtime.io.stderr(JSON.stringify({ error: error.toJSON() }, null, 2));
      } else {
        runtime.io.stderr(error.message);
      }
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : "Unexpected CLI failure.";
    if (parsed.options.json) {
      runtime.io.stderr(JSON.stringify({ error: { code: "UNEXPECTED_CLI_FAILURE", message } }, null, 2));
    } else {
      runtime.io.stderr(message);
    }
    return 1;
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
  const resolved = await resolveToken(parsed, runtime);
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
      throw new CliError("Usage: myskills review action <submission-id> --action <approve|request-changes|reject|publish> [--reason <text>] [--api-url <url>] [--token <token>]", 2);
    }
    const action = stringOption(parsed, "action");
    if (action !== "approve" && action !== "request-changes" && action !== "reject" && action !== "publish") {
      throw new CliError("--action must be approve, request-changes, reject, or publish.", 2);
    }
    const reason = optionalStringOption(parsed, "reason");
    const response = await apiPost(`/v1/review/submissions/${encodeURIComponent(submissionId)}/actions`, {
      action,
      ...(reason ? { reason } : {}),
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
  throw new CliError("Usage: myskills review submissions | review action <submission-id> --action <approve|request-changes|reject|publish> [--reason <text>]", 2);
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
  const token = await requireToken(parsed, runtime);
  const subcommand = parsed.args[0];
  const slug = parsed.args[1];
  if (subcommand === "edit") {
    if (!slug) {
      throw new CliError("Usage: myskills skills edit <skill-slug> [--title <text>] [--summary <text>] [--visibility <scope>] [--tag <tag>] [--reason <text>] [--api-url <url>] [--token <token>]", 2);
    }
    const payload: Record<string, unknown> = {
      ...reasonPayload(parsed),
    };
    const title = optionalStringOption(parsed, "title");
    const summary = optionalStringOption(parsed, "summary");
    const visibility = optionalStringOption(parsed, "visibility");
    const tags = stringListOption(parsed, "tag");
    if (title !== undefined) {
      payload.title = title;
    }
    if (summary !== undefined) {
      payload.summary = summary;
    }
    if (visibility !== undefined) {
      if (!CLI_VISIBILITY_SCOPES.includes(visibility as CliVisibilityScope)) {
        throw new CliError(`--visibility must be one of: ${CLI_VISIBILITY_SCOPES.join(", ")}.`, 2);
      }
      payload.visibility = visibility;
    }
    if (tags.length > 0) {
      payload.tags = tags;
    }
    if (Object.keys(payload).every((key) => key === "reason")) {
      throw new CliError("At least one metadata option is required.", 2);
    }
    const response = await apiPut(`/v1/skills/${encodeURIComponent(parseInstallSlug(slug))}`, payload, parsed, runtime, token);
    printNamedRecord(response, "skill", runtime.io, ["slug", "title", "lifecycleStatus", "visibility"]);
    return 0;
  }
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
      throw new CliError("Usage: myskills sharing set <skill-slug> --visibility <scope> [--team <team-id>] [--user <email>]", 2);
    }
    const visibility = visibilityOption(parsed);
    const response = await apiPut(`/v1/skills/${encodeURIComponent(parseInstallSlug(slug))}/sharing`, {
      visibility,
      teamIds: stringListOption(parsed, "team"),
      userEmails: stringListOption(parsed, "user"),
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
  const manifest = await loadSkillManifestFromPath(packagePath);
  const scan = await scanPackagePath(packagePath);
  if (hasBlockingFindings(scan.findings)) {
    printScanResult(scan, runtime.io);
    throw new CliError("Package has blocking scan findings; submission was not sent.", 1);
  }
  const response = await apiPost("/v1/submissions", await submissionPayload(packagePath, manifest), parsed, runtime, token);
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

async function submissionPayload(packagePath: string, manifest: unknown): Promise<Record<string, unknown>> {
  if (path.extname(packagePath).toLowerCase() === ".zip") {
    return {
      manifest,
      archive: {
        filename: path.basename(packagePath),
        contentBase64: (await readFile(packagePath)).toString("base64"),
      },
    };
  }
  return {
    manifest,
    files: await readPackageFilesFromPath(packagePath),
  };
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
  const writes = await writeBundleFiles(bundle.files, outputRoot, { clean: false });
  runtime.io.stdout(`${slug}@${version}\texported\tfiles=${writes.length}\t${outputRoot}`);
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
  const version = optionalStringOption(parsed, "version") ?? await latestVersionForSkill(slug, parsed, runtime, token);
  const installed = await installSkillVersion({
    slug,
    version,
    platform: optionalStringOption(parsed, "platform"),
    root,
    registry,
    parsed,
    runtime,
    token,
  });
  await writeInstallRegistry(root, registry);
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

  for (const slug of targets) {
    const existing = registry.installations[slug];
    if (!existing) {
      throw new CliError(`${slug} is not installed. Run myskills install ${slug}.`, 1);
    }
    const version = explicitVersion ?? await latestVersionForSkill(slug, parsed, runtime, token);
    const platform = explicitPlatform ?? existing.platform;
    if (version === existing.version && platform === existing.platform) {
      runtime.io.stdout(`${slug}@${existing.version}\tcurrent\tplatform=${existing.platform}`);
      continue;
    }
    const updated = await installSkillVersion({
      slug,
      version,
      platform,
      root,
      registry,
      parsed,
      runtime,
      token,
    });
    runtime.io.stdout(`${updated.slug}@${updated.version}\tupdated\tplatform=${updated.platform}\tprevious=${existing.version}`);
  }
  await writeInstallRegistry(root, registry);
  return 0;
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

  const outputRoot = skillInstallPath(root, slug);
  const snapshotPath = path.resolve(previous.snapshotPath);
  assertChildPath(path.join(root, ".myskills-app", "history"), snapshotPath);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(path.dirname(outputRoot), { recursive: true });
  await cp(snapshotPath, outputRoot, { recursive: true });
  registry.installations[slug] = {
    slug,
    version: previous.version,
    platform: previous.platform,
    path: outputRoot,
    installedAt: new Date().toISOString(),
    artifact: previous.artifact,
    history: existing.history.slice(0, -1),
  };
  await writeInstallRegistry(root, registry);
  runtime.io.stdout(`${slug}@${previous.version}\trolled-back\tplatform=${previous.platform}\t${outputRoot}`);
  return 0;
}

async function latestVersionForSkill(slug: string, parsed: ParsedArgs, runtime: CliRuntime, token: string | undefined): Promise<string> {
  const response = await apiGet(`/v1/skills/${encodeURIComponent(parseInstallSlug(slug))}`, parsed, runtime, token);
  const skill = response.skill;
  if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
    throw new CliError("API skill response is missing skill metadata.", 1);
  }
  const latestVersion = (skill as { latestVersion?: unknown }).latestVersion;
  if (typeof latestVersion !== "string" || !latestVersion) {
    throw new CliError(`${slug} has no approved release to install.`, 1);
  }
  return latestVersion;
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
}): Promise<InstalledSkillRecord> {
  const slug = parseInstallSlug(input.slug);
  const outputRoot = skillInstallPath(input.root, slug);
  const bundle = await downloadVerifiedBundle({
    slug,
    version: input.version,
    platform: input.platform,
  }, input.parsed, input.runtime, input.token);
  const existing = input.registry.installations[slug];
  const history = existing ? [...existing.history] : [];
  if (existing && await pathExists(outputRoot)) {
    const snapshotPath = historySnapshotPath(input.root, slug, existing.version);
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await rm(snapshotPath, { recursive: true, force: true });
    await cp(outputRoot, snapshotPath, { recursive: true });
    history.push({
      version: existing.version,
      platform: existing.platform,
      installedAt: existing.installedAt,
      artifact: existing.artifact,
      snapshotPath,
    });
  }

  await writeBundleFiles(bundle.files, outputRoot, { clean: true });
  const installed: InstalledSkillRecord = {
    slug,
    version: bundle.version,
    platform: bundle.platform.name,
    path: outputRoot,
    installedAt: new Date().toISOString(),
    artifact: bundle.artifact,
    history,
  };
  input.registry.installations[slug] = installed;
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
  return {
    slug: release.slug,
    version: release.version,
    artifact: release.artifact,
    platform,
    files,
  };
}

async function writeBundleFiles(files: Array<{ path: string; content: string }>, outputRoot: string, options: { clean: boolean }): Promise<Array<{ absolutePath: string; content: string }>> {
  const writes = files.map((file) => {
    const normalized = safeBundlePath(file.path);
    const absolutePath = path.resolve(outputRoot, normalized);
    const relative = path.relative(outputRoot, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new CliError(`Bundle file escapes output directory: ${file.path}`, 1);
    }
    return {
      absolutePath,
      content: file.content,
    };
  });

  if (options.clean) {
    await rm(outputRoot, { recursive: true, force: true });
  }
  for (const file of writes) {
    await mkdir(path.dirname(file.absolutePath), { recursive: true });
    await writeFile(file.absolutePath, file.content, "utf8");
  }
  return writes;
}

interface VerifiedBundle {
  slug: string;
  version: string;
  platform: ReleasePlatform;
  artifact: ReleaseArtifact;
  files: Array<{ path: string; content: string }>;
}

interface ReleasePlatform {
  name: string;
  installTarget: string;
  status: string;
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
  history: InstalledSkillSnapshot[];
}

interface InstalledSkillSnapshot {
  version: string;
  platform: string;
  installedAt: string;
  artifact: ReleaseArtifact;
  snapshotPath: string;
}

type CliVisibilityScope = (typeof CLI_VISIBILITY_SCOPES)[number];

interface CliSharingSettings {
  publicVisibilityEnabled: boolean;
  authenticatedVisibilityEnabled: boolean;
  teamsEnabled: boolean;
  teamVisibilityEnabled: boolean;
  userVisibilityEnabled: boolean;
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

interface CliSkillSharingDetails {
  slug: string;
  title: string;
  visibility: string;
  settings: CliSharingSettings | null;
  availableTeams: CliTeamSummary[];
  teamGrants: CliTeamSummary[];
  userGrants: CliUserSummary[];
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
      status: typeof record.status === "string" ? record.status : "supported",
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
  const configured = optionalStringOption(parsed, "dir")
    ?? runtime.env.MYSKILLS_INSTALL_DIR
    ?? (runtime.env.XDG_DATA_HOME ? path.join(runtime.env.XDG_DATA_HOME, "myskills-app", "skills") : undefined)
    ?? (runtime.env.HOME ? path.join(runtime.env.HOME, ".local", "share", "myskills-app", "skills") : undefined)
    ?? path.join(process.cwd(), ".myskills-app", "skills");
  return path.resolve(configured);
}

async function readInstallRegistry(root: string): Promise<InstallRegistry> {
  try {
    return parseInstallRegistry(await readFile(installRegistryPath(root), "utf8"), root);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: 1, installations: {} };
    }
    throw error;
  }
}

async function writeInstallRegistry(root: string, registry: InstallRegistry): Promise<void> {
  const filePath = installRegistryPath(root);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
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
  if (typeof record.version !== "string" || typeof record.platform !== "string") {
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
    history: parseInstallHistory(record.history, root),
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
    if (typeof record.version !== "string" || typeof record.platform !== "string" || typeof record.snapshotPath !== "string") {
      return [];
    }
    const snapshotPath = path.resolve(record.snapshotPath);
    assertChildPath(path.join(root, ".myskills-app", "history"), snapshotPath);
    return [{
      version: record.version,
      platform: record.platform,
      installedAt: typeof record.installedAt === "string" ? record.installedAt : "",
      artifact: parseStoredArtifact(record.artifact),
      snapshotPath,
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
  io.stdout(`${sharing.slug}\tvisibility=${sharing.visibility}\tteams=${teams}\tusers=${users}`);
}

function printSharingSettings(response: Record<string, unknown>, io: CliIo): void {
  const sharing = sharingSettingsFromResponse(response);
  io.stdout([
    `public=${enabledLabel(sharing.publicVisibilityEnabled)}`,
    `authenticated=${enabledLabel(sharing.authenticatedVisibilityEnabled)}`,
    `teams=${enabledLabel(sharing.teamsEnabled)}`,
    `team-visibility=${enabledLabel(sharing.teamVisibilityEnabled)}`,
    `user-visibility=${enabledLabel(sharing.userVisibilityEnabled)}`,
  ].join("\t"));
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

function installRegistryPath(root: string): string {
  return path.join(root, ".myskills-app", "installed.json");
}

function skillInstallPath(root: string, slug: string): string {
  return path.join(root, parseInstallSlug(slug));
}

function historySnapshotPath(root: string, slug: string, version: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(root, ".myskills-app", "history", parseInstallSlug(slug), `${timestamp}-${version}`);
}

function parseInstallSlug(slug: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new CliError("Skill slug is invalid.", 2);
  }
  return slug;
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
): Promise<{ ok: boolean; status: number; text: string }> {
  const baseUrl = apiBaseUrl(parsed, runtime);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await runtime.fetch(`${baseUrl}${pathname}`, init);
  } catch {
    throw new CliError([
      "Could not reach the MySkills API.",
      "",
      `API URL: ${baseUrl}`,
      "Check that the API is running, or use:",
      "  myskills <command> --api-url https://myskills.sh/api",
    ].join("\n"), 1, "API_UNREACHABLE");
  }
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
  };
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
        `API URL: ${baseUrl}`,
        "Run `myskills doctor` to inspect server capabilities.",
      ].join("\n"), 1, "API_UNSUPPORTED_ENDPOINT", status);
    }
  }
  const error = body.error as { code?: string; message?: string } | undefined;
  return new CliError(error?.message ?? `API request failed with ${status}.`, 1, error?.code ?? "API_REQUEST_FAILED", status);
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
    `Current API URL: ${baseUrl}`,
    "Try: myskills <command> --api-url https://myskills.sh/api",
  ].join("\n"), 1, "API_RETURNED_HTML");
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
  const testFile = path.join(root, ".myskills-app", "doctor-write-test");
  try {
    await mkdir(path.dirname(testFile), { recursive: true });
    await writeFile(testFile, "ok\n", "utf8");
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
    if (key === "json" || key === "api-key") {
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
    "  submit --path <file-directory-or-zip> [--api-url <url>] [--token <token>]",
    "  review submissions [--api-url <url>] [--token <token>]",
    "  review action <submission-id> --action <approve|request-changes|reject|publish> [--reason <text>] [--api-url <url>] [--token <token>]",
    "  submissions list [--api-url <url>] [--token <token>]",
    "  submissions withdraw <submission-id> [--reason <text>] [--api-url <url>] [--token <token>]",
    "  skills edit <skill-slug> [--title <text>] [--summary <text>] [--visibility <scope>] [--tag <tag>] [--reason <text>] [--api-url <url>] [--token <token>]",
    "  skills archive|restore|delete <skill-slug> [--reason <text>] [--api-url <url>] [--token <token>]",
    "  releases list <skill-slug> [--api-url <url>] [--token <token>]",
    "  releases deprecate|unpublish|revoke|restore|delete <skill-slug>@<version> [--reason <text>] [--replacement <version>] [--api-url <url>] [--token <token>]",
    "  teams list|skills [--api-url <url>] [--token <token>]",
    "  teams create <team-name> [--name <team-name>] [--api-url <url>] [--token <token>]",
    "  teams invite <team-id> --email <email> [--api-url <url>] [--token <token>]",
    "  teams accept <invitation-id> [--api-url <url>] [--token <token>]",
    "  sharing get <skill-slug> [--api-url <url>] [--token <token>]",
    "  sharing set <skill-slug> --visibility <scope> [--team <team-id>] [--user <email>]",
    "  admin sharing get [--api-url <url>] [--token <token>]",
    "  admin sharing set [--public <true|false>] [--authenticated <true|false>] [--teams <true|false>] [--team-visibility <true|false>] [--user-visibility <true|false>]",
    "  export <skill-slug> --version <version> --platform <platform> --output <dir>",
    "  install <skill-slug> [--version <version>] [--platform <platform>] [--dir <install-root>]",
    "  list [--dir <install-root>]",
    "  update [skill-slug] [--version <version>] [--platform <platform>] [--dir <install-root>]",
    "  rollback <skill-slug> [--dir <install-root>]",
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
