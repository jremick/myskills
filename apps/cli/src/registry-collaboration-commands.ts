import type { ParityCommandContext, ParityCommandInput } from "./parity-types.js";

export const registryCollaborationHelp = [
  "  skills managed [--query <text>] [--limit <1-100>] [--cursor <cursor>]",
  "  skills managed <slug>",
  "  submissions show <submission-id>",
  "  submissions export <submission-id> [--platform <name>] [--output <file>]",
  "  review show <submission-id>",
  "  teams revoke-invitation <team-id> <invitation-id>",
  "  teams set-role <team-id> <member-id> --role <owner|member>",
  "  teams remove-member <team-id> <member-id>",
  "  organizations list|pending-invitations",
  "  organizations show|members|invitations|policies|teams|update-policy <organization-id>",
  "  organizations create <name> [--slug <slug>] | create --input <json-file>",
  "  organizations archive <organization-id>",
  "  organizations invite <organization-id> --email <email> [--role <owner|admin|member>]",
  "  organizations accept <invitation-id>",
  "  organizations set-role <organization-id> <member-id> --role <owner|admin|member>",
  "  organizations remove-member <organization-id> <member-id>",
  "  organizations append-policy|set-update-policy <organization-id> --input <json-file>",
  "  organizations activate-policy <organization-id> <revision-id>",
  "  organizations create-team <organization-id> <name> [--slug <slug>] | create-team <organization-id> --input <json-file>",
  "  organizations adopt-team <organization-id> <team-id>",
];

const globalOptions = new Set(["api-url", "token", "json"]);
const organizationReadPaths: Record<string, string> = {
  show: "", members: "/members", invitations: "/invitations", policies: "/policy-revisions", teams: "/teams", "update-policy": "/update-policy",
};

/** Thin command adapters: the API remains the membership, scope and MFA authority. */
export async function runRegistryCollaborationCommand(
  input: ParityCommandInput,
  context: ParityCommandContext,
): Promise<boolean> {
  const [action, ...args] = input.args;
  const send = async (method: Parameters<ParityCommandContext["request"]>[0], path: string, body?: unknown) => {
    context.output(await context.request(method, path, body));
  };
  if (input.command === "skills" && action === "managed") {
    if (args.length) {
      validate(input, args, 1);
      await send("GET", `/v1/manage/skills/${identifier(args[0], "slug")}`);
      return true;
    }
    validate(input, args, 0, ["query", "limit", "cursor"]);
    const query = new URLSearchParams();
    const search = option(input, "query");
    const cursor = option(input, "cursor");
    const limit = option(input, "limit");
    if (search !== undefined) query.set("q", search);
    if (cursor !== undefined) query.set("cursor", cursor);
    if (limit !== undefined) {
      if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error("--limit must be an integer between 1 and 100.");
      query.set("limit", limit);
    }
    await send("GET", `/v1/manage/skills${query.size ? `?${query}` : ""}`);
    return true;
  }
  if ((input.command === "submissions" || input.command === "review") && action === "show") {
    validate(input, args, 1);
    const prefix = input.command === "review" ? "/v1/review/submissions" : "/v1/submissions";
    await send("GET", `${prefix}/${identifier(args[0], "submission-id")}`);
    return true;
  }
  if (input.command === "submissions" && action === "export") {
    validate(input, args, 1, ["platform", "output"]);
    const id = identifier(args[0], "submission-id");
    const platform = option(input, "platform");
    const output = option(input, "output");
    if (platform !== undefined && (platform.length > 64 || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(platform))) {
      throw new Error("Invalid --platform; use a platform name such as codex.");
    }
    const result = await context.request("GET", `/v1/submissions/${id}/bundle${platform ? `?platform=${encodeURIComponent(platform)}` : ""}`);
    if (output) {
      await context.writeOutput(output, `${JSON.stringify(result, null, 2)}\n`);
      context.output({ output });
    } else {
      context.output(result);
    }
    return true;
  }
  if (input.command === "teams" && ["revoke-invitation", "set-role", "remove-member"].includes(action ?? "")) {
    validate(input, args, 2, action === "set-role" ? ["role"] : []);
    const team = identifier(args[0], "team-id");
    const member = identifier(args[1], action === "revoke-invitation" ? "invitation-id" : "member-id");
    if (action === "revoke-invitation") await send("DELETE", `/v1/teams/${team}/invitations/${member}`);
    else if (action === "remove-member") await send("DELETE", `/v1/teams/${team}/members/${member}`);
    else await send("PUT", `/v1/teams/${team}/members/${member}`, { role: role(input, ["owner", "member"]) });
    return true;
  }
  if (input.command !== "organizations") return false;
  if (action === "list" || action === "pending-invitations") {
    validate(input, args, 0);
    await send("GET", action === "list" ? "/v1/organizations" : "/v1/organizations/invitations");
  } else if (action && Object.hasOwn(organizationReadPaths, action)) {
    validate(input, args, 1);
    await send("GET", `/v1/organizations/${identifier(args[0], "organization-id")}${organizationReadPaths[action]}`);
  } else if (action === "create") {
    const body = await namedInput(input, args, context);
    await send("POST", "/v1/organizations", body);
  } else if (action === "archive") {
    validate(input, args, 1);
    await send("POST", `/v1/organizations/${identifier(args[0], "organization-id")}/actions`, { action: "archive" });
  } else if (action === "invite") {
    validate(input, args, 1, ["email", "role"]);
    const id = identifier(args[0], "organization-id");
    const email = requiredOption(input, "email");
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid --email.");
    const requestedRole = option(input, "role");
    await send("POST", `/v1/organizations/${id}/invitations`, { email, ...(requestedRole ? { role: role(input, ["owner", "admin", "member"]) } : {}) });
  } else if (action === "accept") {
    validate(input, args, 1);
    await send("POST", `/v1/organizations/invitations/${identifier(args[0], "invitation-id")}/accept`, {});
  } else if (action === "set-role" || action === "remove-member") {
    validate(input, args, 2, action === "set-role" ? ["role"] : []);
    const endpoint = `/v1/organizations/${identifier(args[0], "organization-id")}/members/${identifier(args[1], "member-id")}`;
    if (action === "remove-member") await send("DELETE", endpoint);
    else await send("PUT", endpoint, { role: role(input, ["owner", "admin", "member"]) });
  } else if (action === "append-policy" || action === "set-update-policy") {
    validate(input, args, 1, ["input"]);
    const id = identifier(args[0], "organization-id");
    const body = await context.readInput(requiredOption(input, "input"));
    if (action === "append-policy") await send("POST", `/v1/organizations/${id}/policy-revisions`, body);
    else await send("PUT", `/v1/organizations/${id}/update-policy`, body);
  } else if (action === "activate-policy") {
    validate(input, args, 2);
    await send("POST", `/v1/organizations/${identifier(args[0], "organization-id")}/policy-revisions/${identifier(args[1], "revision-id")}/actions`, { action: "activate" });
  } else if (action === "create-team") {
    const id = identifier(args[0], "organization-id");
    const body = await namedInput(input, args.slice(1), context);
    await send("POST", `/v1/organizations/${id}/teams`, body);
  } else if (action === "adopt-team") {
    validate(input, args, 2);
    const organizationId = identifier(args[0], "organization-id");
    await send("PUT", `/v1/teams/${identifier(args[1], "team-id")}/organization`, { organizationId: decodeURIComponent(organizationId) });
  } else {
    return false;
  }
  return true;
}

