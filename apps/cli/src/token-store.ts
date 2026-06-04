import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliTokenStore, StoredCliToken } from "./cli.js";

interface TokenFilePayload {
  version: 1;
  tokens: Record<string, StoredCliToken>;
}

export function createFileTokenStore(env: Record<string, string | undefined> = process.env): CliTokenStore {
  const filePath = tokenFilePath(env);
  return {
    async get(apiUrl) {
      return (await readPayload(filePath)).tokens[normalizeApiUrl(apiUrl)] ?? null;
    },
    async set(apiUrl, token) {
      const payload = await readPayload(filePath);
      payload.tokens[normalizeApiUrl(apiUrl)] = token;
      await writePayload(filePath, payload);
    },
    async delete(apiUrl) {
      const payload = await readPayload(filePath);
      delete payload.tokens[normalizeApiUrl(apiUrl)];
      if (Object.keys(payload.tokens).length === 0) {
        await rm(filePath, { force: true });
        return;
      }
      await writePayload(filePath, payload);
    },
  };
}

function tokenFilePath(env: Record<string, string | undefined>): string {
  if (env.MYSKILLS_TOKEN_FILE) {
    return path.resolve(env.MYSKILLS_TOKEN_FILE);
  }
  if (env.MYSKILLS_CONFIG_DIR) {
    return path.join(path.resolve(env.MYSKILLS_CONFIG_DIR), "tokens.json");
  }
  const baseDir = env.XDG_CONFIG_HOME
    ? path.join(env.XDG_CONFIG_HOME, "myskills-app")
    : path.join(os.homedir(), ".config", "myskills-app");
  return path.join(baseDir, "tokens.json");
}

async function readPayload(filePath: string): Promise<TokenFilePayload> {
  try {
    const raw = await readFile(filePath, "utf8");
    return parsePayload(raw);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: 1, tokens: {} };
    }
    throw error;
  }
}

async function writePayload(filePath: string, payload: TokenFilePayload): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function parsePayload(raw: string): TokenFilePayload {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Token store file must contain a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || !record.tokens || typeof record.tokens !== "object" || Array.isArray(record.tokens)) {
    throw new Error("Token store file has an unsupported format.");
  }
  const tokens: Record<string, StoredCliToken> = {};
  for (const [apiUrl, token] of Object.entries(record.tokens as Record<string, unknown>)) {
    const parsedToken = parseStoredToken(token);
    if (parsedToken) {
      tokens[normalizeApiUrl(apiUrl)] = parsedToken;
    }
  }
  return { version: 1, tokens };
}

function parseStoredToken(input: unknown): StoredCliToken | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if ((record.kind !== "session" && record.kind !== "api") || typeof record.token !== "string" || !record.token) {
    return null;
  }
  return {
    kind: record.kind,
    token: record.token,
    email: typeof record.email === "string" ? record.email : undefined,
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : undefined,
  };
}

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, "");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
