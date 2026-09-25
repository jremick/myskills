import assert from "node:assert/strict";
import test from "node:test";
import { canQueueWorkspaceOperation } from "../src/components/target/workspace-target.js";
import { unsupportedWorkspaceTargets, workspaceTarget } from "./workspace-target-fixture.js";

for (const action of ["install", "update", "rollback"] as const) {
  test(`${action} accepts the shipped enrolled workspace contract and rejects unsupported targets`, () => {
    assert.equal(canQueueWorkspaceOperation(workspaceTarget(), "codex", action), true);
    assert.equal(canQueueWorkspaceOperation(workspaceTarget(), "generic", action), false);
    for (const [name, patch] of unsupportedWorkspaceTargets) {
      assert.equal(canQueueWorkspaceOperation({ ...workspaceTarget(), ...patch }, "codex", action), false, name);
    }
  });
}

test("queue eligibility requires the specific action capability", () => {
  const target = workspaceTarget();
  target.capabilities.rollback = false;
  assert.equal(canQueueWorkspaceOperation(target, "codex", "update"), true);
  assert.equal(canQueueWorkspaceOperation(target, "codex", "rollback"), false);
  target.capabilities.rollback = true;
  target.capabilities.apply = false;
  assert.equal(canQueueWorkspaceOperation(target, "codex", "install"), false);
  assert.equal(canQueueWorkspaceOperation(target, "codex", "rollback"), true);
});
