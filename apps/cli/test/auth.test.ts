import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "@ai-skills-share/auth";
import { buildApp } from "../../api/src/app.js";
import { AuthService } from "../../api/src/auth/service.js";
import { MemoryAuthStore } from "../../api/src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../../api/src/repositories/memory-skill-repository.js";
import { runCli, type CliPrompt, type CliTokenStore, type FetchLike, type StoredCliToken } from "../src/cli.js";

test("help documents login, logout, and stored token fallback", async () => {
  const output = createOutput();

  const code = await runCli(["help"], testRuntime(output));

  assert.equal(code, 0);
  assert.match(output.stdout.join("\n"), /login \[--api-url <url>\] \[--email <email>\]/);
  assert.match(output.stdout.join("\n"), /logout \[--api-url <url>\] \[--token <token>\]/);
  assert.match(output.stdout.join("\n"), /stored login token/);
});

test("login posts prompted credentials, stores session token, and does not print secrets", async () => {
  const output = createOutput();
  const tokenStore = new MemoryTokenStore();
  let body: Record<string, unknown> = {};
  let authorization = "";
  const fetch: FetchLike = async (_input, init) => {
    authorization = init?.headers?.authorization ?? "";
    body = JSON.parse(init?.body ?? "{}");
    return response(200, loginSuccess("session-secret"));
  };

  const code = await runCli([
    "login",
    "--email",
    "owner@example.com",
    "--api-url",
    "http://api.test/",
  ], testRuntime(output, fetch, {}, tokenStore, promptFixture({ secrets: ["correct horse battery staple"] })));

  assert.equal(code, 0);
  assert.equal(authorization, "");
  assert.deepEqual(body, {
    email: "owner@example.com",
    password: "correct horse battery staple",
  });
  assert.deepEqual(await tokenStore.get("http://api.test"), {
    kind: "session",
    token: "session-secret",
    email: "owner@example.com",
    expiresAt: "2026-12-01T00:00:00.000Z",
  });
  assert.equal(output.stdout.join("\n").includes("session-secret"), false);
  assert.equal(output.stderr.join("\n").includes("correct horse"), false);
});

test("login does not overwrite stored token on failed authentication", async () => {
  const output = createOutput();
  const tokenStore = new MemoryTokenStore({
    "http://api.test": { kind: "session", token: "existing-session" },
  });
  const fetch: FetchLike = async () => response(401, {
    error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." },
  });

  const code = await runCli([
    "login",
    "--email",
    "owner@example.com",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, {}, tokenStore, promptFixture({ secrets: ["wrong password"] })));

  assert.equal(code, 1);
  assert.deepEqual(await tokenStore.get("http://api.test"), { kind: "session", token: "existing-session" });
  assert.match(output.stderr.join("\n"), /Invalid email or password/);
});

test("login completes MFA with TOTP and stores only the verified session token", async () => {
  const output = createOutput();
  const tokenStore = new MemoryTokenStore();
  const bodies: Array<Record<string, unknown>> = [];
  const fetch: FetchLike = async (input, init) => {
    bodies.push(JSON.parse(init?.body ?? "{}"));
    if (String(input).endsWith("/v1/auth/login")) {
      return response(200, {
        mfaRequired: true,
        challengeToken: "challenge-secret",
        expiresAt: "2026-12-01T00:05:00.000Z",
        user: { email: "owner@example.com" },
      });
    }
    return response(200, loginSuccess("verified-session"));
  };

  const code = await runCli([
    "login",
    "--email",
    "owner@example.com",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, {}, tokenStore, promptFixture({ secrets: ["correct horse battery staple", "123456"] })));

  assert.equal(code, 0);
  assert.deepEqual(bodies[1], { challengeToken: "challenge-secret", code: "123456" });
  assert.deepEqual(await tokenStore.get("http://api.test"), {
    kind: "session",
    token: "verified-session",
    email: "owner@example.com",
    expiresAt: "2026-12-01T00:00:00.000Z",
  });
  assert.equal(output.stdout.join("\n").includes("challenge-secret"), false);
});

