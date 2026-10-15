import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVICE_DRAFT_KEY,
  apiTokenScopeLabel,
  captureAuthActionToken,
  checkNewPassword,
  clearDeviceDraft,
  completionView,
  connectPresentation,
  deviceApproveControl,
  deviceDenyControl,
  devicePermissionLines,
  discardRecoveryToken,
  hasDeviceDraft,
  initialCompletion,
  initialDeviceModel,
  parseDeviceInspect,
  readDeviceDraft,
  reduceCompletion,
  reduceDevice,
  signInCopy,
  stepUpFromLogin,
  writeDeviceDraft,
  type DeviceConsent,
} from "../src/sign-in-flow.js";

test("signInCopy keeps the heading and hides a rejected request-access link", () => {
  const plain = signInCopy(undefined);
  assert.deepEqual(plain, {
    navLabel: "Sign in",
    navAria: "Sign in navigation",
    heading: "Sign in",
    lede: "This page signs in an account that already exists. It does not create an account, and it does not send an invitation. Ask the person who runs this server how access works here.",
    requestAccess: null,
  });
  for (const rejected of ["", "   ", "javascript:alert(1)", "data:text/html,hi", "//evil.example", "https://user:pass@example.com/join", "ftp://example.com/join", "/login"]) {
    assert.equal(signInCopy(rejected).requestAccess, null, rejected);
    assert.equal(signInCopy(rejected).lede, plain.lede);
  }
  assert.deepEqual(signInCopy("  https://access.example/join  ").requestAccess, {
    href: "https://access.example/join",
    label: "Request access",
  });
  assert.equal(signInCopy("https://access.example/join").lede, "This page signs in an account that already exists. Request access if you need an account. Approval still happens before that account can sign in.");
  assert.equal(signInCopy("http://127.0.0.1:3000/request").requestAccess?.href, "http://127.0.0.1:3000/request");
  assert.equal(signInCopy("mailto:ada@example.com").requestAccess?.href, "mailto:ada@example.com");
});

test("checkNewPassword enforces length, then UTF-8 bytes, then a match", () => {
  assert.deepEqual(checkNewPassword("short-pass", "short-pass"), { ok: false, message: "Use a password with at least 12 characters." });
  assert.deepEqual(checkNewPassword("short", "different"), { ok: false, message: "Use a password with at least 12 characters." });
  const tooLong = `${"a".repeat(71)}é`;
  assert.equal(new TextEncoder().encode(tooLong).byteLength, 73);
  assert.deepEqual(checkNewPassword(tooLong, tooLong), {
    ok: false,
    message: "Password must be at most 72 UTF-8 bytes. Non-ASCII characters can use more than one byte.",
  });
  assert.deepEqual(checkNewPassword("correct horse", "correct horses"), { ok: false, message: "Passwords do not match." });
  assert.deepEqual(checkNewPassword("correct horse", "correct horse"), { ok: true });
});

test("captureAuthActionToken retains the fragment until discarded", () => {
  window.history.replaceState({}, "", "/auth/reset-password#token=reset-token");
  assert.equal(captureAuthActionToken("/auth/reset-password"), "reset-token");
  assert.equal(window.location.hash, "#token=reset-token");
  assert.equal(window.location.pathname, "/auth/reset-password");
  assert.equal(captureAuthActionToken("/auth/reset-password"), "reset-token");
  assert.equal(captureAuthActionToken("/auth/verify-email"), null);
  window.history.replaceState({}, "", "/auth/verify-email#token=verify-token");
  assert.equal(captureAuthActionToken("/auth/verify-email"), "verify-token");
  assert.equal(captureAuthActionToken("/auth/reset-password"), null);
  discardRecoveryToken("/auth/reset-password");
  assert.equal(captureAuthActionToken("/auth/reset-password"), null);
  discardRecoveryToken("/auth/verify-email");
  window.history.replaceState({}, "", "/auth/change-email");
  assert.equal(captureAuthActionToken("/auth/change-email"), null);
});

