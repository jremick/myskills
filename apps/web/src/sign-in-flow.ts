export const SIGN_IN_TEXT = {
  navLabel: "Sign in",
  navAria: "Sign in navigation",
  heading: "Sign in",
  back: "Back to sign in",
  continue: "Continue to sign in",
  return: "Return to sign in",
  invitationDone: "Registration complete. You can now sign in.",
  verifyDone: "Email verified. You can sign in after your account is approved.",
  resetDone: "Password reset. You can sign in with the new password.",
  emailChanged: "Email changed. Sign in again with the new address.",
  landingHome: "Home → Sign in",
  deviceIntro: "Only approve a code shown by a CLI sign-in you started. Never enter a code sent by someone else.",
  deviceUnavailable: "Browser sign-in is unavailable.",
  deviceVerify: "Enter the password for this account, then the authenticator or recovery code.",
  deviceEnroll: "Set up MFA in Settings, then return to this page and check again.",
  signedInAs: "Signed in as",
  requestAccessLabel: "Request access",
  passwordRule: "Use at least 12 characters and at most 72 UTF-8 bytes.",
  passwordTooShort: "Use a password with at least 12 characters.",
  passwordTooLong: "Password must be at most 72 UTF-8 bytes. Non-ASCII characters can use more than one byte.",
  passwordMismatch: "Passwords do not match.",
  additionalPermission: "Additional permission",
  resetHeading: "Reset password",
  verifyHeading: "Verify email",
  changeHeading: "Confirm email change",
  savePassword: "Save password",
  confirmEmail: "Confirm email",
  confirmEmailChange: "Confirm email change",
  missingToken: "This link is missing its token.",
  invalidToken: "This link is invalid or expired.",
  resetResendHelp: "If that account exists, a password reset email is sent.",
  verifyResendHelp: "If that account can still be verified, a new message is sent.",
  changeResendHelp: "This page cannot send a new email-change link. Sign in, then request the change again from Settings. That request needs the current password.",
  sendReset: "Send reset email",
  sendVerification: "Send verification email",
  ledeWithLink: "This page signs in an account that already exists. Request access if you need an account. Approval still happens before that account can sign in.",
  ledeWithoutLink: "This page signs in an account that already exists. It does not create an account, and it does not send an invitation. Ask the person who runs this server how access works here.",
} as const;

export const PASSWORD_MIN_CHARS = 12;
export const PASSWORD_MAX_BYTES = 72;

const SCOPE_LABELS: Record<string, string> = {
  "profile:read": "Profile",
  "skills:read": "Read skills",
  "architectures:read": "Read architectures",
  "skills:submit": "Submit skills",
  "libraries:read": "Read libraries",
  "libraries:write": "Manage libraries",
  "review:read": "Review read",
  "review:write": "Review write",
  "targets:execute": "Execute target updates",
  "improvements:read": "Read improvement plans and evidence",
  "improvements:configure": "Configure improvement policies",
  "improvements:run": "Run skill improvements",
  "improvements:report": "Share and review improvement evidence",
  "account:connections:revoke": "Revoke own remote connections",
  "account:read": "Read account security metadata",
  "account:tokens:revoke": "Revoke own API keys",
  "admin:read": "Read administration settings and audit history",
  "admin:settings": "Manage instance settings",
  "admin:tokens:revoke": "Revoke administered API keys",
  "admin:users": "Manage users, roles and invitations",
  "architectures:write": "Manage architectures",
  "libraries:bind": "Bind libraries to architectures and targets",
  "organizations:read": "Read organizations",
  "organizations:write": "Manage organizations",
  "sharing:read": "Read skill sharing settings",
  "sharing:write": "Manage skill sharing",
  "skills:manage": "List managed skills",
  "submissions:read": "Read and export own submissions",
  "targets:control": "Manage targets and schedule operations",
  "targets:read": "Read targets and operations",
  "teams:read": "Read teams",
  "teams:write": "Manage teams",
};

export type RequestAccessLink = {
  href: string;
  label: typeof SIGN_IN_TEXT.requestAccessLabel;
};

export type SignInCopy = {
  navLabel: typeof SIGN_IN_TEXT.navLabel;
  navAria: typeof SIGN_IN_TEXT.navAria;
  heading: typeof SIGN_IN_TEXT.heading;
  lede: string;
  requestAccess: RequestAccessLink | null;
};

