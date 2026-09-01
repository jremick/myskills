import assert from "node:assert/strict";
import test from "node:test";
import {
  architectureDigest,
  canonicalizeJson,
  createFlatArchitecture,
  type ArchitectureSpecV1,
} from "@myskills-app/core";
import { MemoryArchitectureStore } from "../src/architectures/memory-store.js";
import {
  ArchitecturePatternMigrationService,
  type ArchitecturePatternMigrationCreateInput,
  type ArchitecturePatternMigrationReleaseAuthorizationInput,
} from "../src/architectures/pattern-migration-service.js";
import { MemoryPatternMigrationStore } from "../src/architectures/memory-pattern-migration-store.js";
import type { ArchitectureActor, ArchitectureRecord, ArchitectureRevisionRecord } from "../src/architectures/types.js";

const ownerId = "pattern-owner";
const teamId = "pattern-team";
const teamOwnerId = "pattern-team-owner";
const teamMemberId = "pattern-team-member";
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

interface Fixture {
  architectureStore: MemoryArchitectureStore;
  migrationStore: MemoryPatternMigrationStore;
  service: ArchitecturePatternMigrationService;
  sourceArchitecture: ArchitectureRecord;
  sourceRevision: ArchitectureRevisionRecord;
  releaseCalls: ArchitecturePatternMigrationReleaseAuthorizationInput[];
}

async function fixture(options: {
  owner?: { type: "user" | "team"; id: string };
  actor?: ArchitectureActor;
  releaseDecision?: boolean | { allowed: boolean; code?: string };
  beforeCommit?: () => void;
  beforeAuditInsert?: () => void | Promise<void>;
  maxResultBytes?: number;
} = {}): Promise<Fixture> {
  const sourceOwner = options.owner ?? { type: "user" as const, id: ownerId };
  const sourceActor = options.actor ?? { id: sourceOwner.id };
  const architectureStore = new MemoryArchitectureStore({
    teamMemberships: sourceOwner.type === "team"
      ? [{ actorId: sourceActor.id, teamId: sourceOwner.id, role: "owner" }]
      : [],
  });
  const sourceArchitecture = await architectureStore.createArchitecture({
    actor: sourceActor,
    owner: sourceOwner,
    name: "Source architecture",
    description: "Source description",
    patternId: "flat",
  });
  const sourceSpec = createFlatArchitecture({
    id: sourceArchitecture.id,
    name: sourceArchitecture.name,
    skills: [
      { id: "skill-alpha", slug: "skill-alpha", title: "Alpha", version: "1.0.0", digest: digestA, packageVisibility: "public" },
      { id: "skill-beta", slug: "skill-beta", title: "Beta", version: "2.0.0", digest: digestB, packageVisibility: "public" },
    ],
  });
  const sourceRevision = await architectureStore.createRevision({
    actor: sourceActor,
    architectureId: sourceArchitecture.id,
    expectedCurrentRevisionId: null,
    message: "Initial source revision",
    spec: sourceSpec,
  });
  assert.ok(sourceRevision);

  const migrationStore = new MemoryPatternMigrationStore({
    beforeCommit: options.beforeCommit,
    beforeAuditInsert: options.beforeAuditInsert,
  });
  const releaseCalls: ArchitecturePatternMigrationReleaseAuthorizationInput[] = [];
  const generatedIds = ["derived-architecture-1", "derived-revision-1", "lineage-1", "derived-architecture-2", "derived-revision-2", "lineage-2"];
  const service = new ArchitecturePatternMigrationService(architectureStore, migrationStore, {
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    idFactory: () => generatedIds.shift() ?? "generated-id-overflow",
    maxResultBytes: options.maxResultBytes,
    releaseAuthorizer: {
      authorize: async (input) => {
        releaseCalls.push(structuredClone(input));
        return options.releaseDecision ?? true;
      },
    },
  });
  return {
    architectureStore,
    migrationStore,
    service,
    sourceArchitecture,
    sourceRevision,
    releaseCalls,
  };
}

