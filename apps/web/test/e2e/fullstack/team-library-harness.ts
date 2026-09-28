import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { buildApp } from "../../../../api/dist/app.js";
import { AuthService } from "../../../../api/dist/auth/service.js";
import { PostgresAuthStore } from "../../../../api/dist/auth/postgres-auth-store.js";
import { createDb, createPgPool } from "../../../../api/dist/db/client.js";
import { runMigrations } from "../../../../api/dist/db/migrate.js";
import { FixtureGithubSource, LibraryService, PostgresLibraryStore, PublicGithubSourceProvider } from "../../../../api/dist/libraries/index.js";
import { PostgresSkillRepository } from "../../../../api/dist/repositories/postgres-skill-repository.js";
import { SubmissionService } from "../../../../api/dist/submissions/service.js";
import { PostgresSubmissionStore } from "../../../../api/dist/submissions/postgres-submission-store.js";
import { TeamService } from "../../../../api/dist/teams/service.js";
import { PostgresTeamStore } from "../../../../api/dist/teams/postgres-team-store.js";

// Public HTTP JSON is inspected by the journey at the actual response boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
export interface TeamLibraryActor { token: string; user: Json }
const repo = "everyinc/compound-engineering-plugin";
const webDist = fileURLToPath(new URL("../../../dist", import.meta.url));
const contentTypes: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon" };