async function namedInput(input: ParityCommandInput, args: string[], context: ParityCommandContext): Promise<Record<string, unknown>> {
  const file = option(input, "input");
  if (file !== undefined) {
    validate(input, args, 0, ["input"]);
    return context.readInput(file);
  }
  validate(input, args, 1, ["slug"]);
  const name = args[0]!;
  if (!name.trim() || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Invalid name; use 1 to 120 printable characters.");
  const slug = option(input, "slug");
  if (slug !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Invalid --slug; use lowercase letters, numbers and hyphens.");
  return { name, ...(slug === undefined ? {} : { slug }) };
}

function validate(input: ParityCommandInput, args: string[], count: number, allowed: string[] = []): void {
  if (args.length !== count) throw new Error(`Usage: myskills ${input.command} ${input.args[0] ?? ""} requires ${count} argument${count === 1 ? "" : "s"}. See myskills help.`);
  for (const key of Object.keys(input.options)) {
    if (!globalOptions.has(key) && !allowed.includes(key)) throw new Error(`Unsupported option --${key} for ${input.command} ${input.args[0]}.`);
  }
  for (const key of allowed) option(input, key);
}

function option(input: ParityCommandInput, key: string): string | undefined {
  const value = input.options[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`--${key} requires one non-empty value.`);
  return value;
}

function requiredOption(input: ParityCommandInput, key: string): string {
  const value = option(input, key);
  if (value === undefined) throw new Error(`--${key} is required.`);
  return value;
}

function identifier(value: string | undefined, label: string): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`Invalid ${label}; use an identifier from the API response.`);
  return encodeURIComponent(value);
}

function role(input: ParityCommandInput, allowed: string[]): string {
  const value = requiredOption(input, "role");
  if (!allowed.includes(value)) throw new Error(`--role must be ${allowed.join(" or ")}.`);
  return value;
}