function createInput(fixtureValue: Fixture, overrides: Partial<ArchitecturePatternMigrationCreateInput> = {}): ArchitecturePatternMigrationCreateInput {
  return {
    actor: ownerId,
    architectureId: fixtureValue.sourceArchitecture.id,
    expectedCurrentRevisionId: fixtureValue.sourceRevision.id,
    targetPatternId: "multi-level-router",
    idempotencyKey: "pattern-migration-request-1",
    name: "Derived router architecture",
    description: "Derived description",
    message: "Derived from the source architecture",
    ...overrides,
  };
}

function errorWithCode(code: string) {
  return (error: unknown): boolean => (
    error instanceof Error
    && "code" in error
    && (error as Error & { code?: unknown }).code === code
  );
}

test("preview is side-effect free for architecture persistence and allocates no IDs", async () => {
  const fixtureValue = await fixture();
  const preview = await fixtureValue.service.preview({
    actor: ownerId,
    architectureId: fixtureValue.sourceArchitecture.id,
    expectedCurrentRevisionId: fixtureValue.sourceRevision.id,
    targetPatternId: "multi-level-router",
  });

  assert.equal(preview.sourceArchitectureId, fixtureValue.sourceArchitecture.id);
  assert.equal(preview.sourceRevisionId, fixtureValue.sourceRevision.id);
  assert.equal(preview.migration.mappingStatus, "fallback");
  assert.equal(preview.migration.target?.spec.id, fixtureValue.sourceArchitecture.id);
  assert.equal(fixtureValue.migrationStore.migrationCount, 0);
  assert.equal(fixtureValue.releaseCalls.length, 0);
  assert.equal(JSON.stringify(preview).includes("derived-architecture-1"), false);
  assert.equal((await fixtureValue.architectureStore.getArchitecture(ownerId, fixtureValue.sourceArchitecture.id))?.currentRevisionId, fixtureValue.sourceRevision.id);
});

test("create assigns authoritative shell and revision identities and preserves source refs without grants", async () => {
  const fixtureValue = await fixture();
  const beforeSource = await fixtureValue.architectureStore.getRevision(ownerId, fixtureValue.sourceArchitecture.id, fixtureValue.sourceRevision.id);
  const result = await fixtureValue.service.create(createInput(fixtureValue));
  assert.equal(result.created, true);
  assert.equal(result.replayed, false);
  assert.ok(result.persisted);
  const persisted = result.persisted;

  assert.equal(persisted.targetArchitecture.id, "derived-architecture-1");
  assert.equal(persisted.targetRevision.id, "derived-revision-1");
  assert.equal(persisted.targetRevision.architectureId, persisted.targetArchitecture.id);
  assert.equal(persisted.targetArchitecture.currentRevisionId, persisted.targetRevision.id);
  assert.equal(persisted.targetArchitecture.patternId, "multi-level-router");
  assert.equal(persisted.targetRevision.spec.id, persisted.targetArchitecture.id);
  assert.equal(persisted.targetRevision.spec.name, "Derived router architecture");
  assert.equal(persisted.targetRevision.spec.description, "Derived description");
  assert.equal(persisted.lineage.sourceArchitectureId, fixtureValue.sourceArchitecture.id);
  assert.equal(persisted.lineage.sourceRevisionId, fixtureValue.sourceRevision.id);
  assert.equal(persisted.lineage.targetArchitectureId, persisted.targetArchitecture.id);
  assert.equal(persisted.lineage.targetRevisionId, persisted.targetRevision.id);
  assert.equal(persisted.lineage.targetRevisionDigest, architectureDigest(persisted.targetRevision.spec));
  assert.equal(persisted.targetArchitecture.access.allowedOrganizationIds.length, 0);
  assert.deepEqual(persisted.targetRevision.spec.skills, beforeSource?.spec.skills);
  assert.equal((await fixtureValue.architectureStore.getRevision(ownerId, fixtureValue.sourceArchitecture.id, fixtureValue.sourceRevision.id))?.spec.id, beforeSource?.spec.id);
  assert.equal(fixtureValue.migrationStore.migrationCount, 1);
});