test("completion stays off the form without a token and after success or an invalid link", () => {
  assert.deepEqual(initialCompletion(null), { kind: "absent" });
  assert.deepEqual(completionView("verify-email", { kind: "absent" }), {
    kind: "blocked",
    heading: "Verify email",
    status: "This link is missing its token.",
    next: { label: "Return to sign in" },
    resend: { kind: "verify_email", help: "If that account can still be verified, a new message is sent.", submitLabel: "Send verification email" },
  });
  const form = initialCompletion("reset-token");
  assert.deepEqual(form, { kind: "form", token: "reset-token", error: null });
  assert.equal(reduceCompletion(form, { type: "succeed" }), form);
  const submitting = reduceCompletion(form, { type: "submit" });
  assert.deepEqual(submitting, { kind: "submitting", token: "reset-token" });
  assert.equal(reduceCompletion(submitting, { type: "submit" }), submitting);
  assert.deepEqual(reduceCompletion(submitting, { type: "reject", message: "Choose a stronger password." }), {
    kind: "form",
    token: "reset-token",
    error: "Choose a stronger password.",
  });
  assert.deepEqual(completionView("reset-password", submitting), {
    kind: "form",
    heading: "Reset password",
    token: "reset-token",
    form: "password",
    passwordRule: "Use at least 12 characters and at most 72 UTF-8 bytes.",
    submitLabel: "Save password",
    status: null,
    busy: true,
  });
  assert.deepEqual(completionView("change-email", { kind: "form", token: "change-token", error: null }), {
    kind: "form",
    heading: "Confirm email change",
    token: "change-token",
    form: "confirm",
    submitLabel: "Confirm email change",
    status: null,
    busy: false,
  });
  assert.deepEqual(completionView("verify-email", { kind: "invalid" }), {
    kind: "blocked",
    heading: "Verify email",
    status: "This link is invalid or expired.",
    next: { label: "Return to sign in" },
    resend: { kind: "verify_email", help: "If that account can still be verified, a new message is sent.", submitLabel: "Send verification email" },
  });
  const changeBlocked = completionView("change-email", { kind: "invalid" });
  assert.deepEqual(changeBlocked, {
    kind: "blocked",
    heading: "Confirm email change",
    status: "This link is invalid or expired.",
    next: { label: "Return to sign in" },
    resend: { kind: "change_email_settings", help: "This page cannot send a new email-change link. Sign in, then request the change again from Settings. That request needs the current password." },
  });
  assert.deepEqual(completionView("reset-password", { kind: "done" }), {
    kind: "done",
    heading: "Reset password",
    status: "Password reset. You can sign in with the new password.",
    next: { label: "Continue to sign in" },
    clearLocalSession: true,
  });
  assert.deepEqual(completionView("change-email", { kind: "done" }), {
    kind: "done",
    heading: "Confirm email change",
    status: "Email changed. Sign in again with the new address.",
    next: { label: "Continue to sign in" },
    clearLocalSession: true,
  });
  const verified = completionView("verify-email", { kind: "done" });
  assert.deepEqual(verified, {
    kind: "done",
    heading: "Verify email",
    status: "Email verified. You can sign in after your account is approved.",
    next: { label: "Continue to sign in" },
    clearLocalSession: false,
  });
});

test("device approval enables Approve only for an open review", () => {
  const open = consent("open");
  const verify = consent("verify");
  const enroll = consent("enroll");
  let model = reduceDevice(initialDeviceModel({ signedIn: true, hasClient: true }), { type: "inspected", userCode: "ABCDE-FGHJK", consent: verify });
  assert.equal(model.kind, "verify");
  assert.equal(deviceApproveControl(model), "hidden");
  assert.equal(deviceDenyControl(model), "enabled");
  model = reduceDevice(model, { type: "inspected", userCode: "ABCDE-FGHJK", consent: enroll });
  assert.equal(deviceApproveControl(model), "hidden");
  assert.equal(deviceDenyControl(model), "enabled");
  model = reduceDevice(initialDeviceModel({ signedIn: true, hasClient: true }), { type: "inspected", userCode: "ABCDE-FGHJK", consent: open });
  assert.equal(deviceApproveControl(model), "enabled");
  assert.equal(deviceDenyControl(model), "enabled");
  const approving = reduceDevice(model, { type: "submit_approve" });
  assert.equal(deviceApproveControl(approving), "busy");
  assert.equal(deviceDenyControl(approving), "hidden");
  const fresh = reduceDevice(model, { type: "needs_fresh_mfa" });
  assert.equal(fresh.kind, "verify");
  assert.equal(deviceApproveControl(fresh), "hidden");
  assert.equal(deviceDenyControl(fresh), "enabled");
  if (fresh.kind === "verify") assert.equal(fresh.consent.accountEmail, "ada@example.com");
  assert.deepEqual(reduceDevice({ kind: "done", outcome: "approved" }, { type: "needs_fresh_mfa" }), { kind: "done", outcome: "approved" });
});

test("device step-up keeps the reviewed code and rechecks after verification", () => {
  const start = reduceDevice(initialDeviceModel({ signedIn: true, hasClient: true }), {
    type: "inspected",
    userCode: "ABCDE-FGHJK",
    consent: consent("verify"),
  });
  const loggingIn = reduceDevice(start, { type: "submit_password" });
  const challenged = reduceDevice(loggingIn, { type: "challenge", challengeToken: "challenge-1" });
  assert.deepEqual(challenged, {
    kind: "verify",
    userCode: "ABCDE-FGHJK",
    consent: consent("verify"),
    challengeToken: "challenge-1",
    error: null,
    inflight: null,
  });
  const checking = reduceDevice(reduceDevice(challenged, { type: "submit_otp" }), { type: "verified" });
  assert.deepEqual(checking, {
    kind: "verify",
    userCode: "ABCDE-FGHJK",
    consent: consent("verify"),
    challengeToken: null,
    error: null,
    inflight: "inspect",
  });
  const opened = reduceDevice(checking, { type: "inspected", userCode: "ABCDE-FGHJK", consent: consent("open") });
  assert.equal(deviceApproveControl(opened), "enabled");
  assert.deepEqual(reduceDevice(challenged, { type: "step_up_failed", message: "Invalid email or password." }), {
    kind: "verify",
    userCode: "ABCDE-FGHJK",
    consent: consent("verify"),
    challengeToken: "challenge-1",
    error: "Invalid email or password.",
    inflight: null,
  });
  assert.deepEqual(stepUpFromLogin({ mfaRequired: true, challengeToken: "challenge-1" }), { kind: "challenge", challengeToken: "challenge-1" });
  assert.deepEqual(stepUpFromLogin({ mfaRequired: false }), { kind: "signed_in" });
});

