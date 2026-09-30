import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ParityCommandContext, ParityCommandInput } from "./parity-types.js";

export const accountAdminHelp = [
  "  account register --email <email> [--name <name>]  (prompts for a password and an optional invitation token)",
  "  account verify-email-request|password-reset-request --email <email>",
  "  account verify-email|confirm-email-change  (prompts for the emailed token)",
  "  account password-reset  (prompts for the reset token and a new password)",
  "  account change-password  (prompts for the current and new password)",
  "  account change-email --email <new-email>  (prompts for the current password)",
  "  account mfa-status",
  "  account mfa-enroll --output <new-file> [--label <label>]  (writes the TOTP setup secret to a new private file)",
  "  account mfa-confirm <factor-id> --output <new-file>  (prompts for a code; writes recovery codes to a new private file)",
  "  account mfa-disable  (prompts for the current password)",
  "  connections info|list",
  "  connections revoke <connection-id>",
  "  admin branding get | set --input <branding.json>",
  "  admin site get | set --landing-page enabled|disabled",
  "  admin registration get | set --mode closed|request|open | invite --email <email> [--name <name>]",
  "  admin providers list | set <provider-key> --input <provider.json>",
  "  admin users list | action <user-id> --action approve|activate|disable|delete [--reason <text>]",
  "  admin users roles <user-id> --role <role> [--role <role> ...] [--reason <text>]",
  "  admin tokens list | revoke <token-id>",
  "  admin audit [--limit <1-100>] [--cursor <cursor>]",
  "  instance info|health|ready|version|capabilities|branding|site",
];

type Method = Parameters<ParityCommandContext["request"]>[0];
type Auth = "required" | "optional" | "none";

const globalOptions = new Set(["api-url", "token", "json"]);
// Secrets never come from argv: it is visible in process lists and shell history.
const secretOptionPattern = /password|passphrase|secret|recovery|totp|^otp$|^code$|-token$/i;
const providerSecretKeyPattern = /secret|password|token|private[-_ ]?key|api[-_ ]?key/i;
const adminResources = new Set(["branding", "site", "registration", "providers", "users", "tokens", "audit"]);
const userRoles = ["owner", "admin", "maintainer", "author", "user"];
const userActions = ["approve", "activate", "disable", "delete"];
const registrationModes = ["closed", "request", "open"];
const instancePaths: Record<string, string> = {
  health: "/health", ready: "/ready", version: "/version.json",
  capabilities: "/v1/capabilities", branding: "/v1/branding", site: "/v1/site",
};

/** Thin account/admin adapters: the API remains the session, role, MFA and owner-safeguard authority. */
export async function runAccountAdminCommand(
  input: ParityCommandInput,
  context: ParityCommandContext,
): Promise<boolean> {
  const [action, ...args] = input.args;
  const send = async (method: Method, endpoint: string, body?: unknown, auth: Auth = "required") => {
    context.output(await context.request(method, endpoint, body, auth));
  };
  if (input.command === "account") {
    await accountCommand(input, action, args, context, send);
    return true;
  }
  if (input.command === "connections") {
    if (action === "info" || action === "list") {
      validate(input, args, 0);
      await send("GET", action === "info" ? "/v1/oauth/connector" : "/v1/oauth/connections", undefined, action === "info" ? "none" : "required");
    } else if (action === "revoke") {
      validate(input, args, 1);
      await send("DELETE", `/v1/oauth/connections/${identifier(args[0], "connection-id", /^[A-Za-z0-9-]{1,64}$/)}`);
    } else {
      throw usage("connections info|list|revoke <connection-id>");
    }
    return true;
  }
  if (input.command === "instance") {
    if (action === "info") {
      validate(input, args, 0);
      const health = await context.request("GET", "/health", undefined, "none");
      const version = await context.request("GET", "/version.json", undefined, "none");
      context.output({ health, version });
    } else if (action && Object.hasOwn(instancePaths, action)) {
      validate(input, args, 0);
      await send("GET", instancePaths[action]!, undefined, "none");
    } else {
      throw usage("instance info|health|ready|version|capabilities|branding|site");
    }
    return true;
  }
  // Other admin resources, including sharing, stay with the legacy command.
  if (input.command !== "admin" || !action || !adminResources.has(action)) return false;
  await adminCommand(input, action, args, context, send);
  return true;
}