test("the explicit aggregate adapter makes a committed shell visible through canonical architecture reads", async () => {
  const fixtureValue = await fixture();
  const result = await fixtureValue.service.create(createInput(fixtureValue));
  assert.ok(result.persisted);
  const aggregate = fixtureValue.migrationStore.asArchitectureStore(fixtureValue.architectureStore);

  const target = await aggregate.getArchitecture(ownerId, result.persisted.targetArchitecture.id);
  const revision = await aggregate.getRevision(ownerId, result.persisted.targetArchitecture.id, result.persisted.targetRevision.id);
  const listed = await aggregate.listArchitectures(ownerId);
  assert.equal(target?.id, result.persisted.targetArchitecture.id);
  assert.equal(revision?.id, result.persisted.targetRevision.id);
  assert.equal(listed.some((architecture) => architecture.id === result.persisted?.targetArchitecture.id), true);
  assert.equal(await aggregate.getArchitecture("other-user", result.persisted.targetArchitecture.id), null);
  assert.equal(aggregate.patternMigrationStore, fixtureValue.migrationStore);
});

test("team members cannot preview or create while team owners can create", async () => {
  const teamOwner: ArchitectureActor = { id: teamOwnerId, teamMemberships: [{ teamId, role: "owner" }] };
  const teamMember: ArchitectureActor = { id: teamMemberId, teamMemberships: [{ teamId, role: "member" }] };
  const fixtureValue = await fixture({ owner: { type: "team", id: teamId }, actor: teamOwner });

  await assert.rejects(
    fixtureValue.service.preview({
      actor: teamMember,
      architectureId: fixtureValue.sourceArchitecture.id,
      expectedCurrentRevisionId: fixtureValue.sourceRevision.id,
      targetPatternId: "domain-router",
    }),
    errorWithCode("ARCHITECTURE_PATTERN_MIGRATION_FORBIDDEN"),
  );
  const result = await fixtureValue.service.create(createInput(fixtureValue, {
    actor: teamOwner,
    targetPatternId: "domain-router",
    idempotencyKey: "team-owner-request",
    name: "Team domain architecture",
  }));
  assert.equal(result.created, true);
  assert.equal(result.persisted?.targetArchitecture.owner.type, "team");
  const aggregate = fixtureValue.migrationStore.asArchitectureStore(fixtureValue.architectureStore);
  const memberView = await aggregate.getArchitecture(teamMember, result.persisted?.targetArchitecture.id ?? "");
  assert.equal(memberView?.access.role, "member");
  assert.equal(memberView?.access.canPreview, true);
  assert.equal(memberView?.access.canAppend, false);
});

test("stale expected revision is rejected before derivation or release authorization", async () => {
  const fixtureValue = await fixture();
  await fixtureValue.architectureStore.createRevision({
    actor: ownerId,
    architectureId: fixtureValue.sourceArchitecture.id,
    expectedCurrentRevisionId: fixtureValue.sourceRevision.id,
    message: "Concurrent source update",
    spec: fixtureValue.sourceRevision.spec,
  });

  await assert.rejects(
    fixtureValue.service.create(createInput(fixtureValue)),
    errorWithCode("ARCHITECTURE_PATTERN_MIGRATION_REVISION_CONFLICT"),
  );
  assert.equal(fixtureValue.releaseCalls.length, 0);
  assert.equal(fixtureValue.migrationStore.migrationCount, 0);
});

test("memory commit revalidates the source after async release authorization", async () => {
  const fixtureValue = await fixture();
  const service = new ArchitecturePatternMigrationService(fixtureValue.architectureStore, fixtureValue.migrationStore, {
    releaseAuthorizer: {
      authorize: async () => {
        await fixtureValue.architectureStore.createRevision({
          actor: ownerId,
          architectureId: fixtureValue.sourceArchitecture.id,
          expectedCurrentRevisionId: fixtureValue.sourceRevision.id,
          message: "Concurrent source update",
          spec: fixtureValue.sourceRevision.spec,
        });
        return true;
      },
    },
  });

  await assert.rejects(
    service.create(createInput(fixtureValue)),
    errorWithCode("ARCHITECTURE_PATTERN_MIGRATION_REVISION_CONFLICT"),
  );
  assert.equal(fixtureValue.migrationStore.migrationCount, 0);
});