test("login completes MFA with a recovery code", async () => {
  const output = createOutput();
  const tokenStore = new MemoryTokenStore();
  let verifyBody: Record<string, unknown> = {};
  const fetch: FetchLike = async (input, init) => {
    if (String(input).endsWith("/v1/auth/login")) {
      return response(200, {
        mfaRequired: true,
        challengeToken: "challenge-secret",
        expiresAt: "2026-12-01T00:05:00.000Z",
        user: { email: "owner@example.com" },
      });
    }
    verifyBody = JSON.parse(init?.body ?? "{}");
    return response(200, loginSuccess("verified-session"));
  };

  const code = await runCli([
    "login",
    "--email",
    "owner@example.com",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, {}, tokenStore, promptFixture({ secrets: ["correct horse battery staple", "abcd-efgh-ijkl-mnop"] })));

  assert.equal(code, 0);
  assert.deepEqual(verifyBody, { challengeToken: "challenge-secret", recoveryCode: "abcd-efgh-ijkl-mnop" });
  assert.equal((await tokenStore.get("http://api.test"))?.token, "verified-session");
});

test("login does not store an MFA challenge when verification fails", async () => {
  const output = createOutput();
  const tokenStore = new MemoryTokenStore();
  const fetch: FetchLike = async (input) => {
    if (String(input).endsWith("/v1/auth/login")) {
      return response(200, {
        mfaRequired: true,
        challengeToken: "challenge-secret",
        expiresAt: "2026-12-01T00:05:00.000Z",
        user: { email: "owner@example.com" },
      });
    }
    return response(401, {
      error: { code: "INVALID_MFA_CODE", message: "Invalid MFA code." },
    });
  };

  const code = await runCli([
    "login",
    "--email",
    "owner@example.com",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, {}, tokenStore, promptFixture({ secrets: ["correct horse battery staple", "000000"] })));

  assert.equal(code, 1);
  assert.equal(await tokenStore.get("http://api.test"), null);
  assert.match(output.stderr.join("\n"), /Invalid MFA code/);
});

test("commands use durable tokens when flag and env are absent", async () => {
  const output = createOutput();
  const tokenStore = new MemoryTokenStore({
    "http://api.test": { kind: "session", token: "stored-session" },
  });
  const authorizations: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    authorizations.push(init?.headers?.authorization ?? "");
    if (String(input).endsWith("/v1/me")) {
      return response(200, { user: { email: "owner@example.com", roles: ["owner"], mfaVerified: true } });
    }
    if (String(input).endsWith("/v1/review/submissions")) {
      return response(200, { submissions: [] });
    }
    return response(200, { skills: [] });
  };

  assert.equal(await runCli(["whoami", "--api-url", "http://api.test"], testRuntime(output, fetch, {}, tokenStore)), 0);
  assert.equal(await runCli(["review", "submissions", "--api-url", "http://api.test"], testRuntime(output, fetch, {}, tokenStore)), 0);
  assert.equal(await runCli(["search", "--api-url", "http://api.test"], testRuntime(output, fetch, {}, tokenStore)), 0);
  assert.deepEqual(authorizations, [
    "Bearer stored-session",
    "Bearer stored-session",
    "Bearer stored-session",
  ]);
});

test("token resolution precedence is token option, env, then durable store", async () => {
  const output = createOutput();
  const tokenStore = new MemoryTokenStore({
    "http://api.test": { kind: "session", token: "stored-session" },
  });
  const authorizations: string[] = [];
  const fetch: FetchLike = async (_input, init) => {
    authorizations.push(init?.headers?.authorization ?? "");
    return response(200, { user: { email: "owner@example.com", roles: ["owner"], mfaVerified: false } });
  };

  assert.equal(await runCli([
    "whoami",
    "--api-url",
    "http://api.test",
    "--token",
    "option-session",
  ], testRuntime(output, fetch, { AI_SKILLS_TOKEN: "env-session" }, tokenStore)), 0);
  assert.equal(await runCli([
    "whoami",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, { AI_SKILLS_TOKEN: "env-session" }, tokenStore)), 0);
  assert.equal(await runCli([
    "whoami",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, {}, tokenStore)), 0);

  assert.deepEqual(authorizations, [
    "Bearer option-session",
    "Bearer env-session",
    "Bearer stored-session",
  ]);
});