test("a device draft restores a typed or reviewed code and legacy 1 only marks a return", () => {
  window.sessionStorage.clear();
  assert.equal(hasDeviceDraft(), false);
  window.sessionStorage.setItem(DEVICE_DRAFT_KEY, "1");
  assert.deepEqual(readDeviceDraft(), { kind: "return" });
  assert.equal(hasDeviceDraft(), true);
  assert.equal(window.sessionStorage.getItem(DEVICE_DRAFT_KEY), "1");
  assert.deepEqual(initialDeviceModel({ signedIn: true, hasClient: true, draft: readDeviceDraft() }), {
    kind: "code",
    draft: "",
    error: null,
    inflight: null,
  });
  writeDeviceDraft({ kind: "entry", userCode: "ABCDE-FGHJK" });
  assert.deepEqual(readDeviceDraft(), { kind: "entry", userCode: "ABCDE-FGHJK" });
  assert.deepEqual(initialDeviceModel({ signedIn: false, hasClient: true, draft: readDeviceDraft() }), { kind: "signed_out" });
  assert.deepEqual(initialDeviceModel({ signedIn: true, hasClient: true, draft: readDeviceDraft() }), {
    kind: "code",
    draft: "ABCDE-FGHJK",
    error: null,
    inflight: null,
  });
  writeDeviceDraft({ kind: "reviewed", userCode: "ABCDE-FGHJK" });
  assert.deepEqual(initialDeviceModel({ signedIn: true, hasClient: true, draft: readDeviceDraft() }), {
    kind: "code",
    draft: "ABCDE-FGHJK",
    error: null,
    inflight: "inspect",
  });
  assert.equal(initialDeviceModel({ signedIn: true, hasClient: false }).kind, "unavailable");
  window.sessionStorage.setItem(DEVICE_DRAFT_KEY, "{");
  assert.equal(readDeviceDraft(), null);
  clearDeviceDraft();
  assert.equal(hasDeviceDraft(), false);
});

test("permission lines use labels and connect keeps its own MFA gate", () => {
  assert.deepEqual(devicePermissionLines(["skills:submit", "targets:execute", "custom:unknown"]), [
    { key: "skills:submit", text: "Submit skills" },
    { key: "targets:execute", text: "Execute target updates" },
    { key: "custom:unknown", text: "Additional permission" },
  ]);
  assert.equal(apiTokenScopeLabel("libraries:write"), "Manage libraries");
  assert.equal(apiTokenScopeLabel("not-a-scope"), "Additional permission");
  assert.deepEqual(connectPresentation({
    mfaRequired: true,
    scopes: [
      { scope: "skills:read", description: "Find skills you can access." },
      { scope: "skills:submit", description: "   " },
    ],
  }), {
    gate: { kind: "mfa" },
    lines: [
      { key: "skills:read", text: "Find skills you can access." },
      { key: "skills:submit", text: "Submit skills" },
    ],
  });
  assert.deepEqual(connectPresentation({ mfaRequired: false, scopes: [] }), { gate: { kind: "open" }, lines: [] });
});

test("parseDeviceInspect requires the approval word and ignores mfaRequired", () => {
  assert.throws(() => parseDeviceInspect({ scopes: ["skills:submit"], expiresAt: "2027-01-01T00:00:00.000Z", mfaRequired: false, account: { email: "ada@example.com" } }), /approval gate/);
  assert.deepEqual(parseDeviceInspect({
    scopes: ["skills:submit"],
    expiresAt: "2027-01-01T00:00:00.000Z",
    mfaRequired: true,
    account: { email: " ada@example.com " },
    approval: "verify",
  }), consent("verify"));
  assert.throws(() => parseDeviceInspect({ scopes: [], expiresAt: "2027-01-01T00:00:00.000Z", account: { email: "ada@example.com" }, approval: "open" }), /approval gate/);
  assert.throws(() => parseDeviceInspect({ scopes: ["skills:read"], expiresAt: "2027-01-01T00:00:00.000Z", account: { email: " " }, approval: "open" }), /approval gate/);
});

function consent(approval: DeviceConsent["approval"]): DeviceConsent {
  return { scopes: ["skills:submit"], expiresAt: "2027-01-01T00:00:00.000Z", accountEmail: "ada@example.com", approval };
}