test("same idempotency intent replays the authoritative result and conflicting reuse is rejected", async () => {
  const fixtureValue = await fixture();
  const input = createInput(fixtureValue);
  const first = await fixtureValue.service.create(input);
  const replay = await fixtureValue.service.create(input);
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.persisted?.targetArchitecture.id, first.persisted?.targetArchitecture.id);
  assert.equal(replay.persisted?.targetRevision.id, first.persisted?.targetRevision.id);
  assert.equal(fixtureValue.migrationStore.migrationCount, 1);
  assert.equal(fixtureValue.releaseCalls.length, 1);

  await assert.rejects(
    fixtureValue.service.create({ ...input, name: "Conflicting name" }),
    errorWithCode("ARCHITECTURE_PATTERN_MIGRATION_IDEMPOTENCY_CONFLICT"),
  );
  assert.equal(fixtureValue.migrationStore.migrationCount, 1);
});

test("an idempotent replay remains valid after the source advances", async () => {
  const fixtureValue = await fixture();
  const input = createInput(fixtureValue);
  const first = await fixtureValue.service.create(input);
  assert.ok(first.persisted);
  await fixtureValue.architectureStore.createRevision({
    actor: ownerId,
    architectureId: fixtureValue.sourceArchitecture.id,
    expectedCurrentRevisionId: fixtureValue.sourceRevision.id,
    message: "Source advanced after migration",
    spec: fixtureValue.sourceRevision.spec,
  });

  const replay = await fixtureValue.service.create(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.created, false);
  assert.equal(replay.persisted?.targetArchitecture.id, first.persisted.targetArchitecture.id);
  assert.equal(fixtureValue.releaseCalls.length, 1);
  assert.equal(fixtureValue.migrationStore.migrationCount, 1);
});

test("concurrent requests with one idempotency key commit one shell and replay one result", async () => {
  const fixtureValue = await fixture();
  const [left, right] = await Promise.all([
    fixtureValue.service.create(createInput(fixtureValue)),
    fixtureValue.service.create(createInput(fixtureValue)),
  ]);
  assert.equal(fixtureValue.migrationStore.migrationCount, 1);
  assert.deepEqual(
    [left.persisted?.targetArchitecture.id, right.persisted?.targetArchitecture.id].sort(),
    ["derived-architecture-1", "derived-architecture-1"],
  );
  assert.equal([left.created, right.created].filter(Boolean).length, 1);
  assert.equal([left.replayed, right.replayed].filter(Boolean).length, 1);
});

test("blocked core mapping is returned without release authorization or persistence", async () => {
  const fixtureValue = await fixture();
  const result = await fixtureValue.service.create(createInput(fixtureValue, {
    mapping: {
      routerGroups: [{ id: "router-alpha", label: "Alpha", leafNodeIds: ["leaf-skill-alpha"] }],
      allowUnassignedLeafFallback: false,
    },
  }));
  assert.equal(result.created, false);
  assert.equal(result.replayed, false);
  assert.equal(result.migration.mappingStatus, "blocked");
  assert.equal(result.migration.target, null);
  assert.equal(fixtureValue.releaseCalls.length, 0);
  assert.equal(fixtureValue.migrationStore.migrationCount, 0);
});

