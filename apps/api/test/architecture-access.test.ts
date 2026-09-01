import assert from "node:assert/strict";
import test from "node:test";
import { createFlatArchitecture } from "@myskills-app/core";
import { MemoryArchitectureStore } from "../src/architectures/memory-store.js";
import {
  architectureAccessPolicyVersion,
  evaluateArchitectureAccess,
  type ArchitectureActor,
} from "../src/architectures/types.js";

const teamId = "team-delivery";
const teamOwner: ArchitectureActor = {
  id: "team-owner",
  teamMemberships: [{ teamId, role: "owner" }],
};
const teamMember: ArchitectureActor = {
  id: "team-member",
  teamMemberships: [{ teamId, role: "member" }],
};
const outsider: ArchitectureActor = { id: "outsider" };

test("architecture access delegates to the core policy vocabulary", () => {
  assert.deepEqual(evaluateArchitectureAccess({
    actor: { userId: teamMember.id, teamMemberships: [{ teamId, role: "member" }] },
    owner: { type: "team", id: teamId },
    action: "append-revision",
  }), {
    owner: { type: "team", id: teamId },
    accessPolicyVersion: architectureAccessPolicyVersion,
    action: "append-revision",
    allowed: false,
    reason: "team-member",
  });
});

test("team members can read and preview while only team owners can append", async () => {
  const store = new MemoryArchitectureStore();
  const architecture = await store.createArchitecture({
    actor: teamOwner,
    owner: { type: "team", id: teamId },
    name: "Team delivery architecture",
    description: "",
    patternId: "flat",
  });

  assert.equal(architecture.ownerUserId, null);
  assert.equal(architecture.ownerTeamId, teamId);
  assert.deepEqual(architecture.owner, { type: "team", id: teamId });
  assert.equal(architecture.accessPolicyVersion, 1);
  assert.equal(architecture.access.role, "owner");
  assert.equal(architecture.access.canManage, true);

  assert.deepEqual((await store.listArchitectures(teamMember)).map((item) => item.id), [architecture.id]);
  assert.equal((await store.getArchitecture(teamMember, architecture.id))?.access.role, "member");
  assert.equal((await store.getArchitecture(outsider, architecture.id)), null);
  assert.deepEqual(await store.listArchitectures(outsider), []);

  const spec = createFlatArchitecture({
    id: architecture.id,
    name: architecture.name,
    skills: [{ id: "skill-one", slug: "skill-one", version: "1.0.0", digest: "a".repeat(64) }],
  });
  assert.equal(await store.createRevision({ actor: teamMember, architectureId: architecture.id, expectedCurrentRevisionId: null, message: "denied", spec }), null);
  const revision = await store.createRevision({ actor: teamOwner, architectureId: architecture.id, expectedCurrentRevisionId: null, message: "initial", spec });
  assert.equal(revision?.createdByUserId, teamOwner.id);
  assert.equal((await store.getRevision(teamMember, architecture.id, revision?.id))?.access?.role, "member");
});

test("legacy user-owner calls remain isolated and quota counts owners separately", async () => {
  const store = new MemoryArchitectureStore();
  const userArchitecture = await store.createArchitecture({
    ownerUserId: "user-owner",
    name: "User architecture",
    description: "",
    patternId: "flat",
  });
  assert.equal((await store.getArchitecture("user-owner", userArchitecture.id))?.access.role, "owner");
  assert.equal(await store.getArchitecture("other-user", userArchitecture.id), null);

  for (let index = 0; index < 25; index += 1) {
    await store.createArchitecture({
      actor: teamOwner,
      owner: { type: "team", id: teamId },
      name: `Team architecture ${index}`,
      description: "",
      patternId: "flat",
    });
  }
  await assert.rejects(
    store.createArchitecture({
      actor: teamOwner,
      owner: { type: "team", id: teamId },
      name: "Team quota overflow",
      description: "",
      patternId: "flat",
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_QUOTA_EXCEEDED",
  );
  assert.equal((await store.listArchitectures("user-owner")).length, 1);
  assert.equal((await store.listArchitectures({ ...teamOwner, id: "user-owner" })).length, 26);
});