async function accountCommand(
  input: ParityCommandInput,
  action: string | undefined,
  args: string[],
  context: ParityCommandContext,
  send: (method: Method, endpoint: string, body?: unknown, auth?: Auth) => Promise<void>,
): Promise<void> {
  switch (action) {
    case "register": {
      validate(input, args, 0, ["email", "name"]);
      const email = emailOption(input, "email");
      const name = textOption(input, "name", 120);
      const password = await newPassword(context);
      const inviteToken = (await context.secret("Invitation token (press Enter if none): ")).trim();
      await send("POST", "/v1/auth/register", {
        email, password, ...(name === undefined ? {} : { name }), ...(inviteToken ? { inviteToken } : {}),
      }, "none");
      return;
    }
    case "verify-email-request":
    case "password-reset-request": {
      validate(input, args, 0, ["email"]);
      const email = emailOption(input, "email");
      await send("POST", action === "verify-email-request" ? "/v1/auth/email-verification/request" : "/v1/auth/password-reset/request", { email }, "none");
      return;
    }
    case "verify-email":
    case "confirm-email-change": {
      validate(input, args, 0);
      const token = await requiredSecret(context, action === "verify-email" ? "Verification token: " : "Email change token: ", true);
      await send("POST", action === "verify-email" ? "/v1/auth/email-verification/confirm" : "/v1/auth/email-change/confirm", { token }, "none");
      return;
    }
    case "password-reset": {
      validate(input, args, 0);
      const token = await requiredSecret(context, "Reset token: ", true);
      const password = await newPassword(context);
      await send("POST", "/v1/auth/password-reset/confirm", { token, password }, "none");
      return;
    }
    case "change-password": {
      validate(input, args, 0);
      const currentPassword = await requiredSecret(context, "Current password: ");
      const password = await newPassword(context);
      await send("POST", "/v1/auth/account/password", { currentPassword, password });
      return;
    }
    case "change-email": {
      validate(input, args, 0, ["email"]);
      const email = emailOption(input, "email");
      const password = await requiredSecret(context, "Current password: ");
      await send("POST", "/v1/auth/account/email-change", { email, password });
      return;
    }
    case "mfa-status":
      validate(input, args, 0);
      await send("GET", "/v1/auth/mfa");
      return;
    case "mfa-enroll": {
      validate(input, args, 0, ["output", "label"]);
      const output = requiredOption(input, "output");
      const label = textOption(input, "label", 120);
      // The seed is for direct authenticator setup: keep it out of terminal output and logs.
      const result = await withReservedOutput(output, async () => {
        const password = await requiredSecret(context, "Current password: ");
        return context.request("POST", "/v1/auth/mfa/totp/enroll", { password, ...(label === undefined ? {} : { label }) });
      }, "A pending MFA factor was created, but its setup secret could not be saved to --output. Nothing was enabled; run account mfa-enroll again with a new --output file.");
      const enrollment = record(result.enrollment);
      context.output({ enrollment: { factorId: enrollment.factorId, label: enrollment.label }, output });
      return;
    }
    case "mfa-confirm": {
      validate(input, args, 1, ["output"]);
      const factorId = identifier(args[0], "factor-id", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
      const output = requiredOption(input, "output");
      // Recovery codes are returned once, after MFA is enabled; never retry this request.
      const result = await withReservedOutput(output, async () => {
        const code = (await requiredSecret(context, "Authenticator code: ", true)).replace(/\s+/g, "");
        if (!/^\d{6,8}$/.test(code)) throw new Error("Enter the numeric code from the authenticator app.");
        return context.request("POST", "/v1/auth/mfa/totp/confirm", { factorId: decodeURIComponent(factorId), code });
      }, "MFA is now enabled, but the recovery codes could not be saved to --output and cannot be shown again. Do not rerun mfa-confirm. Sign in with your authenticator app, then disable and re-enroll MFA to issue new recovery codes.");
      context.output({ mfa: { factor: record(result.mfa).factor }, output });
      return;
    }
    case "mfa-disable": {
      validate(input, args, 0);
      const password = await requiredSecret(context, "Current password: ");
      await send("DELETE", "/v1/auth/mfa/totp", { password });
      return;
    }
    default:
      throw usage("account register|verify-email-request|verify-email|password-reset-request|password-reset|change-password|change-email|confirm-email-change|mfa-status|mfa-enroll|mfa-confirm|mfa-disable");
  }
}

async function adminCommand(
  input: ParityCommandInput,
  resource: string,
  rest: string[],
  context: ParityCommandContext,
  send: (method: Method, endpoint: string, body?: unknown, auth?: Auth) => Promise<void>,
): Promise<void> {
  if (resource === "audit") {
    validate(input, rest, 0, ["limit", "cursor"]);
    const query = new URLSearchParams();
    const limit = option(input, "limit");
    const cursor = option(input, "cursor");
    if (limit !== undefined) {
      if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error("--limit must be an integer between 1 and 100.");
      query.set("limit", limit);
    }
    if (cursor !== undefined) {
      if (cursor.length > 1024) throw new Error("Invalid --cursor; use nextCursor from the previous page.");
      query.set("cursor", cursor);
    }
    await send("GET", `/v1/admin/audit${query.size ? `?${query}` : ""}`);
    return;
  }
  const [action, ...args] = rest;
  const scope = `admin ${resource} ${action ?? ""}`.trim();
  if (resource === "branding" || resource === "site") {
    if (action === "get") {
      validate(input, args, 0, [], scope);
      await send("GET", `/v1/admin/${resource}`);
    } else if (action === "set" && resource === "branding") {
      validate(input, args, 0, ["input"], scope);
      await send("PUT", "/v1/admin/branding", await context.readInput(requiredOption(input, "input")));
    } else if (action === "set") {
      validate(input, args, 0, ["landing-page"], scope);
      const value = choice(input, "landing-page", ["enabled", "disabled"]);
      await send("PUT", "/v1/admin/site", { landingPageEnabled: value === "enabled" });
    } else {
      throw usage(resource === "branding" ? "admin branding get|set --input <branding.json>" : "admin site get|set --landing-page enabled|disabled");
    }
  } else if (resource === "registration") {
    if (action === "get") {
      validate(input, args, 0, [], scope);
      await send("GET", "/v1/admin/registration");
    } else if (action === "set") {
      validate(input, args, 0, ["mode"], scope);
      await send("PUT", "/v1/admin/registration", { mode: choice(input, "mode", registrationModes) });
    } else if (action === "invite") {
      validate(input, args, 0, ["email", "name"], scope);
      const email = emailOption(input, "email");
      const name = textOption(input, "name", 120);
      await send("POST", "/v1/admin/registration/invitations", { email, ...(name === undefined ? {} : { name }) });
    } else {
      throw usage("admin registration get|set --mode <mode>|invite --email <email>");
    }
  } else if (resource === "providers") {
    if (action === "list") {
      validate(input, args, 0, [], scope);
      await send("GET", "/v1/admin/providers");
    } else if (action === "set") {
      validate(input, args, 1, ["input"], scope);
      const key = identifier(args[0], "provider-key", /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
      const body = await context.readInput(requiredOption(input, "input"));
      if (containsSecretKey(body)) throw new Error("Provider secrets are not accepted in --input; configure them through the deployment secret store.");
      await send("PUT", `/v1/admin/providers/${key}`, body);
    } else {
      throw usage("admin providers list|set <provider-key> --input <provider.json>");
    }
  } else if (resource === "users") {
    if (action === "list") {
      validate(input, args, 0, [], scope);
      await send("GET", "/v1/admin/users");
    } else if (action === "action") {
      validate(input, args, 1, ["action", "reason"], scope);
      const id = identifier(args[0], "user-id", /^[A-Za-z0-9-]{1,128}$/);
      const userAction = choice(input, "action", userActions);
      const reason = textOption(input, "reason", 1000);
      await send("POST", `/v1/admin/users/${id}/actions`, { action: userAction, ...(reason === undefined ? {} : { reason }) });
    } else if (action === "roles") {
      validate(input, args, 1, ["role", "reason"], scope, ["role"]);
      const id = identifier(args[0], "user-id", /^[A-Za-z0-9-]{1,128}$/);
      const raw = input.options.role;
      const roles = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      if (roles.length === 0) throw new Error("--role is required; repeat it for each role the user should hold.");
      for (const role of roles) {
        if (typeof role !== "string" || !userRoles.includes(role)) throw new Error(`--role must be ${userRoles.join(", ")}.`);
      }
      const reason = textOption(input, "reason", 1000);
      await send("PUT", `/v1/admin/users/${id}/roles`, { roles, ...(reason === undefined ? {} : { reason }) });
    } else {
      throw usage("admin users list|action <user-id> --action <action>|roles <user-id> --role <role>");
    }
  } else if (action === "list") {
    validate(input, args, 0, [], scope);
    await send("GET", "/v1/admin/api-tokens");
  } else if (action === "revoke") {
    validate(input, args, 1, [], scope);
    await send("DELETE", `/v1/admin/api-tokens/${identifier(args[0], "token-id", /^[A-Za-z0-9-]{1,128}$/)}`);
  } else {
    throw usage("admin tokens list|revoke <token-id>");
  }
}

async function newPassword(context: ParityCommandContext): Promise<string> {
  const password = await requiredSecret(context, "New password: ");
  if (password !== await context.secret("Confirm new password: ")) throw new Error("The new password and confirmation do not match.");
  return password;
}

async function requiredSecret(context: ParityCommandContext, label: string, trim = false): Promise<string> {
  const raw = await context.secret(label);
  const value = trim ? raw.trim() : raw;
  if (!value) throw new Error(`${label.replace(/:\s*$/, "")} is required.`);
  return value;
}

/**
 * Creates the private output file before any prompt or request, so one-time
 * secrets cannot be lost to an existing path or an unwritable directory. A failed
 * step removes only the file this call created; a lost write after the API
 * accepted the request is reported with `lostMessage`, never retried.
 */
async function withReservedOutput(
  output: string,
  action: () => Promise<Record<string, unknown>>,
  lostMessage: string,
): Promise<Record<string, unknown>> {
  const file = path.resolve(output);
  let handle: FileHandle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error("The --output path already exists. Choose a new file; existing files are not replaced.");
    if (code === "ENOENT" || code === "ENOTDIR") throw new Error("The --output directory must already exist.");
    throw new Error("The --output file could not be created. Choose a writable location.");
  }
  let reserved: { dev: number; ino: number };
  try {
    reserved = await handle.stat();
  } catch {
    // Without its identity the file cannot be proven ours, so it is left in place.
    await handle.close().catch(() => undefined);
    throw new Error("The --output file could not be created. Choose a writable location.");
  }
  let result: Record<string, unknown>;
  try {
    result = await action();
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (await isSameFile(file, reserved)) await unlink(file).catch(() => undefined);
    throw error;
  }
  let saved = false;
  try {
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8");
    await handle.sync();
    saved = await isSameFile(file, reserved);
  } catch {
    saved = false;
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (!saved) throw new Error(lostMessage);
  return result;
}

async function isSameFile(file: string, reserved: { dev: number; ino: number }): Promise<boolean> {
  const current = await lstat(file).catch(() => undefined);
  return Boolean(current?.isFile() && current.dev === reserved.dev && current.ino === reserved.ino);
}

function containsSecretKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => providerSecretKeyPattern.test(key) || containsSecretKey(item));
}

