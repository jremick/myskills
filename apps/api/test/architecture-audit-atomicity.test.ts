import assert from "node:assert/strict";
import test from "node:test";
import { createFlatArchitecture } from "@myskills-app/core";
import { MemoryArchitectureStore } from "../src/architectures/memory-store.js";

const ownerId = "architecture-audit-owner";

function createAudit(action: "architecture.create" | "architecture.revision.create") {
  return {
    actorUserId: ownerId,
    action,
    resourceType: "skill_architecture",
    details: { source: "atomicity-test" },
  } as const;
}

test("memory architecture creation rolls back the shell when its allow audit fails", async () => {
  let failures = 1;
  const store = new MemoryArchitectureStore({
    beforeCommit: (audit) => {
      assert.equal(audit.action, "architecture.create");
      if (failures > 0) {
        failures -= 1;
        throw new Error("injected architecture allow-audit failure");
      }
    },
  });
  const input = {
    ownerUserId: ownerId,
    name: "Atomic architecture",
    description: "",
    patternId: "flat" as const,
  };

  await assert.rejects(
    store.createArchitecture(ownerId, input, createAudit("architecture.create")),
    /injected architecture allow-audit failure/,
  );
  assert.deepEqual(await store.listArchitectures(ownerId), []);
  assert.deepEqual(await store.listAuditEvents(), []);

  const architecture = await store.createArchitecture(ownerId, input, createAudit("architecture.create"));
  assert.equal((await store.listArchitectures(ownerId)).length, 1);
  const audits = await store.listAuditEvents();
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.action, "architecture.create");
  assert.equal(audits[0]?.resourceId, architecture.id);
});

test("memory revision creation rolls back the revision and pointer when its allow audit fails", async () => {
  let failures = 1;
  const store = new MemoryArchitectureStore({
    beforeCommit: (audit) => {
      assert.equal(audit.action, "architecture.revision.create");
      if (failures > 0) {
        failures -= 1;
        throw new Error("injected revision allow-audit failure");
      }
    },
  });
  const architecture = await store.createArchitecture({
    ownerUserId: ownerId,
    name: "Atomic revision architecture",
    description: "",
    patternId: "flat",
  });
  const spec = createFlatArchitecture({
    id: architecture.id,
    name: architecture.name,
    skills: [{ id: "skill-one", slug: "skill-one", packageVisibility: "public" }],
  });
  const input = {
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "Initial revision",
    spec,
  } as const;

  await assert.rejects(
    store.createRevision(ownerId, input, createAudit("architecture.revision.create")),
    /injected revision allow-audit failure/,
  );
  const afterFailure = await store.getArchitecture(ownerId, architecture.id);
  assert.equal(afterFailure?.currentRevisionId, null);
  assert.equal(afterFailure?.revisionCount, 0);
  assert.deepEqual(await store.listRevisions(ownerId, architecture.id), []);
  assert.deepEqual(await store.listAuditEvents(), []);

  const revision = await store.createRevision(ownerId, input, createAudit("architecture.revision.create"));
  assert.equal(revision?.revisionNumber, 1);
  const afterRetry = await store.getArchitecture(ownerId, architecture.id);
  assert.equal(afterRetry?.currentRevisionId, revision?.id);
  assert.equal(afterRetry?.revisionCount, 1);
  const audits = await store.listAuditEvents();
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.action, "architecture.revision.create");
  assert.equal(audits[0]?.resourceId, architecture.id);
  assert.equal(audits[0]?.details.revisionId, revision?.id);
  assert.equal(audits[0]?.details.revisionNumber, 1);
});
