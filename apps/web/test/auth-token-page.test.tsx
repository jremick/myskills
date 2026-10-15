import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { RegistryApp } from "../src/App.js";
import type { RegistryClient } from "../src/api.js";
import { discardRecoveryToken } from "../src/sign-in-flow.js";

const SESSION_KEY = "myskills-app:web-session";
const storedSession = JSON.stringify({
  expiresAt: "2027-01-01T00:00:00.000Z",
  user: { id: "reader", email: "reader@example.com", name: "Reader", status: "active", roles: ["user"], emailVerified: true, mfaVerified: false },
});

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  for (const path of ["/auth/reset-password", "/auth/verify-email", "/auth/change-email"]) discardRecoveryToken(path);
});

test("a recovery link without a token shows no form", async () => {
  window.history.replaceState({}, "", "/auth/reset-password");
  const calls = recoveryCalls();
  const view = render(<RegistryApp client={calls.client} />);
  await view.findByRole("heading", { name: "Reset password" });
  await view.findByText("This link is missing its token.");
  assert.equal(view.queryByLabelText("New password"), null);
  assert.equal(view.queryByRole("button", { name: "Save password" }), null);
  assert.equal(calls.passwordResets.length, 0);
});

test("an invalid verification token replaces the confirm button and does not confirm on mount", async () => {
  window.history.replaceState({}, "", "/auth/verify-email#token=expired-token");
  const calls = recoveryCalls({ verifyError: invalid("INVALID_VERIFICATION_TOKEN") });
  const first = render(<RegistryApp client={calls.client} />);
  assert.equal(calls.verifications.length, 0);
  cleanup();
  const view = render(<RegistryApp client={calls.client} />);
  assert.equal(window.location.hash, "#token=expired-token");
  assert.equal(calls.verifications.length, 0);
  assert.ok(first);
  fireEvent.click(view.getByRole("button", { name: "Confirm email" }));
  await view.findByText("This link is invalid or expired.");
  assert.equal(view.queryByRole("button", { name: "Confirm email" }), null);
  assert.deepEqual(calls.verifications, ["expired-token"]);
  assert.equal(window.location.hash, "");
});

test("one verify click confirms once and success leaves the local session", async () => {
  window.history.replaceState({}, "", "/auth/verify-email#token=verify-token");
  window.localStorage.setItem(SESSION_KEY, storedSession);
  const calls = recoveryCalls();
  const view = render(<RegistryApp client={calls.client} />);
  view.rerender(<RegistryApp client={calls.client} />);
  assert.equal(calls.verifications.length, 0);
  fireEvent.click(view.getByRole("button", { name: "Confirm email" }));
  await view.findByText("Email verified. You can sign in after your account is approved.");
  assert.equal(view.queryByRole("button", { name: "Confirm email" }), null);
  assert.deepEqual(calls.verifications, ["verify-token"]);
  assert.equal(window.location.hash, "");
  assert.equal(window.localStorage.getItem(SESSION_KEY), storedSession);
});

test("short and oversized passwords show the rule before submit and do not call the API", async () => {
  window.history.replaceState({}, "", "/auth/reset-password#token=reset-token");
  const calls = recoveryCalls();
  const view = render(<RegistryApp client={calls.client} />);
  await view.findByText("Use at least 12 characters and at most 72 UTF-8 bytes.");
  fireEvent.input(view.getByLabelText("New password"), { target: { value: "short-pass1" } });
  fireEvent.input(view.getByLabelText("Confirm password"), { target: { value: "short-pass1" } });
  await view.findByText("Use a password with at least 12 characters.");
  fireEvent.click(view.getByRole("button", { name: "Save password" }));
  assert.deepEqual(calls.passwordResets, []);
  const tooLong = `${"a".repeat(71)}é`;
  fireEvent.input(view.getByLabelText("New password"), { target: { value: tooLong } });
  fireEvent.input(view.getByLabelText("Confirm password"), { target: { value: tooLong } });
  await view.findByText("Password must be at most 72 UTF-8 bytes. Non-ASCII characters can use more than one byte.");
  fireEvent.click(view.getByRole("button", { name: "Save password" }));
  assert.deepEqual(calls.passwordResets, []);
});