test("stored tokens are scoped by normalized api url", async () => {
  const output = createOutput();
  const tokenStore = new MemoryTokenStore();
  let calls = 0;
  const fetch: FetchLike = async () => {
    calls += 1;
    return response(200, loginSuccess("session-secret"));
  };

  assert.equal(await runCli([
    "login",
    "--email",
    "owner@example.com",
    "--api-url",
    "http://api.test/",
  ], testRuntime(output, fetch, {}, tokenStore, promptFixture({ secrets: ["correct horse battery staple"] }))), 0);
  assert.equal(await tokenStore.get("http://api.test"), await tokenStore.get("http://api.test/"));

  const whoami = await runCli([
    "whoami",
    "--api-url",
    "http://other.test",
  ], testRuntime(output, async () => {
    calls += 1;
    return response(500, {});
  }, {}, tokenStore));

  assert.equal(whoami, 1);
  assert.equal(calls, 1);
  assert.match(output.stderr.join("\n"), /No token provided/);
});

test("logout revokes stored sessions and clears the local token", async () => {
  const output = createOutput();
  const tokenStore = new MemoryTokenStore({
    "http://api.test": { kind: "session", token: "stored-session" },
  });
  let method = "";
  let authorization = "";
  const fetch: FetchLike = async (input, init) => {
    assert.equal(String(input), "http://api.test/v1/auth/logout");
    method = init?.method ?? "GET";
    authorization = init?.headers?.authorization ?? "";
    return rawResponse(204, "");
  };

  const code = await runCli(["logout", "--api-url", "http://api.test"], testRuntime(output, fetch, {}, tokenStore));

  assert.equal(code, 0);
  assert.equal(method, "POST");
  assert.equal(authorization, "Bearer stored-session");
  assert.equal(await tokenStore.get("http://api.test"), null);
  assert.deepEqual(output.stdout, ["logged out\tserver-revoked"]);
});

test("logout without a token does not call the API", async () => {
  const output = createOutput();
  let calls = 0;

  const code = await runCli(["logout"], testRuntime(output, async () => {
    calls += 1;
    return response(500, {});
  }, {}, new MemoryTokenStore()));

  assert.equal(code, 1);
  assert.equal(calls, 0);
  assert.match(output.stderr.join("\n"), /Not logged in/);
});

test("logout removes stored API tokens locally without claiming remote revocation", async () => {
  const output = createOutput();
  const tokenStore = new MemoryTokenStore({
    "http://api.test": { kind: "api", token: "aiss_api-token" },
  });
  let calls = 0;

  const code = await runCli(["logout", "--api-url", "http://api.test"], testRuntime(output, async () => {
    calls += 1;
    return response(500, {});
  }, {}, tokenStore));

  assert.equal(code, 0);
  assert.equal(calls, 0);
  assert.equal(await tokenStore.get("http://api.test"), null);
  assert.deepEqual(output.stdout, ["logged out\tlocal-only\tapi-token-not-revoked"]);
});

test("logout using env token does not erase stored credentials", async () => {
  const output = createOutput();
  const tokenStore = new MemoryTokenStore({
    "http://api.test": { kind: "session", token: "stored-session" },
  });
  let authorization = "";
  const fetch: FetchLike = async (_input, init) => {
    authorization = init?.headers?.authorization ?? "";
    return rawResponse(204, "");
  };

  const code = await runCli([
    "logout",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, { AI_SKILLS_TOKEN: "env-session" }, tokenStore));

  assert.equal(code, 0);
  assert.equal(authorization, "Bearer env-session");
  assert.deepEqual(await tokenStore.get("http://api.test"), { kind: "session", token: "stored-session" });
  assert.deepEqual(output.stdout, ["logout requested\tstored-token-unchanged"]);
});

test("token create prints API token once without persisting it over the session", async () => {
  const output = createOutput();
  const tokenStore = new MemoryTokenStore({
    "http://api.test": { kind: "session", token: "stored-session" },
  });
  const fetch: FetchLike = async () => response(201, {
    token: {
      id: "api-token-1",
      name: "Local CLI",
      token: "aiss_plain-secret",
      tokenPrefix: "aiss_plain-s",
      scopes: ["profile:read"],
      expiresAt: "2026-12-01T00:00:00.000Z",
    },
  });

  const code = await runCli([
    "token",
    "create",
    "--name",
    "Local CLI",
    "--scope",
    "profile:read",
    "--api-url",
    "http://api.test",
  ], testRuntime(output, fetch, {}, tokenStore));

  assert.equal(code, 0);
  assert.match(output.stdout.join("\n"), /token: aiss_plain-secret/);
  assert.deepEqual(await tokenStore.get("http://api.test"), { kind: "session", token: "stored-session" });
});

