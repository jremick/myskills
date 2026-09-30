import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ConnectAuthorizePage } from "../src/components/account/ConnectAuthorizePage.js";
import { RemoteConnections } from "../src/components/account/RemoteConnections.js";
import type { OAuthAuthorizationDetails, OAuthConnection, OAuthConnectionClient, OAuthConnectorInfo } from "../src/oauth-api.js";

// Synthetic hosts and values only. No real provider or credential is contacted.
const HANDLE = "H".repeat(43);

afterEach(() => cleanup());

test("consent shows the actual client, redirect origin and scopes, and approval returns to that origin only", async () => {
  const client = fakeClient();
  const navigated: string[] = [];
  let finished = 0;
  const view = render(<ConnectAuthorizePage client={client} error={null} handle={HANDLE} signedIn onFinished={() => { finished += 1; }} onSignIn={() => assert.fail("no sign-in needed")} assignLocation={(url) => navigated.push(url)} />);
  await view.findByRole("heading", { name: /Connect ChatGPT <script> to MySkills/ });
  assert.ok(view.getByText(/Self-registered app/));
  assert.ok(view.getByText("https://chatgpt.example.test"));
  assert.ok(view.getByText("reader@example.test"));
  assert.ok(view.getByText(/Find skills you can access/));
  assert.ok(view.getByText(/cannot publish, review, change or delete/i));
  assert.deepEqual(client.calls, [`inspect:${HANDLE}`]);

  fireEvent.click(view.getByRole("button", { name: "Allow access" }));
  await waitFor(() => assert.equal(navigated.length, 1));
  assert.equal(navigated[0], "https://chatgpt.example.test/cb?code=myskills_ac.synthetic&state=s1&iss=https%3A%2F%2Fskills.example.test");
  assert.equal(finished, 1);
  assert.deepEqual(client.calls, [`inspect:${HANDLE}`, `decide:${HANDLE}:approve`]);
  assert.ok(await view.findByText(/Returning you to ChatGPT <script>/));
});

test("denial returns access_denied to the client and never navigates to another origin", async () => {
  const deny = fakeClient();
  const navigated: string[] = [];
  const view = render(<ConnectAuthorizePage client={deny} error={null} handle={HANDLE} signedIn onFinished={() => {}} onSignIn={() => {}} assignLocation={(url) => navigated.push(url)} />);
  fireEvent.click(await view.findByRole("button", { name: "Deny" }));
  await waitFor(() => assert.equal(navigated.length, 1));
  assert.match(navigated[0]!, /error=access_denied/);
  cleanup();

  const hostile = fakeClient({ redirectTo: "https://attacker.example.test/cb?code=x" });
  const blocked: string[] = [];
  const hostileView = render(<ConnectAuthorizePage client={hostile} error={null} handle={HANDLE} signedIn onFinished={() => {}} onSignIn={() => {}} assignLocation={(url) => blocked.push(url)} />);
  fireEvent.click(await hostileView.findByRole("button", { name: "Allow access" }));
  await hostileView.findByText(/could not return you safely/i);
  assert.deepEqual(blocked, []);
});