/** Owns a disposable test database. Never use concurrently with another DB suite. */
export async function startTeamLibraryHarness() {
  const databaseURL = process.env.TEST_DATABASE_URL;
  if (!databaseURL || !/(^|[_-])(test|ci)([_-]|$)/i.test(new URL(databaseURL).pathname.slice(1))) throw new Error("A disposable TEST_DATABASE_URL whose name includes test or ci is required.");
  await readFile(resolve(webDist, "index.html")); // Fail before DB mutation if the build is missing.
  const pool = createPgPool(databaseURL);
  let app: ReturnType<typeof buildApp> | undefined;
  let appURL = "";
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) if (value !== undefined && !["host", "connection", "content-length"].includes(key)) headers[key] = Array.isArray(value) ? value.join(", ") : value;
        const upstream = await fetch(`${appURL}${url.pathname.slice(4)}${url.search}`, { method: request.method, headers, ...(body.length ? { body } : {}) });
        response.statusCode = upstream.status;
        for (const [key, value] of upstream.headers) if (!["transfer-encoding", "connection", "content-encoding", "content-length", "set-cookie"].includes(key)) response.setHeader(key, value);
        const cookies = upstream.headers.getSetCookie();
        if (cookies.length) response.setHeader("set-cookie", cookies);
        response.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      const requested = resolve(webDist, `.${decodeURIComponent(url.pathname)}`);
      if (requested !== webDist && !requested.startsWith(`${webDist}${sep}`)) { response.writeHead(404); response.end(); return; }
      const asset = extname(requested) ? requested : resolve(webDist, "index.html");
      response.setHeader("content-type", contentTypes[extname(asset)] ?? "application/octet-stream");
      response.end(await readFile(asset));
    } catch {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("Test HTTP host could not serve this request.");
    }
  });
  const close = async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await app?.close();
    await pool.end();
  };
  try {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    const db = createDb(pool);
    const github = new FixtureGithubSource();
    const initial = github.createRepository({ id: 927001, owner: "everyinc", name: "compound-engineering-plugin", defaultBranch: "main", license: "MIT", files: {
      "LICENSE": "MIT License\n\nCopyright (c) 2026 Synthetic E2E Fixture\n\nPermission is granted to use, copy and modify this software.\n",
      "skills/ce-plan/SKILL.md": "---\nname: ce-plan\ndescription: Plan engineering work from the supplied requirements.\n---\n\nRead references/guide.md and outline the steps.\n",
      "skills/ce-plan/references/guide.md": "Record requirements before proposing a plan.\n",
      "skills/ce-code-review/SKILL.md": "---\nname: ce-code-review\ndescription: Inspect supplied code changes for correctness.\n---\n\nReport observed failures and supporting evidence.\n",
    } });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test browser host did not bind.");
    const baseURL = `http://127.0.0.1:${address.port}`;
    const skillRepository = new PostgresSkillRepository(db);
    // This production store's Postgres artifact mode persists the exact bundle.
    // The separate compose fullstack suite owns S3/MinIO deployment-wiring proof.
    const submissionService = new SubmissionService(new PostgresSubmissionStore(db));
    const libraryService = new LibraryService({ store: new PostgresLibraryStore(db), submissions: submissionService, skillRepository, sourceProvider: new PublicGithubSourceProvider({ transport: github.transport() }), slugSuffix: (seed) => createHash("sha256").update(seed).digest("hex").slice(0, 10) });
    const identity = await pool.query<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'instance_id'");
    app = buildApp({ registryInstanceId: identity.rows[0]?.value, allowedOrigins: [baseURL], skillRepository, authService: new AuthService(new PostgresAuthStore(db), {}), submissionService, teamService: new TeamService(new PostgresTeamStore(db)), libraryService });
    appURL = await app.listen({ host: "127.0.0.1", port: 0 });
    const api = async (actor: TeamLibraryActor | null, endpoint: string, body?: unknown, method = body === undefined ? "GET" : "POST", expectedStatus?: number): Promise<Json> => {
      const response = await fetch(`${baseURL}/api${endpoint}`, { method, headers: { ...(actor ? { authorization: `Bearer ${actor.token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json();
      if (expectedStatus !== undefined ? response.status !== expectedStatus : !response.ok) throw new Error(`${method} ${endpoint} returned HTTP ${response.status} (${result.error?.code ?? "unexpected response"}).`);
      return result;
    };
    async function actor(name: string, role: string): Promise<TeamLibraryActor> {
      const id = randomUUID(); const email = `${name.toLowerCase().replaceAll(" ", "-")}@team-library.example.test`; const password = `Fixture-${randomUUID()}-password`;
      await pool.query("INSERT INTO users (id,email,normalized_email,name,status,email_verified_at) VALUES ($1,$2,$2,$3,'active',now())", [id, email, name]);
      await pool.query("INSERT INTO password_credentials (user_id,password_hash) VALUES ($1,$2)", [id, await hashPassword(password)]);
      await pool.query("INSERT INTO role_assignments (user_id,role) VALUES ($1,$2)", [id, role]);
      const session = await api(null, "/v1/auth/login", { email, password });
      const enrolled = await api(session as TeamLibraryActor, "/v1/auth/mfa/totp/enroll", { password });
      const confirmed = await api(session as TeamLibraryActor, "/v1/auth/mfa/totp/confirm", { factorId: enrolled.enrollment.factorId, code: generateTotpCode(enrolled.enrollment.secret) });
      const challenge = await api(null, "/v1/auth/login", { email, password });
      const verified = await api(null, "/v1/auth/mfa/verify", { challengeToken: challenge.challengeToken, recoveryCode: confirmed.mfa.recoveryCodes[0] });
      if (!verified.user.mfaVerified || !verified.token) throw new Error("Fixture actor did not obtain an MFA verified session.");
      return verified as TeamLibraryActor;
    }
    const alice = await actor("Alice curator", "author"), bob = await actor("Bob curator", "author"), member = await actor("Member", "user"), reviewer = await actor("Independent reviewer", "maintainer");
    const { team } = await api(alice, "/v1/teams", { name: "Engineering team" });
    for (const invitee of [bob, member]) {
      const { invitation } = await api(alice, `/v1/teams/${team.id}/invitations`, { email: invitee.user.email });
      await api(invitee, `/v1/teams/invitations/${invitation.id}/accept`, {});
    }
    await api(alice, `/v1/teams/${team.id}/members/${bob.user.id}`, { role: "owner" }, "PUT");
    return {
      baseURL, teamId: team.id as string, sourceURL: `https://github.com/${repo}`, initialCommit: initial.headCommit, actors: { alice, bob, member, reviewer }, api, close,
      changeGuide: () => github.commit(repo, { files: { "skills/ce-plan/references/guide.md": "Record requirements and acceptance evidence before proposing a plan.\n" } }),
      raw: async (actor: TeamLibraryActor, endpoint: string) => {
        const response = await fetch(`${baseURL}/api${endpoint}`, { headers: { authorization: `Bearer ${actor.token}` } });
        if (!response.ok) throw new Error(`Artifact request returned HTTP ${response.status}.`);
        return Buffer.from(await response.arrayBuffer());
      },
    };
  } catch (error) { await close(); throw error; }
}