test("CLI login, whoami, and logout match the real API auth contract", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  authStore.addUser({
    id: "owner-1",
    email: "owner@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    roles: ["owner"],
    passwordHash: await hashPassword("correct horse battery staple"),
  });
  const app = buildApp({
    skillRepository: new MemorySkillRepository([]),
    authService: new AuthService(authStore),
  });
  t.after(() => app.close());

  const output = createOutput();
  const tokenStore = new MemoryTokenStore();
  const runtime = testRuntime(
    output,
    appFetch(app),
    {},
    tokenStore,
    promptFixture({ secrets: ["correct horse battery staple"] }),
  );

  assert.equal(await runCli([
    "login",
    "--email",
    "owner@example.com",
    "--api-url",
    "http://api.test",
  ], runtime), 0);
  assert.equal((await tokenStore.get("http://api.test"))?.kind, "session");
  assert.equal(await runCli(["whoami", "--api-url", "http://api.test"], runtime), 0);
  assert.match(output.stdout.join("\n"), /owner@example.com\troles=owner\tmfa=not-verified/);
  assert.equal(await runCli(["logout", "--api-url", "http://api.test"], runtime), 0);
  assert.equal(await tokenStore.get("http://api.test"), null);
});

function loginSuccess(token: string): Record<string, unknown> {
  return {
    mfaRequired: false,
    token,
    expiresAt: "2026-12-01T00:00:00.000Z",
    user: {
      email: "owner@example.com",
      roles: ["owner"],
      mfaVerified: false,
    },
  };
}

function createOutput(): { stdout: string[]; stderr: string[] } {
  return { stdout: [], stderr: [] };
}

function testRuntime(
  output: { stdout: string[]; stderr: string[] },
  fetch: FetchLike = async () => response(500, {}),
  env: Record<string, string | undefined> = {},
  tokenStore?: CliTokenStore,
  prompt?: CliPrompt,
) {
  return {
    env,
    fetch,
    tokenStore,
    prompt,
    io: {
      stdout: (line: string) => output.stdout.push(line),
      stderr: (line: string) => output.stderr.push(line),
    },
  };
}

function promptFixture(input: { texts?: string[]; secrets?: string[] }): CliPrompt {
  const texts = [...(input.texts ?? [])];
  const secrets = [...(input.secrets ?? [])];
  return {
    async text() {
      const next = texts.shift();
      if (next === undefined) {
        throw new Error("Unexpected text prompt.");
      }
      return next;
    },
    async secret() {
      const next = secrets.shift();
      if (next === undefined) {
        throw new Error("Unexpected secret prompt.");
      }
      return next;
    },
  };
}

function appFetch(app: ReturnType<typeof buildApp>): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    const response = await app.inject({
      method: init?.method ?? "GET",
      url: `${url.pathname}${url.search}`,
      headers: init?.headers,
      payload: init?.body,
    });
    return rawResponse(response.statusCode, response.body);
  };
}

function response(status: number, body: Record<string, unknown>) {
  return rawResponse(status, JSON.stringify(body));
}

function rawResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
  };
}

class MemoryTokenStore implements CliTokenStore {
  private readonly tokens = new Map<string, StoredCliToken>();

  constructor(initial: Record<string, StoredCliToken> = {}) {
    for (const [apiUrl, token] of Object.entries(initial)) {
      this.tokens.set(normalizeApiUrl(apiUrl), token);
    }
  }

  async get(apiUrl: string): Promise<StoredCliToken | null> {
    return this.tokens.get(normalizeApiUrl(apiUrl)) ?? null;
  }

  async set(apiUrl: string, token: StoredCliToken): Promise<void> {
    this.tokens.set(normalizeApiUrl(apiUrl), token);
  }

  async delete(apiUrl: string): Promise<void> {
    this.tokens.delete(normalizeApiUrl(apiUrl));
  }
}

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, "");
}