export function signInCopy(requestAccessUrl: string | undefined): SignInCopy {
  const requestAccess = requestAccessLink(requestAccessUrl);
  return {
    navLabel: SIGN_IN_TEXT.navLabel,
    navAria: SIGN_IN_TEXT.navAria,
    heading: SIGN_IN_TEXT.heading,
    lede: requestAccess ? SIGN_IN_TEXT.ledeWithLink : SIGN_IN_TEXT.ledeWithoutLink,
    requestAccess,
  };
}

function requestAccessLink(requestAccessUrl: string | undefined): RequestAccessLink | null {
  const value = requestAccessUrl?.trim() ?? "";
  if (!value || value.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return null;
  return { href: url.href, label: SIGN_IN_TEXT.requestAccessLabel };
}

export type PasswordCheck =
  | { ok: true }
  | { ok: false; message: string };

export function checkNewPassword(password: string, confirm: string): PasswordCheck {
  if (password.length < PASSWORD_MIN_CHARS) return { ok: false, message: SIGN_IN_TEXT.passwordTooShort };
  if (new TextEncoder().encode(password).byteLength > PASSWORD_MAX_BYTES) return { ok: false, message: SIGN_IN_TEXT.passwordTooLong };
  if (password !== confirm) return { ok: false, message: SIGN_IN_TEXT.passwordMismatch };
  return { ok: true };
}

// The hash is removed in this turn. The map is what a StrictMode remount reads.
const recoveryTokens = new Map<string, string>();

export function captureAuthActionToken(pathname: string): string | null {
  const fromHash = typeof window === "undefined" ? null : tokenFromHash(window.location.hash);
  if (fromHash) {
    recoveryTokens.set(pathname, fromHash);
    stripRecoveryHash();
    return fromHash;
  }
  return recoveryTokens.get(pathname) ?? null;
}

export function discardRecoveryToken(pageKey: string): void {
  recoveryTokens.delete(pageKey);
}

function tokenFromHash(hash: string): string | null {
  if (!hash) return null;
  const token = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash).get("token")?.trim() ?? "";
  return token.length > 0 ? token : null;
}

function stripRecoveryHash(): void {
  if (typeof window === "undefined" || !window.location.hash) return;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
}

export type RecoveryKind = "reset-password" | "verify-email" | "change-email";

export type CompletionPhase =
  | { kind: "absent" }
  | { kind: "form"; token: string; error: string | null }
  | { kind: "submitting"; token: string }
  | { kind: "invalid" }
  | { kind: "done" };

export type CompletionEvent =
  | { type: "submit" }
  | { type: "reject"; message: string }
  | { type: "invalid" }
  | { type: "succeed" };

export function initialCompletion(token: string | null): CompletionPhase {
  return token ? { kind: "form", token, error: null } : { kind: "absent" };
}

export function reduceCompletion(phase: CompletionPhase, event: CompletionEvent): CompletionPhase {
  if (event.type === "submit" && phase.kind === "form") return { kind: "submitting", token: phase.token };
  if (event.type === "reject" && phase.kind === "submitting") return { kind: "form", token: phase.token, error: event.message };
  if (event.type === "invalid" && phase.kind === "submitting") return { kind: "invalid" };
  if (event.type === "succeed" && phase.kind === "submitting") return { kind: "done" };
  return phase;
}

export type ResendPanel =
  | { kind: "reset_email"; help: typeof SIGN_IN_TEXT.resetResendHelp; submitLabel: typeof SIGN_IN_TEXT.sendReset }
  | { kind: "verify_email"; help: typeof SIGN_IN_TEXT.verifyResendHelp; submitLabel: typeof SIGN_IN_TEXT.sendVerification }
  | { kind: "change_email_settings"; help: typeof SIGN_IN_TEXT.changeResendHelp };

export type RecoveryNext = {
  label: typeof SIGN_IN_TEXT.continue | typeof SIGN_IN_TEXT.return;
};

