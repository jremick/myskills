import assert from "node:assert/strict";
import test from "node:test";
import { CompanionLease } from "../src/companion-lease.js";

test("companion refuses missing, expired, and invalid lease claims", () => {
  for (const expiry of [undefined, "invalid", new Date(Date.now() - 1000).toISOString()]) {
    assert.throws(() => new CompanionLease(expiry, async () => ""), /expired/);
  }
});

test("failed renewal is sticky and prevents every later promotion checkpoint", async () => {
  let calls = 0;
  const lease = new CompanionLease(new Date(Date.now() + 10_000).toISOString(), async () => {
    calls += 1;
    throw new Error("consent revoked");
  });
  await assert.rejects(lease.checkpoint(), /consent revoked/);
  await assert.rejects(lease.checkpoint("verifying"), /consent revoked/);
  assert.equal(calls, 1);
  await lease.stop();
});

test("renewal checkpoints serialize and stop after verification receipt", async () => {
  let concurrent = 0;
  const states: string[] = [];
  const lease = new CompanionLease(new Date(Date.now() + 10_000).toISOString(), async (state) => {
    concurrent += 1;
    assert.equal(concurrent, 1);
    states.push(state);
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent -= 1;
    return new Date(Date.now() + 10_000).toISOString();
  });
  await Promise.all([lease.checkpoint("applying"), lease.checkpoint("verifying")]);
  assert.deepEqual(states, ["applying", "verifying"]);
  await lease.stop();
  await assert.rejects(lease.checkpoint(), /expired/);
});

test("background renewal runs while package work is waiting", async () => {
  let calls = 0;
  let renewed!: () => void;
  const renewal = new Promise<void>((resolve) => { renewed = resolve; });
  const lease = new CompanionLease(new Date(Date.now() + 3000).toISOString(), async () => {
    calls += 1;
    if (calls === 2) renewed();
    return new Date(Date.now() + 150).toISOString();
  });
  await lease.checkpoint();
  const timeout = setTimeout(() => assert.fail("background renewal did not run"), 2000);
  try { await renewal; assert.equal(calls, 2); }
  finally { clearTimeout(timeout); await lease.stop(); }
});
