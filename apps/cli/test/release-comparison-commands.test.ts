import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { runCli, type CliRuntime } from "../src/cli.js";

test("CLI comparison uses existing exact authorized release reads and never returns partial output on revocation", async () => {
  const payloads = new Map(["1.0.0", "2.0.0"].map(version => [version, { files: [{ path: "skill.json", content: JSON.stringify({ name: "compare", version }) }, { path: "SKILL.md", content: `# ${version}` }] }]));
  const sha = (version: string) => createHash("sha256").update(JSON.stringify(payloads.get(version))).digest("hex");
  const output: string[] = [], errors: string[] = [], calls: string[] = [];
  let revoke = false;
  const runtime: CliRuntime = { env: {}, io: { stdout: value => output.push(value), stderr: value => errors.push(value) }, fetch: async input => {
    const url = new URL(String(input)); calls.push(url.pathname + url.search);
    if (revoke && calls.length === 5) return new Response(JSON.stringify({ error: { code: "AUTHENTICATION_REQUIRED", message: "Revoked" } }), { status: 401 });
    const version = url.pathname.includes("1.0.0") ? "1.0.0" : "2.0.0";
    const payload = payloads.get(version)!;
    return new Response(JSON.stringify(url.pathname.endsWith("/bundle") ? payload : { release: { slug: "compare", version, reviewStatus: "approved", lifecycleStatus: "approved", publishedAt: "2026-10-01T00:00:00Z", artifact: { sha256: sha(version), byteSize: Buffer.byteLength(JSON.stringify(payload)) } } }), { status: 200, headers: { "content-type": "application/json", "x-myskills-artifact-sha256": sha(version) } });
  } };
  const args = ["skills", "compare", "compare", "1.0.0", "2.0.0", "--base-sha256", sha("1.0.0"), "--target-sha256", sha("2.0.0"), "--api-url", "http://fixture.invalid", "--token", "fixture-token", "--json"];
  assert.equal(await runCli(args, runtime), 0, errors.join(""));
  const result = JSON.parse(output[0]!); assert.equal(result.totals.modified, 2); assert.equal(calls.length, 6);
  assert.ok(calls[2]!.endsWith(`?sha256=${sha("1.0.0")}`)); assert.ok(calls[3]!.endsWith(`?sha256=${sha("2.0.0")}`));
  calls.length = 0; output.length = 0; revoke = true;
  assert.equal(await runCli(args, runtime), 1); assert.equal(output.length, 0); assert.match(errors.at(-1)!, /AUTHENTICATION_REQUIRED/);
});

test("CLI pre-approval comparison uses review authority only for the candidate and fails closed on final denial", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const payload = (version: string) => ({ files: [{ path: "skill.json", content: JSON.stringify({ name: "compare", version }) }, { path: "SKILL.md", content: version }] });
  const sha = (version: string) => createHash("sha256").update(JSON.stringify(payload(version))).digest("hex");
  const calls: string[] = [], output: string[] = [], errors: string[] = []; let denied = false;
  const runtime: CliRuntime = { env: {}, io: { stdout: value => output.push(value), stderr: value => errors.push(value) }, fetch: async input => {
    const url = new URL(String(input)); calls.push(url.pathname);
    if (denied && calls.length === 7) return new Response(JSON.stringify({ error: { code: "REVIEW_ROLE_REQUIRED" } }), { status: 403 });
    const review = url.pathname.includes("/review/"); const version = review ? "2.0.0" : "1.0.0";
    const body = url.pathname.endsWith("/bundle") ? payload(version) : review ? { submission: { id, slug: "compare", version } } : { release: { slug: "compare", version, reviewStatus: "approved", lifecycleStatus: "approved", publishedAt: "2026-10-01", artifact: { sha256: sha(version), byteSize: Buffer.byteLength(JSON.stringify(payload(version))) } } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "x-myskills-artifact-sha256": sha(version) } });
  } };
  const args = ["review", "compare", id, "compare", "1.0.0", "2.0.0", "--base-sha256", sha("1.0.0"), "--target-sha256", sha("2.0.0"), "--api-url", "http://fixture.invalid", "--token", "fixture", "--json"];
  assert.equal(await runCli(args, runtime), 0, errors.join("")); assert.equal(JSON.parse(output[0]!).context, "review-candidate"); assert.equal(calls.length, 7);
  assert.equal(calls.filter(url => url.startsWith("/v1/skills/")).length, 3);
  calls.length = 0; output.length = 0; denied = true;
  assert.equal(await runCli(args, runtime), 1); assert.equal(output.length, 0); assert.match(errors.at(-1)!, /REVIEW_ROLE_REQUIRED/);
});