export type CompletionView =
  | {
      kind: "form";
      heading: string;
      token: string;
      form: "password";
      passwordRule: typeof SIGN_IN_TEXT.passwordRule;
      submitLabel: typeof SIGN_IN_TEXT.savePassword;
      status: string | null;
      busy: boolean;
    }
  | {
      kind: "form";
      heading: string;
      token: string;
      form: "confirm";
      submitLabel: typeof SIGN_IN_TEXT.confirmEmail | typeof SIGN_IN_TEXT.confirmEmailChange;
      status: string | null;
      busy: boolean;
    }
  | {
      kind: "blocked";
      heading: string;
      status: string;
      next: RecoveryNext;
      resend: ResendPanel;
    }
  | {
      kind: "done";
      heading: string;
      status: string;
      next: RecoveryNext;
      clearLocalSession: boolean;
    };

export function completionView(kind: RecoveryKind, phase: CompletionPhase): CompletionView {
  const heading = recoveryHeading(kind);
  if (phase.kind === "form" || phase.kind === "submitting") {
    const status = phase.kind === "form" ? phase.error : null;
    const busy = phase.kind === "submitting";
    if (kind === "reset-password") {
      return { kind: "form", heading, token: phase.token, form: "password", passwordRule: SIGN_IN_TEXT.passwordRule, submitLabel: SIGN_IN_TEXT.savePassword, status, busy };
    }
    return {
      kind: "form",
      heading,
      token: phase.token,
      form: "confirm",
      submitLabel: kind === "verify-email" ? SIGN_IN_TEXT.confirmEmail : SIGN_IN_TEXT.confirmEmailChange,
      status,
      busy,
    };
  }
  if (phase.kind === "done") {
    return {
      kind: "done",
      heading,
      status: kind === "reset-password" ? SIGN_IN_TEXT.resetDone : kind === "verify-email" ? SIGN_IN_TEXT.verifyDone : SIGN_IN_TEXT.emailChanged,
      next: { label: SIGN_IN_TEXT.continue },
      clearLocalSession: kind !== "verify-email",
    };
  }
  return {
    kind: "blocked",
    heading,
    status: phase.kind === "invalid" ? SIGN_IN_TEXT.invalidToken : SIGN_IN_TEXT.missingToken,
    next: { label: SIGN_IN_TEXT.return },
    resend: resendPanel(kind),
  };
}

function recoveryHeading(kind: RecoveryKind): string {
  if (kind === "reset-password") return SIGN_IN_TEXT.resetHeading;
  if (kind === "verify-email") return SIGN_IN_TEXT.verifyHeading;
  return SIGN_IN_TEXT.changeHeading;
}

function resendPanel(kind: RecoveryKind): ResendPanel {
  if (kind === "reset-password") return { kind: "reset_email", help: SIGN_IN_TEXT.resetResendHelp, submitLabel: SIGN_IN_TEXT.sendReset };
  if (kind === "verify-email") return { kind: "verify_email", help: SIGN_IN_TEXT.verifyResendHelp, submitLabel: SIGN_IN_TEXT.sendVerification };
  return { kind: "change_email_settings", help: SIGN_IN_TEXT.changeResendHelp };
}

export type DeviceStepUp = {
  login(input: { email: string; password: string }): Promise<StepUpLogin>;
  verify(input: { challengeToken: string; code: string }): Promise<void>;
};

export type DeviceApproval = "open" | "verify" | "enroll";

export type DeviceConsent = {
  scopes: readonly string[];
  expiresAt: string;
  accountEmail: string;
  approval: DeviceApproval;
};

export type DeviceModel =
  | { kind: "signed_out" }
  | { kind: "unavailable" }
  | { kind: "code"; draft: string; error: string | null; inflight: "inspect" | null }
  | {
      kind: "review";
      userCode: string;
      consent: DeviceConsent & { approval: "open" };
      error: string | null;
      inflight: "approve" | "deny" | null;
    }
  | {
      kind: "verify";
      userCode: string;
      consent: DeviceConsent & { approval: "verify" };
      challengeToken: string | null;
      error: string | null;
      inflight: "login" | "verify" | "inspect" | "deny" | null;
    }
  | {
      kind: "enroll";
      userCode: string;
      consent: DeviceConsent & { approval: "enroll" };
      error: string | null;
      inflight: "inspect" | "deny" | null;
    }
  | { kind: "done"; outcome: "approved" | "denied" };