test("reset and email-change success clear the local session and hide the form", async () => {
  window.history.replaceState({}, "", "/auth/reset-password#token=reset-token");
  window.localStorage.setItem(SESSION_KEY, storedSession);
  const reset = recoveryCalls();
  const resetView = render(<RegistryApp client={reset.client} />);
  const password = "correct horse";
  fireEvent.input(resetView.getByLabelText("New password"), { target: { value: password } });
  fireEvent.input(resetView.getByLabelText("Confirm password"), { target: { value: password } });
  fireEvent.click(resetView.getByRole("button", { name: "Save password" }));
  await resetView.findByText("Password reset. You can sign in with the new password.");
  assert.equal(resetView.queryByLabelText("New password"), null);
  await waitFor(() => assert.equal(window.localStorage.getItem(SESSION_KEY), null));
  assert.deepEqual(reset.passwordResets, [{ token: "reset-token", password }]);
  cleanup();

  window.history.replaceState({}, "", "/auth/change-email#token=change-token");
  window.localStorage.setItem(SESSION_KEY, storedSession);
  const change = recoveryCalls();
  const changeView = render(<RegistryApp client={change.client} />);
  fireEvent.click(changeView.getByRole("button", { name: "Confirm email change" }));
  await changeView.findByText("Email changed. Sign in again with the new address.");
  assert.equal(changeView.queryByRole("button", { name: "Confirm email change" }), null);
  await waitFor(() => assert.equal(window.localStorage.getItem(SESSION_KEY), null));
  assert.deepEqual(change.emailChanges, ["change-token"]);
});

for (const kind of ["reset-password", "verify-email", "change-email"] as const) {
  test(`${kind} retains its token across a reload before completion`, async () => {
    const path = `/auth/${kind}`;
    window.history.replaceState({}, "", `${path}#token=reload-token`);
    const calls = recoveryCalls();
    render(<RegistryApp client={calls.client} />);
    cleanup();
    assert.equal(window.location.hash, "#token=reload-token");
    const view = render(<RegistryApp client={calls.client} />);
    if (kind === "reset-password") {
      fireEvent.input(view.getByLabelText("New password"), { target: { value: "correct horse" } });
      fireEvent.input(view.getByLabelText("Confirm password"), { target: { value: "correct horse" } });
    }
    fireEvent.click(view.getByRole("button", { name: kind === "reset-password" ? "Save password" : kind === "verify-email" ? "Confirm email" : "Confirm email change" }));
    await waitFor(() => assert.equal(window.location.hash, ""));
    assert.equal(calls.passwordResets[0]?.token ?? calls.verifications[0] ?? calls.emailChanges[0], "reload-token");
    cleanup();
    const reloaded = render(<RegistryApp client={calls.client} />);
    assert.ok(reloaded.getByText("This link is missing its token."));
  });
}

for (const kind of ["reset-password", "verify-email"] as const) {
  test(`${kind} resend shows pending, safe failure, and successful retry`, async () => {
    window.history.replaceState({}, "", `/auth/${kind}`);
    const calls = recoveryCalls();
    let rejectRequest: (error: Error) => void = () => assert.fail("request not started");
    let requests = 0;
    const request = async () => {
      requests += 1;
      if (requests === 1) await new Promise<void>((_resolve, reject) => { rejectRequest = reject; });
      return { status: "pending" as const };
    };
    calls.client.requestPasswordReset = request;
    calls.client.requestEmailVerification = request;
    const view = render(<RegistryApp client={calls.client} />);
    fireEvent.input(view.getByLabelText("Email"), { target: { value: "reader@example.com" } });
    const button = view.getByRole("button", { name: /Send/ });
    fireEvent.click(button);
    assert.equal(button.hasAttribute("disabled"), true);
    fireEvent.click(button);
    assert.equal(requests, 1);
    rejectRequest(new Error("private server failure"));
    await waitFor(() => assert.equal(button.hasAttribute("disabled"), false));
    assert.equal(view.queryByRole("status"), null);
    assert.equal(view.container.textContent?.includes("private server failure"), false);
    assert.ok(view.getAllByRole("alert").length >= 2);
    fireEvent.click(button);
    await view.findByRole("status");
    assert.equal(requests, 2);
  });
}

function invalid(code: string): Error {
  return Object.assign(new Error("invalid"), { status: 401, code });
}

function recoveryCalls(options: { verifyError?: Error } = {}) {
  const passwordResets: Array<{ token: string; password: string }> = [];
  const verifications: string[] = [];
  const emailChanges: string[] = [];
  const verificationRequests: string[] = [];
  const client = {
    async getBranding() { return { text: "MySkills", showText: true, logoDataUrl: null }; },
    async getSiteSettings() { return { landingPageEnabled: false }; },
    async getMe() {
      return { id: "reader", email: "reader@example.com", name: "Reader", status: "active", roles: ["user"], emailVerified: true, mfaVerified: false };
    },
    async requestPasswordReset() { return { status: "pending" as const }; },
    async requestEmailVerification(input: { email: string }) {
      verificationRequests.push(input.email);
      return { status: "pending" as const };
    },
    async confirmPasswordReset(input: { token: string; password: string }) {
      passwordResets.push(input);
      return { status: "reset" as const };
    },
    async confirmEmailVerification(input: { token: string }) {
      verifications.push(input.token);
      if (options.verifyError) throw options.verifyError;
      return { status: "verified" as const };
    },
    async confirmEmailChange(input: { token: string }) {
      emailChanges.push(input.token);
      return { status: "changed" as const };
    },
  } as unknown as RegistryClient;
  return { client, passwordResets, verifications, emailChanges, verificationRequests };
}
