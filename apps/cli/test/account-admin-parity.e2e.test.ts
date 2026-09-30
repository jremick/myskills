import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { buildApp } from "../../api/src/app.js";
import { AuthNotificationWorker } from "../../api/src/auth/notification-outbox.js";
import { AuthService, type AuthNotificationSink } from "../../api/src/auth/service.js";
import { MemoryAuthStore } from "../../api/src/auth/memory-auth-store.js";
import { parseOAuthConfig } from "../../api/src/oauth/config.js";
import { MemoryOAuthStore } from "../../api/src/oauth/memory-store.js";
import { OAuthService } from "../../api/src/oauth/service.js";
import { MemorySkillRepository } from "../../api/src/repositories/memory-skill-repository.js";
import { runCli, type CliRuntime, type StoredCliToken } from "../src/cli.js";

// Failure inventory, written before the adapter (ACC-01/04/05/06/07/09,
// ADM-01..04/06..10, SYS-01). Existing API tests prove service policy but not
// CLI parsing, prompting, transport or output. Credible CLI failures:
// - A password, reset/verification/invitation token or TOTP code is accepted
//   from argv, echoed in an error, or printed to stdout/stderr.
// - The invitation token is dropped, so an invited registration silently
//   becomes an open/request registration and is refused in closed mode.
// - The TOTP seed or recovery codes land in terminal output instead of a new
//   private file, or an existing file is replaced.
// - The output file is only checked, not reserved, before the API call: a file
//   created meanwhile, or an unwritable directory, loses one-time recovery codes
//   after MFA is already enabled. A failed call must remove only the CLI's own
//   reservation, and a lost file after success must be reported, not retried.
// - A mismatched new-password confirmation still reaches the API.
// - Wrong verb/path/body: API rejects valid intent, or a stale body shape
//   (e.g. site/registration/roles/actions) is sent.
// - Admin commands succeed without an MFA-verified owner/admin session, or a
//   scoped API token is treated as a session (no CLI-side privilege upgrade).
// - Owner safeguards (self-lockout, last owner, owner-only role changes) are
//   bypassed by a different endpoint.
// - Path-shaped ids, invalid enums/limits, repeated flags or secret-bearing
//   provider JSON reach the network.
// - The new dispatcher swallows the legacy `admin sharing` command.
// - Public instance/account-token commands attach the stored credential.
// Every request below traverses real Fastify routes, AuthService and memory stores.

const PASSWORD = "correct horse battery staple";
const AUTH_SECRET = "cli-account-admin-parity-fixture-secret";
const ORIGIN = "https://skills.example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const CONNECTOR_REDIRECT = "https://chatgpt.example.test/connector/oauth/callback-1";

type Prompt = [RegExp, string | (() => Promise<string>)];
interface AdminUser { id: string; email: string; status: string; roles: string[] }
interface AuditPage { events: Array<{ id: string; action: string; decision: string }>; nextCursor: string | null }
interface AdminToken { id: string; name: string; revokedAt: string | null }
interface Connection { id: string; revokedAt?: string | null }
interface Enrolled { enrollment: { factorId: string; label: string }; output: string }
interface MfaStatus { mfa: { totpEnabled: boolean; recoveryCodesRemaining: number } }

