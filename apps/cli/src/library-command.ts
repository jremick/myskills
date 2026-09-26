/** Explicit library command routing. Payloads use the documented API schema so
 * previews, artifact attestations and mutation IDs remain inspectable/replayable. */
export interface LibraryCommandRequest { method: string; pathname: string; payload?: Record<string, unknown> }
interface Action { method: string; route: string; input?: "required" | "optional"; kind?: "source" | "skill" }
const actions: Record<string, Action> = {
  list: { method: "GET", route: "/libraries" },
  create: { method: "POST", route: "/libraries", input: "required" },
  show: { method: "GET", route: "/libraries/:id" },
  edit: { method: "PATCH", route: "/libraries/:id", input: "required" },
  remove: { method: "DELETE", route: "/libraries/:id" },
  entries: { method: "GET", route: "/libraries/:id/entries" },
  "add-source": { method: "POST", route: "/libraries/:id/entries", input: "required", kind: "source" },
  "add-skill": { method: "POST", route: "/libraries/:id/entries", input: "required", kind: "skill" },
  entry: { method: "GET", route: "/library-entries/:id" },
  "remove-entry": { method: "DELETE", route: "/library-entries/:id" },
  discover: { method: "POST", route: "/library-entries/:id/discoveries" },
  preview: { method: "POST", route: "/library-entries/:id/previews", input: "required" },
  candidates: { method: "GET", route: "/library-entries/:id/candidates" },
  candidate: { method: "GET", route: "/library-candidates/:id" },
  import: { method: "POST", route: "/library-candidates/:id/import", input: "required" },
  ignore: { method: "POST", route: "/library-candidates/:id/ignore" },
  "self-review": { method: "POST", route: "/library-candidates/:id/self-review", input: "required" },
  "request-review": { method: "POST", route: "/library-candidates/:id/instance-review-requests" },
  adopt: { method: "POST", route: "/library-entries/:id/adoptions", input: "required" },
  adoptions: { method: "GET", route: "/library-entries/:id/adoptions" },
  resolve: { method: "GET", route: "/library-entries/:id/resolution" },
  tracking: { method: "PATCH", route: "/library-entries/:id/tracking", input: "required" },
  check: { method: "POST", route: "/library-entries/:id/checks" },
  subscribe: { method: "PUT", route: "/libraries/:id/subscription", input: "optional" },
  unsubscribe: { method: "DELETE", route: "/libraries/:id/subscription" },
  inbox: { method: "GET", route: "/library-inbox" },
  "mark-read": { method: "POST", route: "/library-inbox/read", input: "required" },
  bindings: { method: "GET", route: "/library-entries/:id/bindings" },
  bind: { method: "POST", route: "/library-entries/:id/bindings", input: "required" },
  detach: { method: "DELETE", route: "/library-bindings/:id" },
  settings: { method: "GET", route: "/admin/library-settings" },
  "set-settings": { method: "PUT", route: "/admin/library-settings", input: "required" },
  "review-requests": { method: "GET", route: "/review/self-reviewed-releases" },
  "review-bundle": { method: "GET", route: "/review/self-reviewed-releases/:id/bundle" },
  elevate: { method: "POST", route: "/review/self-reviewed-releases/:id/elevate", input: "required" },
};

export const libraryCommandHelp = [
  "myskills libraries <action> [id] [--input <request.json>] [--json]",
  "Collect: list, create, show, edit, remove, entries, add-source, add-skill, entry, remove-entry",
  "Import: discover, preview, candidates, candidate, import, self-review, request-review, ignore",
  "Curate: adopt, adoptions, resolve, tracking, check, subscribe, unsubscribe, inbox, mark-read",
  "Targets: bindings, bind, detach. Admin: settings, set-settings, review-requests, review-bundle, elevate",
  "bind, detach and set-settings require an MFA-verified myskills login session; API tokens cannot perform these actions.",
  "List pagination: --cursor <cursor> --limit <1-100>. Remove library: --revision <current revision>.",
  "Writes with a body require a reviewed JSON file. Preserve clientMutationId when retrying creation/import.",
  "review-bundle <submission-id> [--artifact-sha256 <review-request-digest>] [--output <new-file>] verifies the response hash and, when supplied, the review request digest. --output keeps exact verified bytes.",
  "Detach a local adoption: libraries unbind-local <slug> --dir <install-root>. Files remain unchanged.",
  "Install an adoption: myskills install <slug> --library-entry <entry-id>. Add --accept-user-action only after reading notes for a release that requires it.",
  "Scopes: API tokens need libraries:read to read libraries and to install, update or run the companion for library-bound skills; libraries:write to change them.",
].join("\n");

export function libraryCommandRequest(actionName: string, reference: string | undefined, options: Record<string, string | boolean | string[]>, payload?: Record<string, unknown>): LibraryCommandRequest {
  const action = actions[actionName];
  if (!action) throw new Error(libraryCommandHelp);
  if (action.route.includes(":id") && (!reference || reference.length > 128 || !/^[A-Za-z0-9_-]+$/.test(reference))) throw new Error("This library command needs a valid resource ID.");
  if (action.input === "required" && !payload) throw new Error("Provide the reviewed request body with --input <request.json>.");
  if (!action.input && payload) throw new Error("This library command does not accept a request body.");
  if (action.kind && payload?.kind !== undefined && payload.kind !== action.kind) throw new Error("The entry kind does not match the command.");
  const query = new URLSearchParams();
  for (const key of ["cursor", "limit"]) {
    const value = options[key];
    if (value !== undefined) {
      if (action.method !== "GET" || typeof value !== "string") throw new Error(`--${key} requires a value on a read command.`);
      if (key === "limit" && (!/^\d+$/.test(value) || +value < 1 || +value > 100)) throw new Error("--limit must be 1–100.");
      query.set(key, value);
    }
  }
  if (actionName === "candidate") query.set("includeContent", "true");
  if (actionName === "remove") {
    if (typeof options.revision !== "string" || !/^[1-9]\d*$/.test(options.revision)) throw new Error("Deleting a library requires --revision <current revision>.");
    query.set("expectedRevision", options.revision);
  }
  const suffix = query.size ? `?${query}` : "";
  return {
    method: action.method,
    pathname: `/v1${action.route.replace(":id", encodeURIComponent(reference ?? ""))}${suffix}`,
    ...(payload ? { payload: { ...payload, ...(action.kind ? { kind: action.kind } : {}) } } : action.input === "optional" ? { payload: {} } : {}),
  };
}
