import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

type ContextKey = "targetId" | "planId" | "runId" | "operationId";
interface HandoffAction {
  actionId: string;
  capabilityIds: readonly string[];
  kind: "trusted_browser" | "local_executor";
  path?: string;
  contextKeys: readonly ContextKey[];
  instructions: readonly string[];
  readbackActionIds: readonly string[];
  cliReadback?: readonly string[];
}

const browser = (actionId: string, capabilityId: string, path: string, instructions: string[], readbackActionId = "account.identity.get"): HandoffAction => ({
  actionId, capabilityIds: [capabilityId], kind: "trusted_browser", path,
  contextKeys: [], instructions, readbackActionIds: [readbackActionId],
});
const local = (actionId: string, capabilityId: string, contextKeys: ContextKey[], instructions: string[], readbackActionIds: string[], cliReadback: string[] = []): HandoffAction => ({
  actionId, capabilityIds: [capabilityId], kind: "local_executor", contextKeys, instructions, readbackActionIds, cliReadback,
});
const companionInstructions = [
  "On the enrolled machine, inspect the target and requested operation, then run myskills companion run-once --workspace <absolute-dir> --holder <id> using its existing locally stored executor API token.",
  "The executor needs targets:execute and skills:read; library-bound skills also need libraries:read. Keep the token in the existing local credential store, outside chat.",
  "The companion must obtain its actual lease and fencing token, verify the exact planned package, perform the authorized filesystem action and report its own receipt. Do not submit invented state or receipts from an MCP connection.",
];