test("CLI registration journey preserves invitation tokens, verification, approval and reset", async (t) => {
  const f = await fixture(t);
  const owner = await f.session("owner", { mfa: true });
  const guest = f.client();
  const firstPassword = "invited registrant passphrase 1";
  const resetPassword = "reset registrant passphrase 2";

  const invited = await owner.ok<{ invitation: { email: string } }>(["admin", "registration", "invite", "--email", "invitee@example.com", "--name", "Invitee"]);
  assert.equal(invited.invitation.email, "invitee@example.com");
  const inviteToken = f.mail.invitations.at(-1)!.token;
  const newAccount = (token: string): Prompt[] => [[/new password/i, firstPassword], [/confirm/i, firstPassword], [/invitation/i, token]];
  await guest.fail(["account", "register", "--email", "invitee@example.com"], /REGISTRATION_CLOSED/, newAccount(""));
  assert.deepEqual(await guest.ok(["account", "register", "--email", "invitee@example.com", "--name", "Invitee"], newAccount(inviteToken)), { status: "active" });
  assert.equal((await f.api("POST", "/v1/auth/login", undefined, { email: "invitee@example.com", password: firstPassword })).statusCode, 200);
  await guest.fail(["account", "register", "--email", "invitee@example.com"], /INVALID_INVITATION_TOKEN/, newAccount(inviteToken));

  assert.equal((await owner.ok<{ registration: { mode: string } }>(["admin", "registration", "get"])).registration.mode, "closed");
  assert.equal((await owner.ok<{ registration: { mode: string } }>(["admin", "registration", "set", "--mode", "request"])).registration.mode, "request");
  assert.deepEqual(await guest.ok(["account", "register", "--email", "requester@example.com"], newAccount("")), { status: "pending" });
  assert.deepEqual(await guest.ok(["account", "verify-email-request", "--email", "requester@example.com"]), { status: "pending" });
  assert.deepEqual(await guest.ok(["account", "verify-email-request", "--email", "nobody@example.com"]), { status: "pending" });
  await f.drain();
  assert.equal(f.mail.verifications.some((item) => item.email === "nobody@example.com"), false);
  const verification = f.mail.verifications.filter((item) => item.email === "requester@example.com").at(-1)!.token;
  await guest.fail(["account", "verify-email"], /INVALID_VERIFICATION_TOKEN/, [[/verification token/i, "not-a-verification-token-000000000000"]]);
  assert.deepEqual(await guest.ok(["account", "verify-email"], [[/verification token/i, verification]]), { status: "verified" });

  const pending = (await owner.ok<{ users: AdminUser[] }>(["admin", "users", "list"])).users.find((user) => user.email === "requester@example.com");
  assert.ok(pending);
  assert.equal(pending.status, "pending");
  assert.equal((await f.api("POST", "/v1/auth/login", undefined, { email: "requester@example.com", password: firstPassword })).json().error.code, "ACCOUNT_NOT_ACTIVE");
  assert.equal((await owner.ok<{ user: AdminUser }>(["admin", "users", "action", pending.id, "--action", "approve", "--reason", "Verified requester"])).user.status, "active");

  assert.deepEqual(await guest.ok(["account", "password-reset-request", "--email", "requester@example.com"]), { status: "pending" });
  await f.drain();
  const reset = f.mail.resets.at(-1)!.token;
  const before = f.requests();
  await guest.fail(["account", "password-reset"], /do not match/i, [[/reset token/i, reset], [/new password/i, resetPassword], [/confirm/i, `${resetPassword} typo`]]);
  assert.equal(f.requests(), before, "a mismatched confirmation never reaches the API");
  assert.deepEqual(await guest.ok(["account", "password-reset"], [[/reset token/i, reset], [/new password/i, resetPassword], [/confirm/i, resetPassword]]), { status: "reset" });
  assert.equal((await f.api("POST", "/v1/auth/login", undefined, { email: "requester@example.com", password: firstPassword })).statusCode, 401);
  assert.equal((await f.api("POST", "/v1/auth/login", undefined, { email: "requester@example.com", password: resetPassword })).statusCode, 200);

  const first = await owner.ok<AuditPage>(["admin", "audit", "--limit", "2"]);
  assert.equal(first.events.length, 2);
  assert.equal(typeof first.nextCursor, "string");
  const second = await owner.ok<AuditPage>(["admin", "audit", "--limit", "2", "--cursor", String(first.nextCursor)]);
  assert.equal(second.events.some((event) => first.events.some((seen) => seen.id === event.id)), false);
  const actions = (await owner.ok<AuditPage>(["admin", "audit", "--limit", "100"])).events.map((event) => `${event.action}:${event.decision}`);
  for (const action of ["admin.registration.invite:allow", "admin.registration.update:allow", "admin.user.approve:allow", "auth.registration.invitation.accept:allow"]) {
    assert.ok(actions.includes(action), action);
  }
  f.assertNoSecrets([PASSWORD, firstPassword, resetPassword, `${resetPassword} typo`, inviteToken, verification, reset]);
});