test("release authorization receives server-derived target and exact source context, then can fail closed", async () => {
  const fixtureValue = await fixture({ releaseDecision: { allowed: false, code: "RELEASE_POLICY_DENIED" } });
  const input = createInput(fixtureValue);
  await assert.rejects(
    fixtureValue.service.create(input),
    errorWithCode("ARCHITECTURE_PATTERN_MIGRATION_RELEASE_DENIED"),
  );
  assert.equal(fixtureValue.migrationStore.migrationCount, 0);
  assert.equal(fixtureValue.releaseCalls.length, 1);
  const authorization = fixtureValue.releaseCalls[0];
  assert.equal(authorization.actorId, ownerId);
  assert.deepEqual(authorization.owner, { type: "user", id: ownerId });
  assert.equal(authorization.sourceArchitectureId, fixtureValue.sourceArchitecture.id);
  assert.equal(authorization.sourceRevisionId, fixtureValue.sourceRevision.id);
  assert.equal(authorization.sourceRevisionDigest, architectureDigest(fixtureValue.sourceRevision.spec));
  assert.equal(authorization.targetPatternId, "multi-level-router");
  assert.equal(authorization.targetSpec.id, "derived-architecture-1");
  assert.equal(authorization.targetSpec.name, "Derived router architecture");
  assert.equal(authorization.targetSpec.description, "Derived description");
  assert.equal("spec" in (input as Record<string, unknown>), false);
});

test("atomic repository failure leaves no shell, revision, or lineage and a later retry can commit", async () => {
  const fixtureValue = await fixture({ beforeCommit: () => { throw new Error("simulated commit failure"); } });
  const input = createInput(fixtureValue);
  await assert.rejects(fixtureValue.service.create(input), /simulated commit failure/);
  assert.equal(fixtureValue.migrationStore.migrationCount, 0);
  assert.deepEqual(await fixtureValue.migrationStore.listMigrations(), []);

  fixtureValue.migrationStore.setBeforeCommitFailure(undefined);
  const retry = await fixtureValue.service.create(input);
  assert.equal(retry.created, true);
  assert.equal(fixtureValue.migrationStore.migrationCount, 1);
});

test("required allow audit failure leaves no derived shell and an identical retry commits once", async () => {
  let failNextAudit = true;
  const fixtureValue = await fixture({
    beforeAuditInsert: () => {
      if (failNextAudit) {
        failNextAudit = false;
        throw new Error("simulated pattern migration audit failure");
      }
    },
  });
  const input = createInput(fixtureValue);

  await assert.rejects(fixtureValue.service.create(input), /simulated pattern migration audit failure/);
  assert.equal(fixtureValue.migrationStore.migrationCount, 0);
  assert.equal(
    (await fixtureValue.migrationStore.listAuditEvents()).filter((event) => event.action === "architecture.pattern-migration.create" && event.decision === "allow").length,
    0,
  );

  const retry = await fixtureValue.service.create(input);
  assert.equal(retry.created, true);
  assert.equal(fixtureValue.migrationStore.migrationCount, 1);
  assert.equal(
    (await fixtureValue.migrationStore.listAuditEvents()).filter((event) => event.action === "architecture.pattern-migration.create" && event.decision === "allow").length,
    1,
  );

});

test("final migration result bounds are enforced before the derived shell commit", async () => {
  const fixtureValue = await fixture();
  const preview = await fixtureValue.service.preview({
    actor: ownerId,
    architectureId: fixtureValue.sourceArchitecture.id,
    expectedCurrentRevisionId: fixtureValue.sourceRevision.id,
    targetPatternId: "multi-level-router",
  });
  const previewBytes = Buffer.byteLength(canonicalizeJson(preview.migration), "utf8");
  const boundedService = new ArchitecturePatternMigrationService(fixtureValue.architectureStore, fixtureValue.migrationStore, {
    maxResultBytes: previewBytes + 100,
    releaseAuthorizer: { authorize: async () => true },
  });

  await assert.rejects(
    boundedService.create(createInput(fixtureValue, { description: "x".repeat(500) })),
    errorWithCode("ARCHITECTURE_PATTERN_MIGRATION_RESULT_TOO_LARGE"),
  );
  assert.equal(fixtureValue.migrationStore.migrationCount, 0);
});