/** Guidance boundaries, not action implementations or claims of brokered completion. */
export const APPLICATION_HANDOFF_ACTIONS: readonly HandoffAction[] = [
  browser("account.github.connect", "GIT-01", "/settings", [
    "Connect GitHub directly in trusted MySkills Settings. Complete GitHub consent in the same signed-in browser session; do not paste credentials, authorization codes or callback URLs into chat.",
    "Inspect account_github_get after the trusted flow finishes. A navigation link or a connected MySkills MCP session does not establish a GitHub connection.",
  ], "account.github.get"),
  browser("admin.github.configure", "GIT-02", "/admin", [
    "As an MFA-verified administrator, configure the GitHub App directly in trusted MySkills Admin settings. Keep the client secret and private key in that trusted form and outside chat.",
    "Inspect admin_github_get and, when authorized, admin_github_test. Configured credentials alone do not prove a user's GitHub account has connected.",
  ], "admin.github.get"),
  browser("account.register", "ACC-01", "/auth/register", [
    "Use the trusted MySkills registration page when you have an invitation. For open/request registration, use myskills account register --email <email> in your terminal; it prompts privately for a password and optional invitation token.",
    "The instance registration policy decides whether access is granted, requested or unavailable. Follow the account verification message directly.",
  ]),
  browser("account.login", "ACC-02", "/login", [
    "Sign in directly to the trusted MySkills page, or run myskills login in your terminal. Enter the password and any MFA or recovery code only there.",
    "To connect an AI host, resume that host's OAuth authorization and approve the actual requested scopes in MySkills. A browser sign-in does not by itself connect the host.",
  ]),
  browser("account.mfa.verify", "ACC-02", "/login", [
    "Complete the pending MFA challenge in the trusted MySkills sign-in page or the private prompt from myskills login. A code is valid only with its real password-authenticated challenge.",
  ]),
  browser("account.logout", "ACC-02", "/settings", [
    "Use Sign out in the trusted MySkills app or run myskills logout for the selected CLI session.",
    "Browser logout does not revoke an OAuth connection. Use connections_revoke for an authorized connection, then verify that its subsequent requests are denied. CLI API-token logout clears local storage; token revocation is a separate action.",
  ]),
  browser("account.email_verification.request", "ACC-04", "/login", [
    "Run myskills account verify-email-request --email <email> in your terminal, then follow the verification message in your trusted mail/browser. The response does not disclose whether an account exists.",
  ]),
  browser("account.email_verification.confirm", "ACC-04", "/auth/verify-email", [
    "Open the actual verification link from MySkills directly in your browser, or run myskills account verify-email and enter the emailed token only at its private terminal prompt. This navigation link contains no verification token and cannot confirm the account by itself.",
  ]),
  browser("account.password_reset.request", "ACC-05", "/auth/reset-password", [
    "Request a reset from the trusted sign-in page or run myskills account password-reset-request --email <email>. Follow the reset message directly; a generic request response does not prove an account exists or a password changed.",
  ]),
  browser("account.password_reset.confirm", "ACC-05", "/auth/reset-password", [
    "Open the real reset link directly from your trusted mail, or run myskills account password-reset and enter the reset token and new password at its private prompts. This navigation link contains no reset token.",
  ]),
  browser("account.password.change", "ACC-06", "/settings", [
    "Change the password directly in trusted MySkills Settings, or run myskills account change-password and use its private current/new password prompts. Never paste a password into chat.",
    "The account flow may revoke current sessions or connections. Sign in again and reconnect as required after it confirms the change.",
  ]),
  browser("account.email_change.request", "ACC-06", "/settings", [
    "Request the new address in trusted MySkills Settings, or run myskills account change-email --email <new-email> and enter the current password only at its private prompt. Complete the actual email confirmation message directly.",
  ]),
  browser("account.email_change.confirm", "ACC-06", "/auth/change-email", [
    "Open the real email-change link directly from your trusted mail, or run myskills account confirm-email-change and enter its token at the private prompt. This navigation link carries no token and cannot confirm the change alone.",
  ]),
  browser("account.mfa.enroll", "ACC-07", "/settings", [
    "Start MFA setup directly in trusted MySkills Settings. Alternatively run myskills account mfa-enroll --output <new-private-file>; the CLI prompts for your password and writes the setup material to a new private file.",
    "Add the actual setup secret to your authenticator locally. Enrollment alone does not enable MFA; finish the confirmation step. Keep setup secrets and recovery codes outside chat.",
  ], "account.mfa.status"),
  browser("account.mfa.confirm", "ACC-07", "/settings", [
    "Finish the pending setup in trusted MySkills Settings, or run myskills account mfa-confirm <factor-id> --output <new-private-file> and enter the authenticator code at its private prompt.",
    "Store the returned recovery codes privately. They are shown once; do not repeat confirmation to recover them or paste them into chat. Check MFA status after the trusted flow confirms success.",
  ], "account.mfa.status"),
  browser("account.mfa.remove", "ACC-07", "/settings", [
    "Remove MFA directly in trusted MySkills Settings, or run myskills account mfa-disable and enter the current password at its private prompt. The existing service still requires the appropriate session and MFA assurance.",
  ], "account.mfa.status"),
  browser("account.tokens.create", "ACC-08", "/settings", [
    "Create the API token directly in trusted MySkills Settings with only the needed scopes and expiry. Complete MFA when required. Save the newly issued token in the intended local credential store without sending it to chat.",
    "Readback may confirm the new token's safe metadata but cannot recover its secret. Never create another token merely because the first response was uncertain; inspect the token list first.",
  ], "account.tokens.list"),
  local("targets.observations.report", "TGT-04", ["targetId"], [
    "On the actual target machine, use myskills architectures observe --root <absolute-dir> --profile <personal|work|shared> --context <file> with the real enrolled target context.",
    "Inspect the generated observation and use the existing authenticated local reporting flow. Do not upload guessed filesystem state or imply that an observation proves the host loaded a skill.",
  ], ["targets.observations.list", "targets.get"]),
  local("targets.health.report", "TGT-05", ["targetId"], [
    "On the actual target machine, use myskills architectures health --root <absolute-dir> --profile <personal|work|shared> --context <file> with the real enrolled target context.",
    "Report only actual checks through the existing authenticated local reporting flow. Do not infer host recognition from an API response or an observation alone.",
  ], ["targets.get"]),
  local("improvements.runs.create", "IMP-07", ["planId", "runId"], [
    "Inspect the immutable registry plan, then on the execution machine run myskills improve fetch --plan <plan-id> --output <new-job-dir>. Review its pinned inputs, model, budget and local execution policy.",
    "After explicit local consent, run myskills improve run --job <dir> --accept-plan <sha256> --allow-cloud. The local runner must declare its actual controls and create/report its own run; this handoff starts nothing and does not authorize cloud execution.",
  ], ["improvements.plans.get", "improvements.runs.get"]),
  local("improvements.runs.events.append", "IMP-07", ["planId", "runId"], [
    "Let the existing authorized local improvement runner append its actual sequenced execution events and digest-bound report. Inspect myskills improve report --job <dir> locally and compare myskills improve status --run <id>.",
    "Do not fabricate events, runner capabilities, model verification or evaluation results. An unconfirmed registry sync is not a completed upload; resolve it from actual runner evidence and registry readback.",
  ], ["improvements.runs.get", "improvements.plans.get"]),
  ...["target_executor.claim", "target_executor.state.report", "target_executor.receipt.report"].map((actionId) => local(
    actionId, "TGT-13", ["targetId", "operationId"], companionInstructions, ["target_operations.get", "targets.operations.list"],
  )),
  local("local.skills.author", "LOC-01", [], [
    "Use user-chosen source and output paths on the local machine. Scaffold with myskills init <name> --output <new-skill-directory>; edit the created skill.json and SKILL.md locally. The destination must be new and its parent must already exist.",
    "Run myskills validate --path <skill-directory> and myskills scan --path <skill-directory>, inspect the findings, then run myskills package --path <skill-directory> --output <new-package.zip>. These commands do not submit or publish the package.",
    "Validate and scan the actual resulting archive and inspect its files. Passing a scan does not prove the skill is safe for every use or installed in a host.",
  ], [], ["myskills validate --path <user-chosen-package.zip>", "myskills scan --path <user-chosen-package.zip>"]),
  local("local.skills.manage", "LOC-02", [], [
    "Select the authorized skill, exact release, platform and user-chosen destination. Export with myskills export <slug> --version <version> --platform <platform> --output <new-directory>, or install with myskills install <slug> --version <version> --platform <platform> --dir <install-root>.",
    "Inspect installed state with myskills list --dir <install-root> --json and available changes with myskills updates <slug> --dir <install-root> --json. Preview myskills update <slug> --dir <install-root> --dry-run before applying it without --dry-run; acknowledge required user action only after reviewing it.",
    "Use myskills rollback <slug> --dir <install-root> only for the existing recorded previous installation. For an enrolled Codex workspace, use its explicit --workspace <absolute-directory> instead of --dir for supported install/list/update/rollback commands; preserve the workspace binding.",
    "Inspect the actual resulting files and version after the CLI finishes. CLI installation metadata and filesystem verification do not alone prove that a host loaded the skill.",
  ], [], ["myskills list --dir <user-chosen-install-root> --json", "myskills updates <slug> --dir <user-chosen-install-root> --json"]),
  local("local.workspace.bootstrap", "LOC-03", [], [
    "Use user-chosen roots and the real enrolled context. Inspect myskills architectures observe --root <absolute-directory> --profile <personal|work|shared> --context <context-file> and myskills architectures health --root <absolute-directory> --profile <personal|work|shared> --context <context-file>.",
    "The existing Codex bootstrap planner supports a real work-profile context: myskills bootstrap codex --dry-run --profile work --context <context-file> --work-source-root <source-directory> --live-root <live-directory> --include-slug <slug> --output <new-report.json>. Use a supplied shared source root instead where appropriate; never invent a work context or derive one from personal files.",
    "Bootstrap is a dry-run-only plan and does not apply changes. Inspect the actual report, source identities, destination and selected slugs; no apply command or remote filesystem endpoint is implied.",
  ], [], ["myskills architectures observe --root <user-chosen-absolute-directory> --profile <personal|work|shared> --context <context-file> --json", "myskills architectures health --root <user-chosen-absolute-directory> --profile <personal|work|shared> --context <context-file> --json"]),
  local("local.improvements.artifacts", "LOC-04", [], [
    "Use user-chosen source, reviewer, job and export directories. Create a local plan with myskills improve plan --path <skill-directory> --reviewer <reviewer-directory> --output <new-job-directory> --model <exact-model-id> --goal <goal> --target-version <version>; review its pinned inputs, budgets and inference policy.",
    "After explicit local execution and cloud consent, run myskills improve run --job <job-directory> --accept-plan <sha256> --allow-cloud. This handoff does not grant that consent or start a run.",
    "Inspect myskills improve report --job <job-directory> --json. Export an eligible actual candidate with myskills improve export --job <job-directory> --output <new-draft-directory>, then validate and scan that directory. Export creates a draft and does not publish or install it.",
    "Preserve actual model verification, test results and report state. A local evaluation result does not establish independent relevance or deployed performance.",
  ], [], ["myskills improve report --job <user-chosen-job-directory> --json", "myskills validate --path <user-chosen-export-directory>", "myskills scan --path <user-chosen-export-directory>"]),
  local("local.library.detach", "LOC-05", [], [
    "Choose the installed skill and its user-chosen install root. Inspect myskills list --dir <install-root> --json, then run myskills libraries unbind-local <slug> --dir <install-root> to detach only its local adoption tracking.",
    "For an enrolled Codex workspace, use the explicit --workspace <absolute-directory> form instead of --dir. This command preserves installed files; it does not uninstall the skill, delete a library entry, or revoke a remote target binding.",
    "Inspect the command's actual libraryEntryId:null and filesChanged:false result, then read the installation list again and verify the installed bytes remain unchanged. The handoff has performed none of these checks.",
  ], [], ["myskills list --dir <user-chosen-install-root> --json"]),
];

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const inputSchema = z.object({
  actionId: z.enum(APPLICATION_HANDOFF_ACTIONS.map((action) => action.actionId) as [string, ...string[]]),
  targetId: identifier.optional(), planId: identifier.optional(), runId: identifier.optional(), operationId: identifier.optional(),
}).strict();
const readbacks: Record<string, { route: string; contextKey?: ContextKey }> = {
  "account.github.get": { route: "/v1/account/github" },
  "admin.github.get": { route: "/v1/admin/github" },
  "account.identity.get": { route: "/v1/me" },
  "account.mfa.status": { route: "/v1/auth/mfa" },
  "account.tokens.list": { route: "/v1/auth/api-tokens" },
  "targets.observations.list": { route: "/v1/architecture-targets/:id/observations", contextKey: "targetId" },
  "targets.get": { route: "/v1/architecture-targets/:id", contextKey: "targetId" },
  "targets.operations.list": { route: "/v1/architecture-targets/:id/operations", contextKey: "targetId" },
  "target_operations.get": { route: "/v1/target-operations/:id", contextKey: "operationId" },
  "improvements.plans.get": { route: "/v1/improvements/plans/:id", contextKey: "planId" },
  "improvements.runs.get": { route: "/v1/improvements/runs/:id", contextKey: "runId" },
};