test("CLI self-service password, email and MFA management keeps secrets in prompts and reserved private files", async (t) => {
  const f = await fixture(t);
  let member = await f.session("member");
  const enrollmentFile = path.join(f.directory, "totp-enrollment.json");
  const recoveryFile = path.join(f.directory, "recovery-codes.json");

  // The setup file is reserved (new, private, empty) before the password prompt and before any request.
  let before = f.requests();
  const enrolled = await member.ok<Enrolled>(["account", "mfa-enroll", "--label", "CLI authenticator", "--output", enrollmentFile], [[/current password/i, async () => {
    const reserved = await stat(enrollmentFile);
    assert.equal(reserved.size, 0);
    assert.equal(reserved.mode & 0o777, 0o600);
    assert.equal(f.requests(), before);
    return PASSWORD;
  }]]);
  assert.equal(enrolled.enrollment.label, "CLI authenticator");
  assert.equal(enrolled.output, enrollmentFile);
  assert.deepEqual(Object.keys(enrolled.enrollment).sort(), ["factorId", "label"]);
  const setup = JSON.parse(await readFile(enrollmentFile, "utf8")) as { enrollment: { factorId: string; otpauthUrl: string; secret: string } };
  assert.equal(setup.enrollment.factorId, enrolled.enrollment.factorId);
  assert.match(setup.enrollment.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.equal((await stat(enrollmentFile)).mode & 0o777, 0o600);
  const seed = setup.enrollment.secret;
  before = f.requests();
  await member.fail(["account", "mfa-enroll", "--output", enrollmentFile], /already exists/i);
  assert.equal(f.requests(), before, "an existing setup file is refused before a new seed is issued");

  const factorId = enrolled.enrollment.factorId;
  await member.fail(["account", "mfa-confirm", factorId, "--output", recoveryFile], /INVALID_MFA_CODE/, [[/code/i, async () => {
    assert.equal((await stat(recoveryFile)).size, 0, "recovery output is reserved before the confirmation request");
    return invalidTotpCode(seed);
  }]]);
  await assert.rejects(readFile(recoveryFile), { code: "ENOENT" }, "a failed confirmation removes only its own reservation");
  const confirmed = await member.ok<{ mfa: { factor: { status: string } } }>(["account", "mfa-confirm", factorId, "--output", recoveryFile], [[/code/i, async () => {
    await assert.rejects(writeFile(recoveryFile, "replacement\n", { flag: "wx" }), { code: "EEXIST" }, "a concurrent writer cannot take the reserved path");
    return generateTotpCode(seed);
  }]]);
  assert.equal(confirmed.mfa.factor.status, "enabled");
  assert.equal("recoveryCodes" in confirmed.mfa, false);
  const recovery = (JSON.parse(await readFile(recoveryFile, "utf8")) as { mfa: { recoveryCodes: string[] } }).mfa.recoveryCodes;
  assert.ok(recovery.length >= 4);
  assert.equal((await stat(recoveryFile)).mode & 0o777, 0o600);
  const status = (await member.ok<MfaStatus>(["account", "mfa-status"])).mfa;
  assert.equal(status.totpEnabled, true);
  assert.equal(status.recoveryCodesRemaining, recovery.length);
  await member.fail(["account", "mfa-disable"], /MFA_VERIFICATION_REQUIRED/, [[/current password/i, PASSWORD]]);

  member = await f.session("member", { recoveryCode: recovery[0] });
  await member.fail(["account", "change-email", "--email", "renamed@example.com"], /INVALID_CREDENTIALS/, [[/current password/i, "wrong password value"]]);
  assert.deepEqual(await member.ok(["account", "change-email", "--email", "renamed@example.com"], [[/current password/i, PASSWORD]]), { status: "pending" });
  const emailChange = f.mail.emailChanges.at(-1)!;
  assert.equal(emailChange.email, "renamed@example.com");
  assert.deepEqual(await f.client().ok(["account", "confirm-email-change"], [[/email change token/i, emailChange.token]]), { status: "changed" });
  await member.fail(["account", "mfa-status"], /AUTHENTICATION_REQUIRED/);

  const changedPassword = "changed member passphrase 3";
  member = await f.session("member", { email: "renamed@example.com", recoveryCode: recovery[1] });
  before = f.requests();
  await member.fail(["account", "change-password"], /do not match/i, [[/current password/i, PASSWORD], [/new password/i, changedPassword], [/confirm/i, "different value"]]);
  assert.equal(f.requests(), before);
  assert.deepEqual(await member.ok(["account", "change-password"], [[/current password/i, PASSWORD], [/new password/i, changedPassword], [/confirm/i, changedPassword]]), { status: "changed" });
  await member.fail(["account", "mfa-status"], /AUTHENTICATION_REQUIRED/);

  member = await f.session("member", { email: "renamed@example.com", password: changedPassword, recoveryCode: recovery[2] });
  const disabled = (await member.ok<{ mfa: { status: string; disabledFactors: number } }>(["account", "mfa-disable"], [[/current password/i, changedPassword]])).mfa;
  assert.equal(disabled.status, "disabled");
  assert.ok(disabled.disabledFactors >= 1);
  const plain = await f.api("POST", "/v1/auth/login", undefined, { email: "renamed@example.com", password: changedPassword });
  assert.equal(plain.json().mfaRequired, false);
  const apiToken = (await f.api("POST", "/v1/auth/api-tokens", plain.json().token, { name: "profile", scopes: ["profile:read"] })).json().token.token as string;
  const apiClient = f.client(apiToken, "api");
  await apiClient.fail(["account", "mfa-status"], /API_TOKEN_SCOPE_REQUIRED/);
  await apiClient.fail(["account", "change-password"], /SESSION_AUTH_REQUIRED/, [[/current password/i, changedPassword], [/new password/i, "x".repeat(20)], [/confirm/i, "x".repeat(20)]]);
  f.assertNoSecrets([PASSWORD, changedPassword, seed, ...recovery, emailChange.token, "wrong password value", apiToken]);
});

test("CLI MFA reports, and does not retry, an activation whose one-time output was lost", async (t) => {
  const f = await fixture(t);
  const member = await f.session("member");
  const lostSetup = path.join(f.directory, "lost-setup.json");
  await member.fail(["account", "mfa-enroll", "--output", lostSetup], /pending MFA factor was created.*Nothing was enabled/is, [[/current password/i, async () => {
    await rm(lostSetup);
    return PASSWORD;
  }]]);
  assert.equal((await member.ok<MfaStatus>(["account", "mfa-status"])).mfa.totpEnabled, false);

  const setupFile = path.join(f.directory, "setup.json");
  const factorId = (await member.ok<Enrolled>(["account", "mfa-enroll", "--output", setupFile], [[/current password/i, PASSWORD]])).enrollment.factorId;
  const seed = (JSON.parse(await readFile(setupFile, "utf8")) as { enrollment: { secret: string } }).enrollment.secret;
  const lostCodes = path.join(f.directory, "lost-codes.json");
  const before = f.requests();
  await member.fail(["account", "mfa-confirm", factorId, "--output", lostCodes], /MFA is now enabled.*could not be saved.*Do not rerun/is, [[/code/i, async () => {
    await rm(lostCodes);
    return generateTotpCode(seed);
  }]]);
  assert.equal(f.requests(), before + 1, "confirmation is sent once and never retried");
  await assert.rejects(readFile(lostCodes), { code: "ENOENT" });
  const status = (await member.ok<MfaStatus>(["account", "mfa-status"])).mfa;
  assert.equal(status.totpEnabled, true);
  assert.ok(status.recoveryCodesRemaining > 0);
  f.assertNoSecrets([PASSWORD, seed]);
});

test("CLI admin control plane needs an MFA-verified owner or admin session and keeps owner safeguards", async (t) => {
  const f = await fixture(t);
  const owner = await f.session("owner", { mfa: true });
  const admin = await f.session("admin", { mfa: true });
  const unverifiedAdmin = await f.session("admin-no-mfa");
  let member = await f.session("member");
  const ownerApi = f.client((await f.api("POST", "/v1/auth/api-tokens", owner.token(), { name: "owner read", scopes: ["profile:read"] })).json().token.token, "api");
  for (const args of [["admin", "users", "list"], ["admin", "branding", "get"], ["admin", "site", "get"], ["admin", "registration", "get"], ["admin", "providers", "list"], ["admin", "tokens", "list"], ["admin", "audit"]]) {
    const before = f.requests();
    await member.fail(args, /ADMIN_ROLE_REQUIRED/);
    await unverifiedAdmin.fail(args, /MFA_VERIFICATION_REQUIRED/);
    await ownerApi.fail(args, /API_TOKEN_SCOPE_REQUIRED/);
    assert.equal(f.requests(), before + 3, `${args.join(" ")} denial comes from the API`);
  }

  const branding = { text: "Platform Skills", showText: false, logoDataUrl: null };
  assert.deepEqual((await admin.ok<{ branding: typeof branding }>(["admin", "branding", "set", "--input", await f.input("branding", branding)])).branding, branding);
  assert.deepEqual((await admin.ok<{ branding: typeof branding }>(["admin", "branding", "get"])).branding, branding);
  assert.deepEqual((await f.client().ok<{ branding: typeof branding }>(["instance", "branding"])).branding, branding);
  assert.equal((await admin.ok<{ site: { landingPageEnabled: boolean } }>(["admin", "site", "set", "--landing-page", "disabled"])).site.landingPageEnabled, false);
  assert.equal((await f.client().ok<{ site: { landingPageEnabled: boolean } }>(["instance", "site"])).site.landingPageEnabled, false);
  assert.equal((await owner.ok<{ site: { landingPageEnabled: boolean } }>(["admin", "site", "set", "--landing-page", "enabled"])).site.landingPageEnabled, true);

  const provider = { type: "oidc", displayName: "Corporate SSO", issuer: "https://sso.example.test", clientId: "myskills-cli", enabled: false, roleMappings: [{ claim: "groups", value: "skill-authors", role: "author" }] };
  const saved = (await admin.ok<{ provider: { key: string; clientId: string } }>(["admin", "providers", "set", "corp-sso", "--input", await f.input("provider", provider)])).provider;
  assert.equal(saved.key, "corp-sso");
  assert.equal(saved.clientId, "myskills-cli");
  assert.deepEqual((await admin.ok<{ providers: Array<{ key: string }> }>(["admin", "providers", "list"])).providers.map((item) => item.key), ["corp-sso"]);

  await admin.fail(["admin", "users", "roles", "member", "--role", "admin"], /OWNER_ROLE_UPDATE_REQUIRES_OWNER/);
  const promoted = await admin.ok<{ user: AdminUser }>(["admin", "users", "roles", "member", "--role", "author", "--role", "maintainer", "--reason", "Maintains CLI skills"]);
  assert.deepEqual(promoted.user.roles, ["maintainer", "author"]);
  await member.fail(["account", "mfa-status"], /AUTHENTICATION_REQUIRED/);
  await owner.fail(["admin", "users", "roles", "owner", "--role", "admin"], /SELF_ROLE_CHANGE_PREVENTED/);
  await admin.fail(["admin", "users", "action", "owner", "--action", "disable"], /OWNER_ACTION_REQUIRES_OWNER/);
  await owner.fail(["admin", "users", "action", "owner", "--action", "disable"], /SELF_LOCKOUT_PREVENTED/);
  assert.equal((await owner.ok<{ user: AdminUser }>(["admin", "users", "action", "admin-no-mfa", "--action", "disable", "--reason", "Requires MFA first"])).user.status, "disabled");
  await unverifiedAdmin.fail(["admin", "users", "list"], /AUTHENTICATION_REQUIRED/);

  member = await f.session("member");
  const raw = (await f.api("POST", "/v1/auth/api-tokens", member.token(), { name: "member automation", scopes: ["profile:read", "skills:read"] })).json().token as { id: string; token: string };
  const listed = await admin.ok<{ tokens: AdminToken[] }>(["admin", "tokens", "list"]);
  assert.equal(listed.tokens.find((token) => token.id === raw.id)?.name, "member automation");
  assert.equal(JSON.stringify(listed).includes(raw.token), false);
  assert.equal((await f.api("GET", "/v1/me", raw.token)).statusCode, 200);
  assert.ok((await admin.ok<{ token: AdminToken }>(["admin", "tokens", "revoke", raw.id])).token.revokedAt);
  assert.equal((await f.api("GET", "/v1/me", raw.token)).statusCode, 401);

  assert.equal(typeof (await owner.ok<{ sharing: { teamsEnabled: boolean } }>(["admin", "sharing", "get"])).sharing.teamsEnabled, "boolean", "legacy admin sharing still dispatches");
  const audit = (await owner.ok<AuditPage>(["admin", "audit", "--limit", "100"])).events.map((event) => `${event.action}:${event.decision}`);
  for (const action of ["admin.user.roles.update:allow", "admin.user.roles.update:deny", "admin.user.disable:deny", "admin.user.disable:allow", "admin.api_token.revoke:allow", "admin.provider.upsert:allow", "admin.branding.update:allow", "admin.site.update:allow"]) {
    assert.ok(audit.includes(action), action);
  }
  f.assertNoSecrets([PASSWORD, raw.token, ownerApi.token()]);
});

test("CLI connection grants and instance metadata use the real OAuth service and public endpoints", async (t) => {
  const f = await fixture(t, { oauth: true });
  const guest = f.client();
  const connector = (await guest.ok<{ connector: { enabled: boolean; mcpUrl: string } }>(["connections", "info"])).connector;
  assert.equal(connector.enabled, true);
  assert.equal(connector.mcpUrl, RESOURCE);
  let before = f.requests();
  await guest.fail(["connections", "list"], /No token|login/i);
  assert.equal(f.requests(), before, "a missing credential is reported before the network");

  const member = await f.session("member");
  const owner = await f.session("owner");
  const grant = await f.connect(member.token());
  const [connection, ...others] = (await member.ok<{ connections: Connection[] }>(["connections", "list"])).connections;
  assert.ok(connection);
  assert.equal(others.length, 0);
  assert.equal(JSON.stringify(connection).includes("myskills_"), false, "grant listings never include OAuth token material");
  assert.deepEqual((await owner.ok<{ connections: Connection[] }>(["connections", "list"])).connections, []);
  await owner.fail(["connections", "revoke", connection.id], /OAUTH_CONNECTION_NOT_FOUND/);
  assert.equal((await f.api("GET", "/v1/mcp/session", grant.access_token)).statusCode, 200);
  assert.ok((await member.ok<{ connection: Connection }>(["connections", "revoke", connection.id])).connection.revokedAt);
  assert.equal((await f.api("GET", "/v1/mcp/session", grant.access_token)).statusCode, 401);
  assert.deepEqual((await member.ok<{ connections: Connection[] }>(["connections", "list"])).connections, []);
  const memberApi = f.client((await f.api("POST", "/v1/auth/api-tokens", member.token(), { name: "profile", scopes: ["profile:read"] })).json().token.token, "api");
  await memberApi.fail(["connections", "list"], /API_TOKEN_SCOPE_REQUIRED/);

  const info = await member.ok<{ health: { ok: boolean }; version: { version: string } }>(["instance", "info"]);
  assert.equal(info.health.ok, true);
  assert.equal(typeof info.version.version, "string");
  assert.equal(f.lastAuthorization(), undefined, "public metadata does not carry the stored session");
  assert.equal((await member.ok<{ ok: boolean; service: string }>(["instance", "health"])).service, "myskills-app-api");
  assert.equal((await member.ok<{ version: string }>(["instance", "version"])).version, info.version.version);
  assert.equal((await member.ok<{ capabilities: { auth: boolean } }>(["instance", "capabilities"])).capabilities.auth, true);
  assert.equal(f.lastAuthorization(), undefined);
  assert.equal((await member.ok<{ ok: boolean }>(["instance", "ready"])).ok, true);
  const unready = await fixture(t);
  await unready.client().fail(["instance", "ready"], /.+/);
  before = f.requests();
  await member.fail(["instance", "info", "extra"], /requires 0 arguments/);
  assert.equal(f.requests(), before);
  f.assertNoSecrets([PASSWORD, grant.access_token, grant.refresh_token]);
});

test("CLI account and admin commands reject secret flags and invalid input before any request", async (t) => {
  const f = await fixture(t);
  const owner = f.client("offline-session-token");
  const existing = path.join(f.directory, "existing.json");
  await writeFile(existing, "{}\n");
  const codes = path.join(f.directory, "codes.json");
  const flagSecret = "flag-secret-value-that-must-not-echo";
  const providerSecret = "provider-client-secret-value";
  const provider = await f.input("provider", { type: "oidc", displayName: "SSO" });
  const secretProvider = await f.input("secret-provider", { type: "oidc", displayName: "SSO", settings: { clientSecret: providerSecret } });
  const cases: Array<[string[], RegExp]> = [
    [["account", "change-password", "--password", flagSecret], /--password is not accepted; secrets are read from a hidden prompt/],
    [["account", "register", "--email", "x@example.com", "--password", flagSecret], /--password is not accepted/],
    [["account", "password-reset", "--reset-token", flagSecret], /--reset-token is not accepted/],
    [["account", "mfa-confirm", "factor-1", "--code", flagSecret, "--output", codes], /--code is not accepted/],
    [["account", "verify-email", flagSecret], /requires 0 arguments/],
    [["account", "register"], /--email is required/],
    [["account", "register", "--email", "not-an-email"], /Invalid --email/],
    [["account", "change-email", "--email", "a@example.com", "--email", "b@example.com"], /--email requires one non-empty value/],
    [["account", "mfa-enroll"], /--output is required/],
    [["account", "mfa-enroll", "--output", existing], /already exists/],
    [["account", "mfa-confirm", "factor-1", "--output", path.join(f.directory, "missing", "codes.json")], /directory must already exist/],
    [["account", "mfa-confirm", "../factor", "--output", codes], /Invalid factor-id/],
    [["account", "unknown-action"], /Usage: myskills account /],
    [["connections", "revoke", "../../v1/admin/users"], /Invalid connection-id/],
    [["admin", "users", "action", "user-1", "--action", "suspend"], /--action must be/],
    [["admin", "users", "action", "user%2F1", "--action", "disable"], /Invalid user-id/],
    [["admin", "users", "roles", "user-1"], /--role is required/],
    [["admin", "users", "roles", "user-1", "--role", "superuser"], /--role must be/],
    [["admin", "registration", "set", "--mode", "public"], /--mode must be/],
    [["admin", "registration", "invite", "--email", "invalid"], /Invalid --email/],
    [["admin", "site", "set", "--landing-page", "maybe"], /--landing-page must be/],
    [["admin", "providers", "set", "Corp_SSO", "--input", provider], /Invalid provider-key/],
    [["admin", "providers", "set", "corp-sso", "--input", secretProvider], /Provider secrets are not accepted/],
    [["admin", "audit", "--limit", "101"], /--limit must be an integer between 1 and 100/],
    [["admin", "audit", "--limit", "2", "--limit", "3"], /--limit requires one non-empty value/],
    [["admin", "tokens", "revoke", "token.id"], /Invalid token-id/],
    [["admin", "branding", "set"], /--input is required/],
    [["admin", "users", "list", "extra"], /requires 0 arguments/],
    [["instance", "capabilities", "--limit", "1"], /Unsupported option --limit/],
  ];
  for (const [args, pattern] of cases) {
    const before = f.requests();
    await owner.fail(args, pattern);
    assert.equal(f.requests(), before, args.join(" "));
  }
  await assert.rejects(readFile(codes), { code: "ENOENT" }, "rejected commands do not reserve output files");
  const guest = f.client();
  const before = f.requests();
  await guest.fail(["account", "verify-email"], /Verification token is required/, [[/verification token/i, ""]]);
  await guest.fail(["account", "register", "--email", "new@example.com"], /do not match/, [[/new password/i, "first password value"], [/confirm/i, "second password value"]]);
  const offline = f.client("offline-session-token", "session", false);
  await offline.fail(["account", "confirm-email-change"], /INTERACTIVE_INPUT_REQUIRED|interactive/i);
  await offline.fail(["account", "mfa-enroll", "--output", codes], /INTERACTIVE_INPUT_REQUIRED|interactive/i);
  await assert.rejects(readFile(codes), { code: "ENOENT" }, "an abandoned prompt removes the CLI's own reservation");
  assert.equal(f.requests(), before);
  f.assertNoSecrets([flagSecret, providerSecret, "first password value", "second password value"]);
});

function invalidTotpCode(secret: string): string {
  const now = Date.now();
  const valid = new Set([-60_000, -30_000, 0, 30_000, 60_000].map((offset) => generateTotpCode(secret, { now: now + offset })));
  return ["000000", "111111", "222222", "333333", "444444", "555555"].find((code) => !valid.has(code))!;
}

async function fixture(t: TestContext, options: { oauth?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myskills-account-admin-parity-"));
  const authStore = new MemoryAuthStore("closed");
  const mail = {
    invitations: [] as Array<{ email: string; token: string }>,
    verifications: [] as Array<{ email: string; token: string }>,
    resets: [] as Array<{ email: string; token: string }>,
    emailChanges: [] as Array<{ email: string; token: string }>,
  };
  const sink: AuthNotificationSink = {
    sendEmailVerification: ({ email, token }) => { mail.verifications.push({ email, token }); },
    sendPasswordReset: ({ email, token }) => { mail.resets.push({ email, token }); },
    sendRegistrationInvitation: ({ email, token }) => { mail.invitations.push({ email, token }); },
    sendEmailChangeVerification: ({ email, token }) => { mail.emailChanges.push({ email, token }); },
  };
  const oauthService = options.oauth ? new OAuthService({
    store: new MemoryOAuthStore(authStore),
    authStore,
    config: parseOAuthConfig({
      NODE_ENV: "production", MYSKILLS_OAUTH_ENABLED: "true", MYSKILLS_OAUTH_ISSUER: ORIGIN, MYSKILLS_MCP_PUBLIC_URL: RESOURCE,
      APP_BASE_URL: ORIGIN, MYSKILLS_OAUTH_DYNAMIC_REGISTRATION: "true", MYSKILLS_OAUTH_REDIRECT_HOSTS: "chatgpt.example.test",
    })!,
  }) : undefined;
  const passwordHash = await hashPassword(PASSWORD);
  for (const [id, roles] of [["owner", ["owner"]], ["admin", ["admin"]], ["admin-no-mfa", ["admin"]], ["member", ["user"]]] as const) {
    authStore.addUser({ id, email: `${id}@example.com`, name: id, roles: [...roles], status: "active", emailVerifiedAt: new Date(), passwordHash });
  }
  const app = buildApp({
    skillRepository: new MemorySkillRepository([]),
    authService: new AuthService(authStore, { notificationSink: sink, mfaSecretKey: AUTH_SECRET, ...(oauthService ? { oauthAccessTokens: oauthService } : {}) }),
    ...(oauthService ? { oauthService, allowedOrigins: [ORIGIN], readinessProbes: { postgres: async () => {} } } : {}),
  });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  let requestCount = 0;
  let lastAuthorization: string | undefined;
  const transcript: string[] = [];
  const api = (method: "GET" | "POST", url: string, token?: string, payload?: Record<string, unknown>) => app.inject({
    method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload,
  });

  const client = (rawToken?: string, kind: "session" | "api" = "session", interactive = true) => {
    let stored: StoredCliToken | null = rawToken ? { token: rawToken, kind } : null;
    const stdout: string[] = [];
    const stderr: string[] = [];
    let prompts: Prompt[] = [];
    const unexpected: string[] = [];
    const runtime: CliRuntime = {
      env: {}, io: { stdout: (line) => { stdout.push(line); transcript.push(line); }, stderr: (line) => { stderr.push(line); transcript.push(line); } },
      tokenStore: {
        get: async () => stored, set: async (_url, value) => { stored = value; }, delete: async () => { stored = null; },
        describe: () => ({ backend: "memory" }),
      },
      ...(interactive ? {
        prompt: {
          text: async (label: string) => { unexpected.push(label); throw new Error("Unexpected text prompt."); },
          secret: async (label: string) => {
            const next = prompts.shift();
            if (!next || !next[0].test(label)) { unexpected.push(label); throw new Error("Unexpected secret prompt."); }
            return typeof next[1] === "string" ? next[1] : next[1]();
          },
        },
      } : {}),
      fetch: async (input, init) => {
        requestCount += 1;
        lastAuthorization = init?.headers?.authorization;
        const url = new URL(input);
        const result = await app.inject({ method: (init?.method ?? "GET") as "GET", url: `${url.pathname}${url.search}`, headers: init?.headers, payload: init?.body });
        return { ok: result.statusCode >= 200 && result.statusCode < 300, status: result.statusCode, headers: result.headers as Record<string, string>, text: async () => result.body };
      },
    };
    async function run(args: string[], answers: Prompt[]) {
      stdout.length = 0; stderr.length = 0; unexpected.length = 0;
      prompts = [...answers];
      const code = await runCli([...args, "--api-url", "http://api.test", "--json"], runtime);
      assert.deepEqual(unexpected, [], `${args.join(" ")} prompted unexpectedly`);
      assert.equal(prompts.length, 0, `${args.join(" ")} left scripted secrets unused`);
      return code;
    }
    return {
      token: () => stored?.token ?? "",
      async ok<T = Record<string, unknown>>(args: string[], answers: Prompt[] = []): Promise<T> {
        assert.equal(await run(args, answers), 0, `${args.join(" ")}: ${stderr.join("\n")}`);
        return (stdout.length ? JSON.parse(stdout.join("\n")) : {}) as T;
      },
      async fail(args: string[], pattern: RegExp, answers: Prompt[] = []) {
        assert.notEqual(await run(args, answers), 0, args.join(" "));
        assert.match(stderr.join("\n"), pattern, args.join(" "));
      },
    };
  };

  return {
    directory, mail, client, api,
    requests: () => requestCount,
    lastAuthorization: () => lastAuthorization,
    drain: () => new AuthNotificationWorker(authStore, sink, { secret: AUTH_SECRET }).runOnce(),
    async input(name: string, value: Record<string, unknown>) {
      const file = path.join(directory, `${name}.json`);
      await writeFile(file, JSON.stringify(value));
      return file;
    },
    assertNoSecrets(values: string[]) {
      const text = transcript.join("\n");
      for (const value of values) assert.equal(text.includes(value), false, "terminal output contains secret material");
    },
    async session(id: string, login: { mfa?: boolean; email?: string; password?: string; recoveryCode?: string } = {}) {
      const credentials = { email: login.email ?? `${id}@example.com`, password: login.password ?? PASSWORD };
      let response = await api("POST", "/v1/auth/login", undefined, credentials);
      assert.equal(response.statusCode, 200, response.body);
      let token = response.json().token as string;
      if (login.mfa) {
        const enroll = await api("POST", "/v1/auth/mfa/totp/enroll", token, { password: credentials.password });
        const confirm = await api("POST", "/v1/auth/mfa/totp/confirm", token, { factorId: enroll.json().enrollment.factorId, code: generateTotpCode(enroll.json().enrollment.secret) });
        assert.equal(confirm.statusCode, 200, confirm.body);
        response = await api("POST", "/v1/auth/login", undefined, credentials);
        login = { ...login, recoveryCode: confirm.json().mfa.recoveryCodes[0] };
      }
      if (login.recoveryCode) {
        const verified = await api("POST", "/v1/auth/mfa/verify", undefined, { challengeToken: response.json().challengeToken, recoveryCode: login.recoveryCode });
        assert.equal(verified.statusCode, 200, verified.body);
        token = verified.json().token;
      }
      return client(token);
    },
    async connect(session: string) {
      const registered = await app.inject({ method: "POST", url: "/oauth/register", payload: { client_name: "ChatGPT", redirect_uris: [CONNECTOR_REDIRECT], token_endpoint_auth_method: "none" } });
      assert.equal(registered.statusCode, 201, registered.body);
      const clientId = registered.json().client_id as string;
      const verifier = randomBytes(32).toString("base64url");
      const authorize = await app.inject({ method: "GET", url: `/oauth/authorize?${new URLSearchParams({
        response_type: "code", client_id: clientId, redirect_uri: CONNECTOR_REDIRECT, resource: RESOURCE, state: "state-1",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      })}` });
      const handle = new URLSearchParams(new URL(String(authorize.headers.location)).hash.slice(1)).get("request");
      const decision = await app.inject({ method: "POST", url: "/v1/oauth/consent/decision", headers: { authorization: `Bearer ${session}` }, payload: { request: handle, decision: "approve" } });
      assert.equal(decision.statusCode, 200, decision.body);
      const code = new URL(decision.json().redirectTo).searchParams.get("code")!;
      const exchanged = await app.inject({
        method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CONNECTOR_REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE }).toString(),
      });
      assert.equal(exchanged.statusCode, 200, exchanged.body);
      return exchanged.json() as { access_token: string; refresh_token: string };
    },
  };
}