export type DeviceEvent =
  | { type: "draft"; value: string }
  | { type: "submit_code" }
  | { type: "inspect_failed"; message: string }
  | { type: "inspected"; userCode: string; consent: DeviceConsent }
  | { type: "submit_approve" }
  | { type: "submit_deny" }
  | { type: "decision_failed"; message: string }
  | { type: "needs_fresh_mfa" }
  | { type: "decided"; outcome: "approved" | "denied" }
  | { type: "submit_password" }
  | { type: "challenge"; challengeToken: string }
  | { type: "step_up_signed_in" }
  | { type: "step_up_failed"; message: string }
  | { type: "submit_otp" }
  | { type: "verified" }
  | { type: "recheck" };

export type DeviceDraft =
  | { kind: "return" }
  | { kind: "entry"; userCode: string }
  | { kind: "reviewed"; userCode: string };

export const DEVICE_DRAFT_KEY = "myskills:device-login-return";

export function readDeviceDraft(): DeviceDraft | null {
  const raw = readDraftRaw();
  if (raw === "1") return { kind: "return" };
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as { kind?: unknown; userCode?: unknown };
    if ((record.kind === "entry" || record.kind === "reviewed") && typeof record.userCode === "string") {
      return { kind: record.kind, userCode: record.userCode };
    }
  } catch {
    return null;
  }
  return null;
}

export function writeDeviceDraft(draft: DeviceDraft): void {
  const store = draftStorage();
  if (!store) return;
  try {
    store.setItem(DEVICE_DRAFT_KEY, draft.kind === "return" ? "1" : JSON.stringify({ kind: draft.kind, userCode: draft.userCode }));
  } catch {
    // Private browsing can disable storage.
  }
}

export function clearDeviceDraft(): void {
  try {
    draftStorage()?.removeItem(DEVICE_DRAFT_KEY);
  } catch {
    // Private browsing can disable storage.
  }
}

export function hasDeviceDraft(): boolean {
  return readDeviceDraft() !== null;
}

function draftStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readDraftRaw(): string | null {
  try {
    return draftStorage()?.getItem(DEVICE_DRAFT_KEY) ?? null;
  } catch {
    return null;
  }
}

export function initialDeviceModel(input: { signedIn: boolean; hasClient: boolean; draft?: DeviceDraft | null }): DeviceModel {
  if (!input.signedIn) return { kind: "signed_out" };
  if (!input.hasClient) return { kind: "unavailable" };
  if (input.draft?.kind === "entry") return { kind: "code", draft: input.draft.userCode, error: null, inflight: null };
  if (input.draft?.kind === "reviewed") return { kind: "code", draft: input.draft.userCode, error: null, inflight: "inspect" };
  return { kind: "code", draft: "", error: null, inflight: null };
}