export interface ApplicationHandoffOptions {
  /** Trusted operator configuration only; never derive this from Host, an API URL or tool input. */
  appBaseUrl?: string;
}

export function createApplicationHandoff(input: unknown, options: ApplicationHandoffOptions = {}) {
  const origin = trustedOrigin(options.appBaseUrl);
  const parsed = inputSchema.safeParse(input);
  const invalidInput = () => new Error("Choose a supported handoff action and only its bounded resource identifiers.");
  if (!parsed.success) throw invalidInput();
  const action = APPLICATION_HANDOFF_ACTIONS.find((candidate) => candidate.actionId === parsed.data.actionId);
  if (!action) throw invalidInput();
  const context = parsed.data;
  for (const key of ["targetId", "planId", "runId", "operationId"] as const) {
    if (context[key] !== undefined && !action.contextKeys.includes(key)) throw invalidInput();
  }
  const destination: { surface: "browser" | "local_cli"; navigation: string; path?: string; url?: string } = action.kind === "trusted_browser"
    ? { surface: "browser", navigation: `Open your trusted MySkills app and navigate to ${action.path}. If the page needs an emailed token, use the real emailed link or the private CLI prompt.`, path: action.path, ...(origin ? { url: `${origin}${action.path}` } : {}) }
    : { surface: "local_cli", navigation: "Use the existing MySkills CLI on the actual execution machine with its configured endpoint, locally stored credentials and explicit local consent." };
  return {
    actionId: action.actionId,
    capabilityIds: [...action.capabilityIds],
    status: "action_required" as const,
    performed: false as const,
    kind: action.kind,
    destination,
    instructions: [
      ...action.instructions,
      ...(action.kind === "trusted_browser" ? ["Enter passwords, verification tokens, MFA codes and recovery codes directly into trusted browser or private terminal controls, never into chat or tool arguments."] : []),
    ],
    readback: action.readbackActionIds.map((actionId) => {
      const definition = readbacks[actionId]!;
      const id = definition.contextKey ? context[definition.contextKey] : undefined;
      return {
        actionId, toolName: actionId.replaceAll(".", "_"), method: "GET" as const,
        route: definition.route,
        ...(definition.contextKey ? id ? { endpoint: definition.route.replace(":id", encodeURIComponent(id)) } : { needs: definition.contextKey } : { endpoint: definition.route }),
        performed: false as const,
        note: "Run only with authorized credentials. This is a suggested readback, not fetched or verified state.",
      };
    }),
    cliReadback: (action.cliReadback ?? []).map((command) => ({
      command,
      performed: false as const,
      note: "This is a suggested local readback, not executed here. Replace placeholders with user-chosen paths and inspect actual CLI results and files.",
    })),
    completion: {
      confirmed: false as const,
      requiredEvidence: action.kind === "trusted_browser"
        ? ["The trusted browser or CLI must confirm the actual action. Safe identity or status readback does not prove password replacement, email-token consumption or recovery-code storage.", "Verify any expected safe account metadata separately; reconnect if the account action revoked this connection."]
        : action.readbackActionIds.length === 0
          ? ["Use the suggested CLI readback with the exact user-chosen paths and inspect the actual resulting files, package, local registry or report. No API route represents these local filesystem outcomes.", "Record only the operation actually completed. Draft export, dry-run planning, installed metadata, filesystem verification and host recognition are separate results."]
        : ["Read back the actual operation/run and its exact digest-bound result from the API after the local producer reports it.", "Require the real local observation, runner report or fenced executor receipt; filesystem verification and host recognition remain separate evidence. Queued, running or unconfirmed state is not completion."],
    },
  };
}

export function registerApplicationHandoffTools(server: McpServer, options: ApplicationHandoffOptions = {}): void {
  trustedOrigin(options.appBaseUrl);
  server.registerTool("application_handoff", {
    title: "Get Trusted Application Handoff",
    description: "Get instructions for an existing account-security or local-execution action that must happen in trusted browser/CLI controls. Returns guidance and suggested readback only; never signs in, changes credentials, runs commands, uploads evidence or claims completion. Do not include secrets.",
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try {
      const result = createApplicationHandoff(input, options);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "Choose a supported handoff action and only its bounded resource identifiers. No action was performed." }] };
    }
  });
}

function trustedOrigin(value: string | undefined): string | null {
  if (value === undefined) return null;
  const invalid = () => new Error("Configure a trusted MySkills app origin using HTTPS or loopback HTTP.");
  if (typeof value !== "string" || /[\\?#@\u0000-\u0020\u007f]/.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw invalid();
  return url.origin;
}
