import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { createArchitecturePlanFixture } from "../../api/test/fixtures/architecture-plan-fixture.js";

// Test first: public CLI dispatch must preserve revision, observation, generation,
// idempotency and full review digest. Bad options must fail before HTTP. The real
// API services and memory authorities decide domain policy and persistence.
test("CLI retains exact architecture plan history, replay and explicit review fences", async (t) => {
  const fixture = await createArchitecturePlanFixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-plan-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const apiUrl = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
  let inputIndex = 0; let requests = 0;
  async function command(args: string[], body?: Record<string, unknown>, token = fixture.sessions.owner) {
    const input = path.join(root, `request-${++inputIndex}.json`);
    if (body) await writeFile(input, JSON.stringify(body));
    const stdout: string[] = []; const stderr: string[] = [];
    const code = await runCli([...args, ...(body ? ["--input", input] : []), "--api-url", apiUrl, "--json"], {
      env: { MYSKILLS_TOKEN: token },
      fetch: (url, init) => { requests += 1; return fetch(url, init); },
      io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    });
    return { code, data: stdout.length ? JSON.parse(stdout.join("\n")) : {}, error: stderr.join("\n") };
  }
  const createArgs = ["architecture-plans", "create", fixture.target.id];
  const created = await command(createArgs, fixture.request);
  assert.equal(created.code, 0, created.error);
  const run = created.data.run;
  assert.equal(run.identity.revisionId, fixture.revision.id);
  assert.equal(run.metadata.reviewOnly, true);
  assert.equal(run.metadata.canApply, false);
  assert.equal((await command(createArgs, fixture.request)).data.run.identity.runId, run.identity.runId);
  assert.equal((await command(["architecture-plans", "list", fixture.target.id, "--limit", "1"])).data.runs[0].identity.runId, run.identity.runId);
  assert.equal((await command(["architecture-plans", "show", run.identity.runId])).data.run.metadata.reviewDigest, run.metadata.reviewDigest);
  const before = requests;
  for (const args of [["architecture-plans", "create", "../escape"], ["architecture-plans", "list", fixture.target.id, "--apply"], ["architecture-plans", "list", fixture.target.id, "--limit", "501"]]) assert.notEqual((await command(args)).code, 0);
  assert.equal(requests, before);
  const approveArgs = ["architecture-plans", "approve", run.identity.runId];
  assert.notEqual((await command(approveArgs, { expectedReviewDigest: run.digests.planDigest })).code, 0);
  const approval = { expectedReviewDigest: run.metadata.reviewDigest };
  assert.match((await command(approveArgs, approval, fixture.sessions.plain)).error, /MFA/);
  assert.notEqual((await command(["architecture-plans", "show", run.identity.runId], undefined, fixture.sessions.outsider)).code, 0);
  const approved = await command(approveArgs, approval);
  assert.equal(approved.code, 0, approved.error);
  assert.equal(approved.data.run.state, "approved");
  assert.equal(approved.data.run.receipts.filter((receipt: { kind: string }) => receipt.kind === "approval").length, 1);
  t.diagnostic(JSON.stringify({ journey: "architecture-plan-cli", exactRevision: true, replayPreserved: true, invalidInputNoHttp: true, reviewApprovalOnly: true }));
});