function validate(input: ParityCommandInput, args: string[], count: number, allowed: string[] = [], scope = `${input.command} ${input.args[0] ?? ""}`.trim(), repeatable: string[] = []): void {
  for (const key of Object.keys(input.options)) {
    if (globalOptions.has(key) || allowed.includes(key)) continue;
    if (secretOptionPattern.test(key)) throw new Error(`--${key} is not accepted; secrets are read from a hidden prompt.`);
    throw new Error(`Unsupported option --${key} for ${scope}.`);
  }
  if (args.length !== count) throw new Error(`Usage: myskills ${scope} requires ${count} argument${count === 1 ? "" : "s"}. See myskills help.`);
  for (const key of allowed) if (!repeatable.includes(key)) option(input, key);
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

function textOption(input: ParityCommandInput, key: string, max: number): string | undefined {
  const value = option(input, key);
  if (value !== undefined && value.length > max) throw new Error(`--${key} must be at most ${max} characters.`);
  return value;
}

function emailOption(input: ParityCommandInput, key: string): string {
  const email = requiredOption(input, key).trim();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Invalid --${key}.`);
  return email;
}

function choice(input: ParityCommandInput, key: string, allowed: string[]): string {
  const value = requiredOption(input, key);
  if (!allowed.includes(value)) throw new Error(`--${key} must be ${allowed.join(", ")}.`);
  return value;
}

function identifier(value: string | undefined, label: string, pattern: RegExp): string {
  if (!value || !pattern.test(value)) throw new Error(`Invalid ${label}; use an identifier from the API response.`);
  return encodeURIComponent(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function usage(text: string): Error {
  return new Error(`Usage: myskills ${text}`);
}
