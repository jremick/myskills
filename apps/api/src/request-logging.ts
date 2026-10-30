export type RequestLogMode = "all" | "sampled" | "errors";

export interface RequestLoggingConfig {
  mode: RequestLogMode;
  /** Share of ordinary requests logged in "sampled" mode, 0..1. */
  sampleRate: number;
  /** Requests at or above this duration are always logged. */
  slowMs: number;
}

export type RequestLogDecision = "error" | "slow" | "sampled" | "skip";

const PROBE_PATHS = new Set(["/health", "/ready"]);

/**
 * Reads API_REQUEST_LOG_MODE (all | sampled | errors; default sampled),
 * API_REQUEST_LOG_SAMPLE_RATE (default 0.01) and API_REQUEST_LOG_SLOW_MS
 * (default 1000). Invalid values fall back to the defaults.
 */
export function requestLoggingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RequestLoggingConfig {
  const rawMode = env.API_REQUEST_LOG_MODE?.trim().toLowerCase();
  const mode: RequestLogMode = rawMode === "all" || rawMode === "errors" || rawMode === "sampled" ? rawMode : "sampled";
  const rate = Number(env.API_REQUEST_LOG_SAMPLE_RATE);
  const slow = Number(env.API_REQUEST_LOG_SLOW_MS);
  return {
    mode,
    sampleRate: env.API_REQUEST_LOG_SAMPLE_RATE !== undefined && Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.01,
    slowMs: env.API_REQUEST_LOG_SLOW_MS !== undefined && Number.isFinite(slow) && slow > 0 ? slow : 1000,
  };
}

/** Server errors and slow requests are always logged; probes are never sampled in. */
export function requestLogDecision(
  config: RequestLoggingConfig,
  input: { statusCode: number; durationMs: number; path: string },
  random: () => number = Math.random,
): RequestLogDecision {
  if (input.statusCode >= 500) return "error";
  if (input.durationMs >= config.slowMs) return "slow";
  if (config.mode === "all") return "sampled";
  if (config.mode === "errors" || PROBE_PATHS.has(input.path)) return "skip";
  return random() < config.sampleRate ? "sampled" : "skip";
}
