import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  hasBlockingFindings,
  loadSkillManifestFromPath,
  normalizePackageFilePath,
  readPackageFilesFromPath,
  scanPackagePath,
  type PackageScanResult,
} from "@ai-skills-share/skill-package";

const DEFAULT_API_URL = "http://localhost:3001";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
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
      case "validate":
        return await validateCommand(parsed, runtime);
      case "scan":
        return await scanCommand(parsed, runtime);
      case "search":
        return await searchCommand(parsed, runtime);
      case "info":
        return await infoCommand(parsed, runtime);
      case "whoami":
        return await whoamiCommand(parsed, runtime);
      case "submit":
        return await submitCommand(parsed, runtime);
      case "review":
        return await reviewCommand(parsed, runtime);
      case "export":
        return await exportCommand(parsed, runtime);
      case "token":
        return await tokenCommand(parsed, runtime);
      default:
        throw new CliError(`Unknown command: ${parsed.command}`, 2);
    }
  } catch (error) {
    if (error instanceof CliError) {
      runtime.io.stderr(error.message);
      return error.exitCode;
    }
    runtime.io.stderr(error instanceof Error ? error.message : "Unexpected CLI failure.");
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
    tokenOption(parsed, runtime) ?? undefined,
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
    throw new CliError("Usage: ai-skills info <skill-slug>", 2);
  }
  const response = await apiGet(
    `/v1/skills/${encodeURIComponent(slug)}`,
    parsed,
    runtime,
    tokenOption(parsed, runtime) ?? undefined,
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

async function whoamiCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const token = tokenOption(parsed, runtime);
  if (!token) {
    throw new CliError("No token provided. Set AI_SKILLS_TOKEN or pass --token.", 1);
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

async function tokenCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const token = tokenOption(parsed, runtime);
  if (!token) {
    throw new CliError("No token provided. Set AI_SKILLS_TOKEN or pass --token.", 1);
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
      throw new CliError("Usage: ai-skills token revoke <token-id>", 2);
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
  throw new CliError("Usage: ai-skills token create|list|revoke", 2);
}

async function reviewCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const token = tokenOption(parsed, runtime);
  if (!token) {
    throw new CliError("No token provided. Set AI_SKILLS_TOKEN or pass --token.", 1);
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
      throw new CliError("Usage: ai-skills review action <submission-id> --action <approve|publish>", 2);
    }
    const action = stringOption(parsed, "action");
    if (action !== "approve" && action !== "publish") {
      throw new CliError("--action must be approve or publish.", 2);
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
  throw new CliError("Usage: ai-skills review submissions | review action <submission-id> --action <approve|publish>", 2);
}

async function submitCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const token = tokenOption(parsed, runtime);
  if (!token) {
    throw new CliError("No token provided. Set AI_SKILLS_TOKEN or pass --token.", 1);
  }
  const packagePath = requiredPath(parsed);
  const manifest = await loadSkillManifestFromPath(packagePath);
  const scan = await scanPackagePath(packagePath);
  if (hasBlockingFindings(scan.findings)) {
    printScanResult(scan, runtime.io);
    throw new CliError("Package has blocking scan findings; submission was not sent.", 1);
  }
  const files = await readPackageFilesFromPath(packagePath);
  const response = await apiPost("/v1/submissions", {
    manifest,
    files,
  }, parsed, runtime, token);
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

async function exportCommand(parsed: ParsedArgs, runtime: CliRuntime): Promise<number> {
  const slug = parsed.args[0];
  if (!slug) {
    throw new CliError("Usage: ai-skills export <skill-slug> --version <version> --platform <platform> --output <dir>", 2);
  }
  const version = stringOption(parsed, "version");
  const platform = stringOption(parsed, "platform");
  const outputDir = stringOption(parsed, "output");
  const token = tokenOption(parsed, runtime) ?? undefined;
  const releaseResponse = await apiGet(
    `/v1/skills/${encodeURIComponent(slug)}/releases/${encodeURIComponent(version)}`,
    parsed,
    runtime,
    token,
  );
  const artifact = releaseArtifact(releaseResponse);
  const bundleText = await apiGetText(
    `/v1/skills/${encodeURIComponent(slug)}/releases/${encodeURIComponent(version)}/bundle?platform=${encodeURIComponent(platform)}`,
    parsed,
    runtime,
    token,
  );
  const byteSize = Buffer.byteLength(bundleText);
  const sha256 = createHash("sha256").update(bundleText).digest("hex");
  if (byteSize !== artifact.byteSize || sha256 !== artifact.sha256) {
    throw new CliError("Downloaded bundle did not match release metadata.", 1);
  }

  const files = parseBundlePayload(bundleText);
  const outputRoot = path.resolve(outputDir);
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

  for (const file of writes) {
    await mkdir(path.dirname(file.absolutePath), { recursive: true });
    await writeFile(file.absolutePath, file.content, "utf8");
  }
  runtime.io.stdout(`${slug}@${version}\texported\tfiles=${writes.length}\t${outputRoot}`);
  return 0;
}

async function apiGet(pathname: string, parsed: ParsedArgs, runtime: CliRuntime, token?: string): Promise<Record<string, unknown>> {
  const baseUrl = String(parsed.options["api-url"] ?? runtime.env.AI_SKILLS_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await runtime.fetch(`${baseUrl}${pathname}`, { headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) {
    const error = body.error as { code?: string; message?: string } | undefined;
    throw new CliError(error?.message ?? `API request failed with ${response.status}.`, 1);
  }
  return body;
}

async function apiGetText(pathname: string, parsed: ParsedArgs, runtime: CliRuntime, token?: string): Promise<string> {
  const baseUrl = String(parsed.options["api-url"] ?? runtime.env.AI_SKILLS_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await runtime.fetch(`${baseUrl}${pathname}`, { headers });
  const text = await response.text();
  if (!response.ok) {
    const error = parseApiError(text);
    throw new CliError(error ?? `API request failed with ${response.status}.`, 1);
  }
  return text;
}

async function apiPost(pathname: string, payload: unknown, parsed: ParsedArgs, runtime: CliRuntime, token: string): Promise<Record<string, unknown>> {
  const baseUrl = String(parsed.options["api-url"] ?? runtime.env.AI_SKILLS_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const response = await runtime.fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) {
    const error = body.error as { code?: string; message?: string } | undefined;
    throw new CliError(error?.message ?? `API request failed with ${response.status}.`, 1);
  }
  return body;
}

async function apiDelete(pathname: string, parsed: ParsedArgs, runtime: CliRuntime, token: string): Promise<Record<string, unknown>> {
  const baseUrl = String(parsed.options["api-url"] ?? runtime.env.AI_SKILLS_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const response = await runtime.fetch(`${baseUrl}${pathname}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) {
    const error = body.error as { code?: string; message?: string } | undefined;
    throw new CliError(error?.message ?? `API request failed with ${response.status}.`, 1);
  }
  return body;
}

function parseApiError(text: string): string | null {
  try {
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    const error = body.error as { message?: string } | undefined;
    return error?.message ?? null;
  } catch {
    return null;
  }
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
    throw new CliError("A package path is required. Pass --path <file-or-directory>.", 2);
  }
  return value;
}

function tokenOption(parsed: ParsedArgs, runtime: CliRuntime): string | null {
  const token = parsed.options.token;
  if (typeof token === "string" && token) {
    return token;
  }
  return runtime.env.AI_SKILLS_TOKEN ?? null;
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
    if (key === "json") {
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
    "ai-skills <command>",
    "",
    "Commands:",
    "  validate --path <file-or-directory>",
    "  scan --path <file-or-directory>",
    "  search [query] [--api-url <url>]",
    "  info <skill-slug> [--api-url <url>]",
    "  whoami [--api-url <url>] [--token <token>]",
    "  submit --path <file-or-directory> [--api-url <url>] [--token <token>]",
    "  review submissions [--api-url <url>] [--token <token>]",
    "  review action <submission-id> --action <approve|publish> [--reason <text>]",
    "  export <skill-slug> --version <version> --platform <platform> --output <dir>",
    "  token create --name <name> --scope <scope> [--scope <scope>]",
    "  token list",
    "  token revoke <token-id>",
    "",
    "Options:",
    "  --json              Print machine-readable JSON.",
    "  --api-url <url>     API base URL. Defaults to AI_SKILLS_API_URL or http://localhost:3001.",
    "  --token <token>     Bearer token. Defaults to AI_SKILLS_TOKEN when available.",
  ].join("\n");
}

class CliError extends Error {
  constructor(message: string, public readonly exitCode: number) {
    super(message);
  }
}
