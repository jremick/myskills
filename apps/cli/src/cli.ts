import {
  hasBlockingFindings,
  loadSkillManifestFromPath,
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
  options: Record<string, string | boolean>;
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

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const args: string[] = [];
  const options: Record<string, string | boolean> = {};

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
    options[key] = next;
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
