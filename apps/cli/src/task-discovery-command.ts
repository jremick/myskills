import { taskDiscoveryLimits } from "@myskills-app/core";
import type { ParityCommandInput } from "./parity-types.js";

/** Uses the existing CLI credential selection and HTTP transport supplied by the dispatcher. */
export function taskDiscoveryRequest(parsed: ParityCommandInput): { path: string; body: { task: string; limit: number } } {
  const task = parsed.args.join(" ").trim();
  const raw = parsed.options.limit;
  const limit = raw === undefined ? 10 : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!task || task.length > taskDiscoveryLimits.taskCharacters || !Number.isInteger(limit) || limit < 1 || limit > taskDiscoveryLimits.results) throw new Error("Use a task of 1–4,000 characters and --limit 1–20.");
  return { path: "/v1/skills/discover", body: { task, limit } };
}
