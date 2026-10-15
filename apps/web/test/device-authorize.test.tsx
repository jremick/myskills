import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { RegistryApp } from "../src/App.js";
import { DeviceAuthorizePage } from "../src/components/DeviceAuthorizePage.js";
import { createDeviceLoginClient, type DeviceLoginClient } from "../src/device-login-api.js";
import { readDeviceDraft, type DeviceConsent, type DeviceStepUp } from "../src/sign-in-flow.js";
import type { RegistryClient } from "../src/api.js";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/auth/device");
});

test("verify approval hides Approve, keeps Deny, and shows the account and labels", async () => {
  const view = render(<DeviceAuthorizePage client={client([consent("verify")])} signedIn stepUp={idleStepUp()} onSignIn={() => assert.fail("sign-in")} />);
  fireEvent.input(view.getByLabelText("Device code"), { target: { value: "ABCDE-FGHJK" } });
  fireEvent.click(view.getByRole("button", { name: "Review permissions" }));
  await view.findByText("ada@example.com");
  assert.match(view.container.textContent ?? "", /Signed in as\s+ada@example.com/);
  assert.ok(view.getByText("Submit skills"));
  assert.equal(view.queryByText("skills:submit"), null);
  assert.equal(view.queryByRole("button", { name: "Approve CLI access" }), null);
  assert.equal((view.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled, false);
  assert.equal(view.getByRole("link", { name: "Skip to main content" }).getAttribute("href"), "#main-content");
  assert.ok(document.getElementById("main-content"));
  fireEvent.click(view.getByRole("button", { name: "Deny" }));
  await view.findByText(/CLI access denied/);
});

test("a fresh inspect enables Approve and a stored MFA flag does not", async () => {
  const approvals: DeviceConsent[] = [consent("verify"), consent("open")];
  const calls: string[] = [];
  const stepUp: DeviceStepUp = {
    async login(input) {
      calls.push(`login:${input.email}`);
      return { kind: "challenge", challengeToken: "challenge-1" };
    },
    async verify(input) {
      calls.push(`verify:${input.challengeToken}:${input.code}`);
    },
  };
  const view = render(<DeviceAuthorizePage client={client(approvals)} signedIn stepUp={stepUp} onSignIn={() => assert.fail("sign-in")} />);
  fireEvent.input(view.getByLabelText("Device code"), { target: { value: "ABCDE-FGHJK" } });
  fireEvent.click(view.getByRole("button", { name: "Review permissions" }));
  await view.findByText("ada@example.com");
  assert.equal(view.queryByRole("button", { name: "Approve CLI access" }), null);
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse" } });
  fireEvent.click(view.getByRole("button", { name: "Continue" }));
  fireEvent.input(await view.findByLabelText("Authenticator or recovery code"), { target: { value: "123456" } });
  fireEvent.click(view.getByRole("button", { name: "Verify" }));
  const approve = await view.findByRole("button", { name: "Approve CLI access" });
  assert.equal((approve as HTMLButtonElement).disabled, false);
  assert.deepEqual(calls, ["login:ada@example.com", "verify:challenge-1:123456"]);
});

test("session.user.mfaVerified does not enable Approve while inspect says verify", async () => {
  window.history.replaceState({}, "", "/auth/device");
  window.localStorage.setItem("myskills-app:web-session", JSON.stringify({
    expiresAt: "2027-01-01T00:00:00.000Z",
    user: { id: "device-user", email: "session@example.com", name: "Device User", status: "active", roles: ["user"], emailVerified: true, mfaVerified: true },
  }));
  const view = render(<RegistryApp client={shellClient(consent("verify"))} />);
  fireEvent.input(await view.findByLabelText("Device code"), { target: { value: "ABCDE-FGHJK" } });
  fireEvent.click(view.getByRole("button", { name: "Review permissions" }));
  await view.findByText("ada@example.com");
  assert.equal(view.queryByText("session@example.com"), null);
  assert.equal(view.queryByRole("button", { name: "Approve CLI access" }), null);
  assert.ok(view.getByRole("button", { name: "Deny" }));
});

test("a typed device code survives sign-in in the draft and stays out of the URL", () => {
  let signedIn = 0;
  const first = render(<DeviceAuthorizePage signedIn={false} stepUp={idleStepUp()} onSignIn={() => { signedIn += 1; }} />);
  fireEvent.input(first.getByLabelText("Device code"), { target: { value: "ABCDE-FGHJK" } });
  fireEvent.click(first.getByRole("button", { name: "Sign in" }));
  assert.equal(signedIn, 1);
  assert.equal(window.location.href.includes("ABCDE"), false);
  assert.deepEqual(readDeviceDraft(), { kind: "entry", userCode: "ABCDE-FGHJK" });
  cleanup();
  const back = render(<DeviceAuthorizePage client={client([consent("open")])} signedIn stepUp={idleStepUp()} onSignIn={() => assert.fail("sign-in")} />);
  assert.equal((back.getByLabelText("Device code") as HTMLInputElement).value, "ABCDE-FGHJK");
});

test("a decide 403 moves an open review to verify before the next inspect", async () => {
  const device = client([consent("open")]);
  device.decide = async () => {
    throw Object.assign(new Error("Sign in again with MFA to approve these permissions."), { code: "MFA_VERIFICATION_REQUIRED", status: 403 });
  };
  const view = render(<DeviceAuthorizePage client={device} signedIn stepUp={idleStepUp()} onSignIn={() => assert.fail("sign-in")} />);
  fireEvent.input(view.getByLabelText("Device code"), { target: { value: "ABCDE-FGHJK" } });
  fireEvent.click(view.getByRole("button", { name: "Review permissions" }));
  fireEvent.click(await view.findByRole("button", { name: "Approve CLI access" }));
  await view.findByText(/Enter the password for this account/);
  assert.equal(view.queryByRole("button", { name: "Approve CLI access" }), null);
  assert.ok(view.getByRole("button", { name: "Deny" }));
});

test("device inspect parsing rejects a body that only has mfaRequired", async () => {
  const missing = createDeviceLoginClient("http://api.test", async () => json(200, {
    scopes: ["skills:submit"],
    expiresAt: "2027-01-01T00:00:00.000Z",
    mfaRequired: true,
    account: { email: "ada@example.com" },
  }));
  await assert.rejects(() => missing.inspect("ABCDE-FGHJK"), /approval gate/);
  const parsed = createDeviceLoginClient("http://api.test", async () => json(200, {
    scopes: ["profile:read"],
    expiresAt: "2027-01-01T00:00:00.000Z",
    mfaRequired: true,
    account: { email: "ada@example.com" },
    approval: "open",
  }));
  assert.deepEqual(await parsed.inspect("ABCDE-FGHJK"), {
    scopes: ["profile:read"],
    expiresAt: "2027-01-01T00:00:00.000Z",
    accountEmail: "ada@example.com",
    approval: "open",
  });
});

function consent(approval: DeviceConsent["approval"]): DeviceConsent {
  return { scopes: ["skills:submit"], expiresAt: "2027-01-01T00:00:00.000Z", accountEmail: "ada@example.com", approval };
}

function client(responses: DeviceConsent[]): DeviceLoginClient {
  let index = 0;
  return {
    async inspect() {
      const next = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return next;
    },
    async decide() {
      return { status: "denied" };
    },
  };
}

function idleStepUp(): DeviceStepUp {
  return {
    async login() { throw new Error("login was not expected"); },
    async verify() { throw new Error("verify was not expected"); },
  };
}

function shellClient(body: DeviceConsent): RegistryClient {
  const user = { id: "device-user", email: "session@example.com", name: "Device User", status: "active", roles: ["user"], emailVerified: true, mfaVerified: true };
  return {
    async getBranding() { return { text: "MySkills", showText: true, logoDataUrl: null }; },
    async getSiteSettings() { return { landingPageEnabled: true }; },
    async getMe() { return user; },
    deviceLogin: client([body]),
  } as RegistryClient;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
