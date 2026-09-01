import test from "node:test";
import assert from "node:assert/strict";
import { createRegistryClient, type ArchitectureOrganizationGrantsResult, type ArchitecturePatternMigrationCreateResult, type ArchitecturePatternMigrationPreviewResult } from "../src/api.js";

test("registry client uses exact organization grant routes and complete-set payloads", async () => {
  const calls: Array<{ body?: string; method?: string; url: string }> = [];
  const grants: ArchitectureOrganizationGrantsResult = {
    architectureId: "architecture-1",
    currentRevisionId: "revision-2",
    grants: [],
    organizationIds: ["org-1"],
    addedOrganizationIds: ["org-1"],
    removedOrganizationIds: [],
    changed: true,
  };
  const client = createRegistryClient("http://api.test", async (input, init) => {
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
      url: String(input),
    });
    return jsonResponse(200, grants);
  }, "session-token");

  const listed = await client.listArchitectureOrganizationGrants!("architecture-1");
  const replaced = await client.replaceArchitectureOrganizationGrants!("architecture-1", {
    expectedCurrentRevisionId: "revision-2",
    organizationIds: ["org-1", "org-2"],
  });

  assert.deepEqual(listed, grants);
  assert.deepEqual(replaced, grants);
  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${new URL(call.url).pathname}`), [
    "GET /v1/architectures/architecture-1/organization-grants",
    "PUT /v1/architectures/architecture-1/organization-grants",
  ]);
  assert.equal(calls[1]?.body, JSON.stringify({ expectedCurrentRevisionId: "revision-2", organizationIds: ["org-1", "org-2"] }));
  assert.equal(calls.every((call) => call.url.includes("organization-grants")), true);
});

test("registry client sends pattern migration intent without a target spec or organization context", async () => {
  const calls: Array<{ body?: string; method?: string; url: string }> = [];
  const preview: ArchitecturePatternMigrationPreviewResult = {
    sourceArchitectureId: "architecture-1",
    sourceRevisionId: "revision-2",
    expectedCurrentRevisionId: "revision-2",
    migration: blockedOrReadyMigration(),
  };
  const created: ArchitecturePatternMigrationCreateResult = {
    ...preview,
    created: true,
    replayed: false,
  };
  const client = createRegistryClient("http://api.test", async (input, init) => {
    const url = String(input);
    calls.push({ body: typeof init?.body === "string" ? init.body : undefined, method: init?.method, url });
    return jsonResponse(200, url.endsWith("/preview") ? preview : created);
  }, "session-token");

  const mapping = { rootLabel: "Shared router" };
  const nextPreview = await client.previewArchitecturePatternMigration!("architecture-1", {
    expectedCurrentRevisionId: "revision-2",
    targetPatternId: "multi-level-router",
    mapping,
  });
  const nextCreated = await client.createArchitecturePatternMigration!("architecture-1", {
    expectedCurrentRevisionId: "revision-2",
    targetPatternId: "multi-level-router",
    mapping,
    idempotencyKey: "migration-key-1",
    name: "Shared architecture",
    description: "Derived shell",
    message: "Move to nested routing",
  });

  assert.equal(nextPreview.migration.mappingStatus, "provided");
  assert.equal(nextCreated.created, true);
  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${new URL(call.url).pathname}`), [
    "POST /v1/architectures/architecture-1/pattern-migrations/preview",
    "POST /v1/architectures/architecture-1/pattern-migrations",
  ]);
  assert.equal(calls[0]?.body, JSON.stringify({ expectedCurrentRevisionId: "revision-2", targetPatternId: "multi-level-router", mapping }));
  assert.equal(calls[1]?.body, JSON.stringify({
    expectedCurrentRevisionId: "revision-2",
    targetPatternId: "multi-level-router",
    idempotencyKey: "migration-key-1",
    name: "Shared architecture",
    description: "Derived shell",
    message: "Move to nested routing",
    mapping,
  }));
  assert.equal(calls.some((call) => call.body?.includes("organizationId") || call.body?.includes("spec")), false);
});

test("registry client keeps persisted migration revisions redacted to summaries", async () => {
  const targetRevision = {
    id: "target-revision-1",
    architectureId: "target-architecture-1",
    revisionNumber: 1,
    message: "Derived shell",
    patternId: "multi-level-router",
    nodeCount: 3,
    skillCount: 1,
    createdAt: "2026-06-14T00:00:00.000Z",
  };
  const response: ArchitecturePatternMigrationCreateResult = {
    sourceArchitectureId: "architecture-1",
    sourceRevisionId: "revision-2",
    expectedCurrentRevisionId: "revision-2",
    migration: blockedOrReadyMigration(),
    created: true,
    replayed: false,
    persisted: {
      targetArchitecture: {
        id: "target-architecture-1",
        name: "Derived shell",
        patternId: "multi-level-router",
      },
      targetRevision,
      lineage: {
        sourceArchitectureId: "architecture-1",
        sourceRevisionId: "revision-2",
        targetArchitectureId: "target-architecture-1",
        targetRevisionId: "target-revision-1",
      },
    },
  };
  const client = createRegistryClient("http://api.test", async () => jsonResponse(201, { ...response, persisted: {
    ...response.persisted!,
    targetRevision,
  } }), "session-token");

  const result = await client.createArchitecturePatternMigration!("architecture-1", {
    expectedCurrentRevisionId: "revision-2",
    targetPatternId: "multi-level-router",
    idempotencyKey: "migration-key-1",
    name: "Derived shell",
  });

  assert.equal(result.persisted?.targetRevision?.id, "target-revision-1");
  assert.equal(result.persisted?.targetRevision?.nodeCount, 3);
  assert.equal("spec" in (result.persisted?.targetRevision ?? {}), false);
});

function blockedOrReadyMigration(): ArchitecturePatternMigrationPreviewResult["migration"] {
  return {
    schemaVersion: 1,
    mode: "derive-shell",
    source: {
      architectureId: "architecture-1",
      patternId: "flat",
      revisionDigest: "a".repeat(64),
    },
    mappingStatus: "provided",
    diff: {
      preservedSkillRefIds: [],
      preservedLeafNodeIds: [],
      addedRouterNodeIds: ["root-router"],
      droppedRouterNodeIds: [],
      addedEdgeCount: 0,
      removedEdgeCount: 0,
      rewrittenBindingCount: 0,
    },
    issues: [],
    migrationDigest: "b".repeat(64),
    diffDigest: "c".repeat(64),
    target: {
      patternId: "multi-level-router",
      spec: {} as never,
      revisionDigest: "d".repeat(64),
    },
  };
}
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    async text() {
      return JSON.stringify(body);
    },
  } as Response;
}