test("derived shells remain revision-writable through the memory architecture aggregate", async () => {
  const fixtureValue = await fixture();
  const created = await fixtureValue.service.create(createInput(fixtureValue));
  assert.ok(created.persisted);
  const aggregate = fixtureValue.migrationStore.asArchitectureStore(fixtureValue.architectureStore);
  const next = await aggregate.createRevision({
    actor: ownerId,
    architectureId: created.persisted.targetArchitecture.id,
    expectedCurrentRevisionId: created.persisted.targetRevision.id,
    message: "Append to derived shell",
    spec: structuredClone(created.persisted.targetRevision.spec),
  });
  assert.ok(next);
  assert.equal(next.revisionNumber, 2);
  assert.equal((await aggregate.getArchitecture(ownerId, created.persisted.targetArchitecture.id))?.currentRevisionId, next.id);
  assert.equal((await aggregate.listRevisions(ownerId, created.persisted.targetArchitecture.id))?.length, 2);
  assert.equal((await aggregate.getRevision(ownerId, created.persisted.targetArchitecture.id, created.persisted.targetRevision.id))?.id, created.persisted.targetRevision.id);
  assert.equal((await aggregate.getRevision(ownerId, created.persisted.targetArchitecture.id, next.id))?.id, next.id);
});

test("audit records retain only bounded IDs, patterns, digests, counts, and codes", async () => {
  const fixtureValue = await fixture();
  await fixtureValue.migrationStore.recordAuditEvent({
    actorUserId: ownerId,
    action: "architecture.pattern-migration.test",
    decision: "allow",
    resourceId: fixtureValue.sourceArchitecture.id,
    details: {
      sourceArchitectureId: fixtureValue.sourceArchitecture.id,
      code: "test.safe",
      prompt: "secret prompt",
      path: "/private/path",
      name: "private name",
      description: "private description",
    },
  });
  const event = (await fixtureValue.migrationStore.listAuditEvents(1))[0];
  assert.deepEqual(event.details, {
    sourceArchitectureId: fixtureValue.sourceArchitecture.id,
    code: "test.safe",
  });
  const eventJson = JSON.stringify(event);
  assert.equal(eventJson.includes("secret prompt"), false);
  assert.equal(eventJson.includes("/private/path"), false);
  assert.equal(eventJson.includes("private description"), false);
});

test("unknown full-spec authority is rejected at the service boundary", async () => {
  const fixtureValue = await fixture();
  await assert.rejects(
    fixtureValue.service.create({ ...createInput(fixtureValue), spec: {} } as never),
    errorWithCode("ARCHITECTURE_PATTERN_MIGRATION_INPUT_UNKNOWN_FIELD"),
  );
});

test("a non-owner cannot discover the source or derived shell", async () => {
  const fixtureValue = await fixture();
  await assert.rejects(
    fixtureValue.service.preview({
      actor: "not-the-owner",
      architectureId: fixtureValue.sourceArchitecture.id,
      expectedCurrentRevisionId: fixtureValue.sourceRevision.id,
      targetPatternId: "domain-router",
    }),
    errorWithCode("ARCHITECTURE_NOT_FOUND"),
  );
  const created = await fixtureValue.service.create(createInput(fixtureValue));
  assert.ok(created.persisted);
  const aggregate = fixtureValue.migrationStore.asArchitectureStore(fixtureValue.architectureStore);
  assert.equal(await aggregate.getArchitecture("not-the-owner", created.persisted.targetArchitecture.id), null);
});

test("source pattern identity remains immutable across a migration request", async () => {
  const fixtureValue = await fixture();
  const malformed = structuredClone(fixtureValue.sourceRevision.spec) as ArchitectureSpecV1;
  malformed.pattern = { id: "domain-router", version: 1 };
  const invalidStore = new MemoryArchitectureStore();
  const architecture = await invalidStore.createArchitecture({
    actor: ownerId,
    owner: { type: "user", id: ownerId },
    name: "Invalid source",
    description: "",
    patternId: "flat",
  });
  await assert.rejects(
    invalidStore.createRevision({ actor: ownerId, architectureId: architecture.id, expectedCurrentRevisionId: null, message: "invalid", spec: malformed }),
    /Domain-router patterns contain one router/,
  );
});
