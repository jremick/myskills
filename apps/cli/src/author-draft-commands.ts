import { parseSkillReleaseMetadata } from "@myskills-app/core";
import { MAX_PACKAGE_ARCHIVE_BYTES, MAX_PACKAGE_FILES, MAX_PACKAGE_TEXT_BYTES, validatePackageFiles } from "@myskills-app/skill-package";
import type { ParityCommandContext, ParityCommandInput } from "./parity-types.js";

export const authorDraftHelp = [
  "  drafts list",
  "  drafts history <draft-id>",
  "  drafts show <draft-id> [--revision <number>] [--output <file>]",
  "  drafts create|preview --input <json-file>",
  "  drafts save <draft-id> --input <json-file>",
  "  drafts validate <draft-id> --revision <number>",
  "  drafts submit <draft-id> --revision <number> | --input <json-file>",
];

/** Draft errors are untrusted; retain known diagnostics without package content. */
export const authorDraftApiErrorCodes = new Set([
  "DRAFT_NOT_FOUND", "DRAFT_REVISION_CONFLICT", "INVALID_DRAFT_INPUT", "DRAFT_LIMIT", "DRAFT_HISTORY_LIMIT",
  "DRAFT_SERVICE_UNAVAILABLE", "DRAFT_SOURCE_NOT_FOUND", "DRAFT_ALREADY_SUBMITTED", "DRAFT_DIGEST_MISMATCH", "DRAFT_SUBMISSION_UNAVAILABLE",
  "API_TOKEN_SCOPE_REQUIRED", "AUTHENTICATION_REQUIRED", "MFA_VERIFICATION_REQUIRED", "AUTHOR_ROLE_REQUIRED",
  "SUBMISSION_NOT_FOUND", "SUBMISSION_ROLE_REQUIRED", "SKILL_NOT_FOUND", "PACKAGE_FILES_REQUIRED", "INVALID_PACKAGE_PAYLOAD", "PACKAGE_SCAN_BLOCKED", "PACKAGE_MANIFEST_MISMATCH", "SHARING_DISABLED", "OAUTH_TOKEN_NOT_ALLOWED",
  "PACKAGE_MANIFEST_REQUIRED", "PACKAGE_MANIFEST_AMBIGUOUS", "INVALID_PACKAGE_MANIFEST", "PACKAGE_VERSION_EXISTS", "PACKAGE_SLUG_UNAVAILABLE", "PACKAGE_VISIBILITY_MISMATCH",
]);

const globalOptions = new Set(["api-url", "token", "json"]);

/** API-owned private draft operations. No local package content is executed. */
export async function runAuthorDraftCommand(input: ParityCommandInput, context: ParityCommandContext): Promise<boolean> {
  if (input.command !== "drafts") return false;
  const [action, ...args] = input.args;
  const send = async (method: Parameters<ParityCommandContext["request"]>[0], endpoint: string, body?: unknown) => context.output(await context.request(method, endpoint, body));
  if (!action || action === "help") {
    validate(input, args, 0);
    context.output({ usage: authorDraftHelp.map(line => line.trim()), input: "Create with {title,files} or {title?,source}; save with {expectedRevision,title,files}; preview with {files} or {archive}; submit with {expectedRevision,release?}. The API enforces author, scope, MFA, ownership and revision policy." });
  } else if (action === "list") {
    validate(input, args, 0);
    await send("GET", "/v1/drafts");
  } else if (action === "show" || action === "history") {
    validate(input, args, 1, action === "show" ? ["revision", "output"] : []);
    const endpoint = `/v1/drafts/${identifier(args[0])}`;
    const revision = option(input, "revision");
    const result = await context.request("GET", action === "history" ? `${endpoint}/history` : revision === undefined ? endpoint : `${endpoint}/revisions/${revisionNumber(revision)}`);
    const output = option(input, "output");
    if (output) { await context.writeOutput(output, `${JSON.stringify(result, null, 2)}\n`); context.output({ output }); }
    else context.output(result);
  } else if (action === "create" || action === "preview" || action === "save") {
    validate(input, args, action === "save" ? 1 : 0, ["input"]);
    const endpoint = action === "save" ? `/v1/drafts/${identifier(args[0])}` : action === "preview" ? "/v1/drafts/preview" : "/v1/drafts";
    const body = await context.readInput(requiredOption(input, "input"));
    if (action === "save") {
      exactFields(body, ["expectedRevision", "title", "files"]);
      expectedRevision(body.expectedRevision); title(body.title); packageFiles(body.files);
    } else if (action === "preview") {
      if (Object.hasOwn(body, "files")) { exactFields(body, ["files"]); packageFiles(body.files); }
      else { exactFields(body, ["archive"]); archive(body.archive); }
    } else if (Object.hasOwn(body, "source")) {
      exactFields(body, ["title", "source"]);
      if (body.title !== undefined) title(body.title);
      source(body.source);
    } else {
      exactFields(body, ["title", "files"]); title(body.title); packageFiles(body.files);
    }
    await send(action === "save" ? "PUT" : "POST", endpoint, body);
  } else if (action === "validate" || action === "submit") {
    validate(input, args, 1, action === "submit" ? ["revision", "input"] : ["revision"]);
    const endpoint = `/v1/drafts/${identifier(args[0])}/${action}`;
    const filename = option(input, "input");
    const revision = option(input, "revision");
    if (filename !== undefined && revision !== undefined) throw new Error("Use --input or --revision, not both.");
    const body = filename === undefined ? { expectedRevision: revisionNumber(requiredOption(input, "revision")) } : await context.readInput(filename);
    exactFields(body, action === "submit" ? ["expectedRevision", "release"] : ["expectedRevision"]);
    expectedRevision(body.expectedRevision);
    if ("release" in body) {
      try { parseSkillReleaseMetadata(body.release); } catch { throw new Error("Invalid draft release metadata; use the documented submission release fields."); }
    }
    await send("POST", endpoint, body);
  } else throw new Error("Unknown drafts action. See myskills drafts help.");
  return true;
}