export function reduceDevice(model: DeviceModel, event: DeviceEvent): DeviceModel {
  if (model.kind === "signed_out" || model.kind === "unavailable" || model.kind === "done") return model;
  switch (event.type) {
    case "draft":
      return model.kind === "code" && model.inflight === null ? { ...model, draft: event.value } : model;
    case "submit_code":
      return model.kind === "code" && model.inflight === null ? { ...model, inflight: "inspect" } : model;
    case "inspected":
      return consentModel(event.userCode, event.consent);
    case "inspect_failed":
      if (model.kind === "code" || model.kind === "verify" || model.kind === "enroll") return { ...model, inflight: null, error: event.message };
      return model;
    case "submit_approve":
      return model.kind === "review" && model.inflight === null ? { ...model, inflight: "approve" } : model;
    case "submit_deny":
      return (model.kind === "review" || model.kind === "verify" || model.kind === "enroll") && model.inflight === null
        ? { ...model, inflight: "deny" }
        : model;
    case "decision_failed":
      return model.kind === "review" || model.kind === "verify" || model.kind === "enroll"
        ? { ...model, inflight: null, error: event.message }
        : model;
    case "needs_fresh_mfa":
      // The decide() 403 is the gate. This does not measure the 15 minute window.
      return model.kind === "review"
        ? { kind: "verify", userCode: model.userCode, consent: { ...model.consent, approval: "verify" }, challengeToken: null, error: null, inflight: null }
        : model;
    case "decided":
      return { kind: "done", outcome: event.outcome };
    case "submit_password":
      return model.kind === "verify" && model.challengeToken === null && model.inflight === null ? { ...model, inflight: "login" } : model;
    case "challenge":
      return model.kind === "verify" && model.inflight === "login" ? { ...model, challengeToken: event.challengeToken, inflight: null } : model;
    case "step_up_signed_in":
      return model.kind === "verify" && model.inflight === "login" ? { ...model, inflight: "inspect" } : model;
    case "step_up_failed":
      return model.kind === "verify" ? { ...model, inflight: null, error: event.message } : model;
    case "submit_otp":
      return model.kind === "verify" && model.challengeToken !== null && model.inflight === null ? { ...model, inflight: "verify" } : model;
    case "verified":
      return model.kind === "verify" && model.inflight === "verify" ? { ...model, challengeToken: null, inflight: "inspect" } : model;
    case "recheck":
      return (model.kind === "enroll" || model.kind === "verify") && model.inflight === null ? { ...model, inflight: "inspect" } : model;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

function consentModel(userCode: string, consent: DeviceConsent): DeviceModel {
  const shared = { scopes: consent.scopes, expiresAt: consent.expiresAt, accountEmail: consent.accountEmail };
  if (consent.approval === "open") return { kind: "review", userCode, consent: { ...shared, approval: "open" }, error: null, inflight: null };
  if (consent.approval === "verify") return { kind: "verify", userCode, consent: { ...shared, approval: "verify" }, challengeToken: null, error: null, inflight: null };
  return { kind: "enroll", userCode, consent: { ...shared, approval: "enroll" }, error: null, inflight: null };
}

export type Control = "hidden" | "enabled" | "busy";

export function deviceApproveControl(model: DeviceModel): Control {
  if (model.kind !== "review") return "hidden";
  if (model.inflight === null) return "enabled";
  if (model.inflight === "approve") return "busy";
  return "hidden";
}

export function deviceDenyControl(model: DeviceModel): Control {
  if (model.kind !== "review" && model.kind !== "verify" && model.kind !== "enroll") return "hidden";
  if (model.inflight === null) return "enabled";
  if (model.inflight === "deny") return "busy";
  return "hidden";
}

export type PermissionLine = { key: string; text: string };

export function devicePermissionLines(scopeIds: readonly string[]): PermissionLine[] {
  return scopeIds.map((scope) => ({ key: scope, text: apiTokenScopeLabel(scope) }));
}

export type ConnectGate = { kind: "open" } | { kind: "mfa" };

export type ConnectPresentation = {
  gate: ConnectGate;
  lines: readonly PermissionLine[];
};

export function connectPresentation(input: {
  mfaRequired: boolean;
  scopes: readonly { scope: string; description: string }[];
}): ConnectPresentation {
  return {
    gate: input.mfaRequired ? { kind: "mfa" } : { kind: "open" },
    lines: input.scopes.map((scope) => {
      const description = scope.description.trim();
      return { key: scope.scope, text: description || apiTokenScopeLabel(scope.scope) };
    }),
  };
}

export function apiTokenScopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? SIGN_IN_TEXT.additionalPermission;
}

export function parseDeviceInspect(body: unknown): DeviceConsent {
  const record = isRecord(body) ? body : null;
  const account = isRecord(record?.account) ? record.account : null;
  const email = typeof account?.email === "string" ? account.email.trim() : "";
  const expiresAt = record?.expiresAt;
  const approval = record?.approval;
  const scopes = record?.scopes;
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => typeof scope !== "string" || scope.length === 0)
    || typeof expiresAt !== "string" || expiresAt.length === 0
    || email.length === 0
    || (approval !== "open" && approval !== "verify" && approval !== "enroll")) {
    throw new Error("Device consent is missing its approval gate.");
  }
  return { scopes, expiresAt, accountEmail: email, approval };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type StepUpLogin =
  | { kind: "challenge"; challengeToken: string }
  | { kind: "signed_in" };

export function stepUpFromLogin(
  result: { mfaRequired: true; challengeToken: string } | { mfaRequired: false },
): StepUpLogin {
  return result.mfaRequired ? { kind: "challenge", challengeToken: result.challengeToken } : { kind: "signed_in" };
}
