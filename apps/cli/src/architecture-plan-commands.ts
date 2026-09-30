import type { ParityCommandContext, ParityCommandInput } from "./parity-types.js";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;
const actions = {
  create: { method: "POST", route: "/v1/architecture-targets/:id/plans", body: true },
  list: { method: "GET", route: "/v1/architecture-targets/:id/plans", body: false },
  show: { method: "GET", route: "/v1/architecture-plans/:id", body: false },
  approve: { method: "POST", route: "/v1/architecture-plans/:id/approve", body: true },
} as const;

export const architecturePlanHelp = [
  "  architecture-plans create <target-id> --input <request.json>",
  "  architecture-plans list <target-id> [--limit <1-500>]",
  "  architecture-plans show <run-id>",
  "  architecture-plans approve <run-id> --input <review.json>",
  "    Create binds revisionId, expectedTargetGeneration, expectedObservationId, expectedObservationDigest and idempotencyKey.",
  "    Approval requires expectedReviewDigest from run.metadata.reviewDigest and current MFA.",
  "    Approval records review only. It does not apply or schedule target changes.",
];

/** Thin API adapter. The API owns exact releases, observation and policy fences. */
export async function runArchitecturePlanCommand(input: ParityCommandInput, context: ParityCommandContext): Promise<boolean> {
  if (input.command !== "architecture-plans") return false;
  const [name, id, ...extra] = input.args;
  if (!name || !Object.hasOwn(actions, name) || !id || !identifier.test(id) || extra.length) {
    throw new Error("Usage: myskills architecture-plans create|list|show|approve <id>. See myskills --help.");
  }
  const action = actions[name as keyof typeof actions];
  const allowed = new Set(["api-url", "token", "json", ...(action.body ? ["input"] : []), ...(name === "list" ? ["limit"] : [])]);
  for (const key of Object.keys(input.options)) if (!allowed.has(key)) throw new Error(`Unknown option --${key} for architecture-plans ${name}.`);
  let route = action.route.replace(":id", encodeURIComponent(id));
  if (input.options.limit !== undefined) {
    const value = input.options.limit;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || Number(value) > 500) throw new Error("--limit must be an integer between 1 and 500.");
    route += `?limit=${value}`;
  }
  let body: Record<string, unknown> | undefined;
  if (action.body) {
    const file = input.options.input;
    if (typeof file !== "string" || !file.trim()) throw new Error("Provide --input <request.json>.");
    body = await context.readInput(file);
    const fields = name === "create"
      ? ["revisionId", "expectedTargetGeneration", "expectedObservationId", "expectedObservationDigest", "idempotencyKey"]
      : ["expectedReviewDigest"];
    if (Object.keys(body).some(key => !fields.includes(key)) || fields.some(key => body?.[key] === undefined)) throw new Error("Provide only the required architecture plan request fields.");
    for (const field of name === "create" ? ["revisionId", "expectedObservationId", "idempotencyKey"] : []) {
      if (typeof body[field] !== "string" || !identifier.test(body[field])) throw new Error(`Invalid ${field}.`);
    }
    if (name === "create" && (!Number.isInteger(body.expectedTargetGeneration) || Number(body.expectedTargetGeneration) < 1 || Number(body.expectedTargetGeneration) > 1_000_000_000)) throw new Error("Invalid expectedTargetGeneration.");
    const digestField = name === "create" ? "expectedObservationDigest" : "expectedReviewDigest";
    if (typeof body[digestField] !== "string" || !digest.test(body[digestField])) throw new Error(`Invalid ${digestField}.`);
  }
  context.output(await context.request(action.method, route, body));
  return true;
}