function validate(input: ParityCommandInput, args: string[], count: number, allowed: string[] = []): void {
  if (args.length !== count) throw new Error(`Draft action requires ${count} argument${count === 1 ? "" : "s"}. See myskills drafts help.`);
  for (const key of Object.keys(input.options)) if (!globalOptions.has(key) && !allowed.includes(key)) throw new Error(`Unsupported draft option --${key}.`);
  for (const key of allowed) option(input, key);
}

function option(input: ParityCommandInput, key: string): string | undefined {
  const value = input.options[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`--${key} requires one non-empty value.`);
  return value;
}
function requiredOption(input: ParityCommandInput, key: string): string { const value = option(input, key); if (value === undefined) throw new Error(`--${key} is required.`); return value; }
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,159}$/.test(value)) throw new Error("Invalid draft or source identifier; use an identifier from the API response.");
  return encodeURIComponent(value);
}
function revisionNumber(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("Revision must be a positive safe integer.");
  return expectedRevision(Number(value));
}
function expectedRevision(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Revision must be a positive safe integer."); return value; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Draft input must contain a JSON object."); return value as Record<string, unknown>; }
function exactFields(value: Record<string, unknown>, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Draft input contains unsupported fields."); }
function title(value: unknown): void { if (typeof value !== "string" || !value.trim() || [...value].length > 120 || value.includes("\0")) throw new Error("Draft title must contain 1 to 120 characters without NUL."); }
function packageFiles(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_PACKAGE_FILES) throw new Error(`Draft files must contain at most ${MAX_PACKAGE_FILES} text files.`);
  for (const file of value) { const item = record(file); exactFields(item, ["path", "content"]); if (typeof item.path !== "string" || typeof item.content !== "string") throw new Error("Draft files require path and text content."); }
  try { validatePackageFiles(value); } catch { throw new Error(`Draft files must use safe unique package paths and valid UTF-8 text of at most ${MAX_PACKAGE_TEXT_BYTES} bytes in total.`); }
}
function archive(value: unknown): void {
  const input = record(value); exactFields(input, ["filename", "contentBase64"]);
  if (input.filename !== undefined && (typeof input.filename !== "string" || !input.filename || input.filename.length > 255 || /[\u0000-\u001f\u007f]/.test(input.filename))) throw new Error("Archive filename must contain 1 to 255 printable characters.");
  const encoded = input.contentBase64;
  if (typeof encoded !== "string" || !encoded || encoded.length > Math.ceil(MAX_PACKAGE_ARCHIVE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Archive must contain base64 ZIP bytes within the package archive limit.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_PACKAGE_ARCHIVE_BYTES || bytes.toString("base64") !== encoded) throw new Error("Archive must contain base64 ZIP bytes within the package archive limit.");
}
function source(value: unknown): void {
  const input = record(value);
  if (input.kind === "release") { exactFields(input, ["kind", "slug", "version", "platform"]); identifier(input.slug); if (typeof input.version !== "string" || !input.version || input.version.length > 128 || /[\u0000-\u001f\u007f]/.test(input.version)) throw new Error("Source release requires an exact version."); if (input.platform !== undefined) identifier(input.platform); }
  else if (input.kind === "submission") { exactFields(input, ["kind", "submissionId"]); identifier(input.submissionId); }
  else throw new Error("Draft source must be an exact release or the author's submission.");
}
