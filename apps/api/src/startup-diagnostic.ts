import { errorCodes } from "fastify";

const prefix = "MYSKILLS_API_STARTUP_FAILURE ";
const networkCodes = new Set(["EADDRINUSE", "EADDRNOTAVAIL", "EACCES", "EPERM", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ERR_SOCKET_BAD_PORT"]);
const databaseCodes = new Set(["28P01", "28000", "3D000", "42P01", "42703", "42501", "53300", "57P01", "57P03"]);
const moduleCodes = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);
const fastifyCodes = new Set(Object.keys(errorCodes));
export type ApiStartupPhase = "listen" | "worker_start";

/** Only fixed identifiers cross the startup boundary, including with logging disabled. */
export function apiStartupFailure(error: unknown, phase: ApiStartupPhase) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const category = typeof code !== "string" ? "unclassified"
    : networkCodes.has(code) ? "network"
    : databaseCodes.has(code) ? "database"
    : moduleCodes.has(code) ? "module"
    : fastifyCodes.has(code) ? "fastify"
    : "unclassified";
  return { phase, category, code: category === "unclassified" ? "UNKNOWN" : code as string };
}

export function formatApiStartupFailure(error: unknown, phase: ApiStartupPhase): string {
  return `${prefix}${JSON.stringify(apiStartupFailure(error, phase))}\n`;
}

/** Rebuild the receipt from allowed values; never echo child log fields or payloads. */
export function readApiStartupFailure(stderr: string): ReturnType<typeof apiStartupFailure> | undefined {
  for (const line of stderr.split("\n").reverse()) {
    if (!line.startsWith(prefix) || line.length > 256) continue;
    try {
      const value: unknown = JSON.parse(line.slice(prefix.length));
      if (!value || typeof value !== "object" || !("phase" in value) || !("code" in value)) continue;
      if (value.phase !== "listen" && value.phase !== "worker_start") continue;
      return apiStartupFailure({ code: value.code }, value.phase);
    } catch { /* Malformed or truncated output supplies no receipt. */ }
  }
  return undefined;
}