test("consent explains sign-in, MFA, expiry, reuse, limits and disabled servers without calling the API unnecessarily", async () => {
  let signIns = 0;
  const anonymous = fakeClient();
  const signedOut = render(<ConnectAuthorizePage client={anonymous} error={null} handle={HANDLE} signedIn={false} onFinished={() => {}} onSignIn={() => { signIns += 1; }} assignLocation={() => assert.fail()} />);
  fireEvent.click(await signedOut.findByRole("button", { name: "Sign in to continue" }));
  assert.equal(signIns, 1);
  assert.deepEqual(anonymous.calls, []);
  cleanup();

  const mfa = fakeClient({ details: { mfaRequired: true } });
  const mfaView = render(<ConnectAuthorizePage client={mfa} error={null} handle={HANDLE} signedIn onFinished={() => {}} onSignIn={() => { signIns += 1; }} assignLocation={() => assert.fail()} />);
  await mfaView.findByText(/Sign in with MFA to approve/);
  assert.equal((mfaView.getByRole("button", { name: "Allow access" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(mfaView.getByRole("button", { name: "Sign in with MFA" }));
  assert.equal(signIns, 2);
  cleanup();

  for (const [status, code, expected] of [
    [410, "OAUTH_REQUEST_EXPIRED", /expired/i],
    [409, "OAUTH_REQUEST_ALREADY_DECIDED", /already answered/i],
    [404, "OAUTH_REQUEST_NOT_FOUND", /not valid/i],
    [404, "NOT_FOUND", /not enabled on this MySkills server|not valid/i],
  ] as const) {
    const failing = fakeClient({ inspectError: apiError(status, code) });
    const failed = render(<ConnectAuthorizePage client={failing} error={null} handle={HANDLE} signedIn onFinished={() => {}} onSignIn={() => {}} assignLocation={() => assert.fail()} />);
    await failed.findByText(expected);
    assert.equal(failed.queryByRole("button", { name: "Allow access" }), null, code);
    cleanup();
  }

  const limited = fakeClient({ decideError: apiError(409, "OAUTH_CONNECTION_LIMIT") });
  const limitedView = render(<ConnectAuthorizePage client={limited} error={null} handle={HANDLE} signedIn onFinished={() => {}} onSignIn={() => {}} assignLocation={() => assert.fail()} />);
  fireEvent.click(await limitedView.findByRole("button", { name: "Allow access" }));
  await limitedView.findByText(/Revoke one in Settings/);
  cleanup();

  for (const [error, expected] of [["invalid_client", /not registered/i], ["invalid_redirect_uri", /return address/i], ["rate_limited", /Too many/i], ["<img>", /could not start/i]] as const) {
    const quiet = fakeClient();
    const errorView = render(<ConnectAuthorizePage client={quiet} error={error} handle={null} signedIn={false} onFinished={() => {}} onSignIn={() => {}} assignLocation={() => assert.fail()} />);
    await errorView.findByText(expected);
    assert.equal(document.body.innerHTML.includes("<img>"), false);
    assert.deepEqual(quiet.calls, []);
    cleanup();
  }
});

test("settings show setup guidance only for a configured endpoint and revoke connections after confirmation", async () => {
  const disabled = fakeClient({ connector: { enabled: false, mcpUrl: null } });
  const off = render(<RemoteConnections client={disabled} />);
  await off.findByText(/not enabled on this MySkills server/);
  assert.equal(off.container.querySelector("code"), null, "no invented URL");
  assert.equal(off.queryByRole("button", { name: /copy/i }), null);
  cleanup();

  const enabled = fakeClient();
  const on = render(<RemoteConnections client={enabled} />);
  await on.findByText("https://skills.example.test/mcp");
  assert.ok(on.getByRole("heading", { name: "ChatGPT" }));
  assert.ok(on.getByRole("heading", { name: "Claude" }));
  assert.ok(on.getByText(/publicly reachable HTTPS/));
  assert.ok(on.getByText(/Never paste passwords, API keys or tokens into a chat/));
  assert.ok(on.getByRole("button", { name: /copy mcp server url/i }));
  await on.findByText("Synthetic host app");
  fireEvent.click(on.getByRole("button", { name: "Revoke Synthetic host app" }));
  await on.findByRole("heading", { name: "Revoke this connection?" });
  fireEvent.click(on.getByRole("button", { name: "Revoke connection" }));
  await waitFor(() => assert.ok(enabled.calls.includes("revoke:grant-1")));
  await on.findByText(/No remote connections/);
});

function apiError(status: number, code: string) {
  return Object.assign(new Error(code), { status, code });
}

function fakeClient(options: {
  connector?: OAuthConnectorInfo;
  details?: Partial<OAuthAuthorizationDetails>;
  inspectError?: Error;
  decideError?: Error;
  redirectTo?: string;
} = {}): OAuthConnectionClient & { calls: string[] } {
  const calls: string[] = [];
  let connections: OAuthConnection[] = [{
    id: "grant-1",
    client: { id: "msc_synthetic_client_id_0001", name: "Synthetic host app", registration: "dynamic" },
    scopes: ["skills:read"],
    resource: "https://skills.example.test/mcp",
    createdAt: "2026-09-29T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: "2026-12-28T00:00:00.000Z",
    revokedAt: null,
  }];
  return {
    calls,
    async getConnector() {
      return options.connector ?? {
        enabled: true,
        mcpUrl: "https://skills.example.test/mcp",
        issuer: "https://skills.example.test",
        dynamicRegistration: true,
        scopes: [{ scope: "skills:read", description: "Find skills you can access and read their release metadata, instructions and supporting text files." }],
      };
    },
    async inspectAuthorization(handle) {
      calls.push(`inspect:${handle}`);
      if (options.inspectError) throw options.inspectError;
      return {
        client: { id: "msc_synthetic_client_id_0001", name: "ChatGPT <script>", registration: "dynamic", redirectUri: "https://chatgpt.example.test/cb", redirectOrigin: "https://chatgpt.example.test" },
        scopes: [
          { scope: "skills:read", description: "Find skills you can access and read their release metadata, instructions and supporting text files." },
          { scope: "architectures:read", description: "View skill architectures you can access, including their structure and referenced releases." },
        ],
        resource: "https://skills.example.test/mcp",
        expiresAt: "2026-09-29T00:10:00.000Z",
        account: { email: "reader@example.test", mfaVerified: false },
        mfaRequired: false,
        ...options.details,
      };
    },
    async decideAuthorization(handle, decision) {
      calls.push(`decide:${handle}:${decision}`);
      if (options.decideError) throw options.decideError;
      return {
        redirectTo: options.redirectTo ?? (decision === "approve"
          ? "https://chatgpt.example.test/cb?code=myskills_ac.synthetic&state=s1&iss=https%3A%2F%2Fskills.example.test"
          : "https://chatgpt.example.test/cb?error=access_denied&state=s1&iss=https%3A%2F%2Fskills.example.test"),
      };
    },
    async listConnections() {
      calls.push("list");
      return connections;
    },
    async revokeConnection(id) {
      calls.push(`revoke:${id}`);
      const revoked = { ...connections.find((item) => item.id === id)!, revokedAt: "2026-09-29T01:00:00.000Z" };
      connections = connections.filter((item) => item.id !== id);
      return revoked;
    },
  };
}
