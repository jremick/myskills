import type { ParityCommandContext, ParityCommandInput } from "./parity-types.js";

interface Action {
  method: "GET" | "POST" | "PUT" | "DELETE";
  route: string;
  input?: true;
  limit?: true;
}

const architectureActions: Record<string, Action> = {
  create: { method: "POST", route: "/v1/architectures", input: true },
  revisions: { method: "GET", route: "/v1/architectures/:id/revisions" },
  revise: { method: "POST", route: "/v1/architectures/:id/revisions", input: true },
  "draft-preview": { method: "POST", route: "/v1/architectures/:id/draft-preview", input: true },
  grants: { method: "GET", route: "/v1/architectures/:id/organization-grants" },
  "set-grants": { method: "PUT", route: "/v1/architectures/:id/organization-grants", input: true },
  "migration-preview": { method: "POST", route: "/v1/architectures/:id/pattern-migrations/preview", input: true },
  migrate: { method: "POST", route: "/v1/architectures/:id/pattern-migrations", input: true },
};

const targetActions: Record<string, Action> = {
  list: { method: "GET", route: "/v1/architecture-targets" },
  show: { method: "GET", route: "/v1/architecture-targets/:id" },
  register: { method: "POST", route: "/v1/architecture-targets", input: true },
  consent: { method: "POST", route: "/v1/architecture-targets/:id/consent", input: true },
  observations: { method: "GET", route: "/v1/architecture-targets/:id/observations", limit: true },
  observe: { method: "POST", route: "/v1/architecture-targets/:id/observations", input: true },
  health: { method: "POST", route: "/v1/architecture-targets/:id/health", input: true },
  revoke: { method: "DELETE", route: "/v1/architecture-targets/:id" },
  updates: { method: "GET", route: "/v1/architecture-targets/:id/updates" },
  operations: { method: "GET", route: "/v1/architecture-targets/:id/operations" },
  schedule: { method: "POST", route: "/v1/architecture-targets/:id/operations", input: true },
  "update-policy": { method: "GET", route: "/v1/architecture-targets/:id/update-policy" },
  "set-update-policy": { method: "PUT", route: "/v1/architecture-targets/:id/update-policy", input: true },
};

const operationActions: Record<string, Action> = {
  show: { method: "GET", route: "/v1/target-operations/:id" },
  cancel: { method: "POST", route: "/v1/target-operations/:id/cancel" },
  batch: { method: "POST", route: "/v1/target-operations/batch", input: true },
};

export const architectureTargetHelp = [
  "  architectures create --input <request.json>",
  "  architectures revisions|grants <architecture-id>",
  "  architectures revise|draft-preview|set-grants|migration-preview|migrate <architecture-id> --input <request.json>",
  "  targets list",
  "  targets show|updates|operations|update-policy|revoke <target-id>",
  "  targets observations <target-id> [--limit <positive-integer>]",
  "  targets register --input <request.json>",
  "  targets consent|observe|health|schedule|set-update-policy <target-id> --input <request.json>",
  "  operations show|cancel <operation-id>",
  "  operations batch --input <request.json>",
  "    JSON requests use the API schemas. Preserve expected revision and idempotency fields on retries.",
  "    Target management and architecture writes use a login session; protected actions require MFA.",
];

/** General management commands. Local observation and companion execution stay
 * with the established CLI handlers; these routes never perform local writes. */
export async function runArchitectureTargetCommand(input: ParityCommandInput, context: ParityCommandContext): Promise<boolean> {
  const actions = input.command === "architectures" ? architectureActions
    : input.command === "targets" ? targetActions
      : input.command === "operations" ? operationActions : undefined;
  if (!actions) return false;
  const [name, id, ...extra] = input.args;
  const action = name && Object.hasOwn(actions, name) ? actions[name] : undefined;
  if (!action) {
    // Existing architecture read, preview and local adapter commands retain
    // their established semantics and validation.
    if (input.command === "architectures") return false;
    throw new Error(`Usage: myskills ${input.command} <${Object.keys(actions).join("|")}>. See myskills --help.`);
  }
  const needsId = action.route.includes(":id");
  if (extra.length || (!needsId && id !== undefined) || (needsId && !id)) {
    throw new Error(`Usage: myskills ${input.command} ${name}${needsId ? " <id>" : ""}${action.input ? " --input <request.json>" : ""}.`);
  }
  if (needsId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new Error("Invalid resource identifier.");
  }
  const allowed = new Set(["api-url", "token", "json", ...(action.input ? ["input"] : []), ...(action.limit ? ["limit"] : [])]);
  for (const option of Object.keys(input.options)) {
    if (!allowed.has(option)) throw new Error(`Unknown option --${option} for ${input.command} ${name}.`);
  }
  let route = needsId ? action.route.replace(":id", encodeURIComponent(id)) : action.route;
  if (input.options.limit !== undefined) {
    const limit = input.options.limit;
    if (typeof limit !== "string" || !/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit))) {
      throw new Error("--limit must be a positive integer.");
    }
    route += `?limit=${limit}`;
  }
  let body: Record<string, unknown> | undefined;
  if (action.input) {
    const file = input.options.input;
    if (typeof file !== "string" || !file.trim()) throw new Error("Provide the request body with --input <request.json>.");
    body = await context.readInput(file);
  }
  context.output(await context.request(action.method, route, body));
  return true;
}
