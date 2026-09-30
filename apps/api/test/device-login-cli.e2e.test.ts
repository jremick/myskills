import assert from "node:assert/strict";
import test from "node:test";
import { createSessionToken, hashSessionToken } from "@myskills-app/auth";
import { runCli, type StoredCliToken } from "../../cli/src/cli.js";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemoryDeviceLoginStore } from "../src/auth/device-login/memory-store.js";
import { DeviceLoginService } from "../src/auth/device-login/service.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

// Failure scenarios: browser denial overwrites credentials; CLI sends an old
// bearer on anonymous polling; scopes widen; token prints; consent never occurs.
test("real CLI browser login polls the real HTTP API and stores only the authorized scoped credential", { timeout: 25_000 }, async (t) => {
  const auth = new MemoryAuthStore();
  const user = auth.addUser({ email: "cli-device@example.com", status: "active", emailVerifiedAt: new Date(), roles: ["user"] });
  const session = createSessionToken();
  await auth.createSession({ userId: user.id, tokenHash: hashSessionToken(session), expiresAt: new Date(Date.now() + 3_600_000) });
  const app = buildApp({ skillRepository: new MemorySkillRepository([]), authService: new AuthService(auth), deviceLoginService: new DeviceLoginService(new MemoryDeviceLoginStore(auth), { verificationUri: "http://127.0.0.1:3000/auth/device" }) });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  let saved: StoredCliToken | null = null;
  const output: string[] = [];
  let decision: "approve" | "deny" = "approve";
  const runtime = {
    env: {}, io: { stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line) },
    tokenStore: { get: async () => saved, set: async (_: string, token: StoredCliToken) => { saved = token; }, delete: async () => { saved = null; } },
    fetch: async (url: string, init?: Parameters<typeof fetch>[1]) => {
      if (url.includes("/v1/auth/device/")) assert.equal(new Headers(init?.headers).has("authorization"), false);
      const response = await fetch(url, init);
      if (url.endsWith("/start")) {
        const request = await response.clone().json();
        const inspect = await fetch(`${apiUrl}/v1/auth/device/inspect`, { method: "POST", headers: { authorization: `Bearer ${session}`, "content-type": "application/json" }, body: JSON.stringify({ userCode: request.userCode }) });
        assert.deepEqual((await inspect.json()).scopes, ["profile:read", "skills:read"]);
        const consent = await fetch(`${apiUrl}/v1/auth/device/decision`, { method: "POST", headers: { authorization: `Bearer ${session}`, "content-type": "application/json" }, body: JSON.stringify({ userCode: request.userCode, decision }) });
        assert.equal(consent.status, 200);
      }
      return response;
    },
  };
  assert.equal(await runCli(["login", "--method", "browser", "--api-url", apiUrl, "--scopes", "profile:read,skills:read"], runtime), 0);
  const stored = saved as StoredCliToken | null;
  assert.ok(stored && stored.kind === "api");
  assert.equal(output.join("\n").includes(stored.token), false);
  assert.equal((await fetch(`${apiUrl}/v1/me`, { headers: { authorization: `Bearer ${stored.token}` } })).status, 200);
  decision = "deny";
  assert.equal(await runCli(["login", "--method", "browser", "--api-url", apiUrl, "--scopes", "profile:read,skills:read"], runtime), 1);
  assert.deepEqual(saved, stored);
  t.diagnostic(JSON.stringify({ journey: "real CLI → loopback HTTP API → browser consent endpoints → scoped credential → denial preserves previous credential", tokenPrinted: false }));
});
