import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliConfigStore } from "./cli.js";

interface ConfigPayload {
  version: 1;
  apiUrl?: string;
}

export function createFileConfigStore(env: Record<string, string | undefined> = process.env): CliConfigStore {
  const filePath = configFilePath(env);
  let payload = readPayload(filePath);
  return {
    getApiUrl() {
      return payload.apiUrl;
    },
    async setApiUrl(apiUrl) {
      payload = {
        ...payload,
        apiUrl: apiUrl.replace(/\/+$/, ""),
      };
      writePayload(filePath, payload);
    },
  };
}

function configFilePath(env: Record<string, string | undefined>): string {
  if (env.MYSKILLS_CONFIG_FILE) {
    return path.resolve(env.MYSKILLS_CONFIG_FILE);
  }
  if (env.MYSKILLS_CONFIG_DIR) {
    return path.join(path.resolve(env.MYSKILLS_CONFIG_DIR), "config.json");
  }
  const baseDir = env.XDG_CONFIG_HOME
    ? path.join(env.XDG_CONFIG_HOME, "myskills-app")
    : path.join(os.homedir(), ".config", "myskills-app");
  return path.join(baseDir, "config.json");
}

function readPayload(filePath: string): ConfigPayload {
  try {
    return parsePayload(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: 1 };
    }
    throw error;
  }
}

function writePayload(filePath: string, payload: ConfigPayload): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function parsePayload(raw: string): ConfigPayload {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config file must contain a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error("Config file has an unsupported format.");
  }
  return {
    version: 1,
    apiUrl: typeof record.apiUrl === "string" && record.apiUrl ? record.apiUrl.replace(/\/+$/, "") : undefined,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
