import { architecturePlanBodies, architecturePlanQueries } from "./architecture-plan-schemas.js";
import { MAX_PACKAGE_ARCHIVE_BYTES, MAX_PACKAGE_FILES, MAX_PACKAGE_TEXT_BYTES, validatePackageFiles } from "@myskills-app/skill-package";
import { z } from "zod";
import { architecturePatternIds, libraryCandidateStates, libraryEventKinds, librarySourceRefKinds, libraryTrackingModes, visibilityScopes, type DelegatedAction } from "@myskills-app/core";

// Path parameters cannot alter the registered route. The API validates each
// domain's identifiers, revisions and policy documents again on every request.
export const applicationIdentifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/);
const text = (max = 2000) => z.string().min(1).max(max);
const reason = z.string().max(2000).optional();
const improvementReason = z.string().max(2000).nullable().optional();
const improvementIdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
const id = applicationIdentifier;
const ids = z.array(id).max(500);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(0);
const expectedRevision = z.number().int().positive();
const version = text(128);
const object = z.record(z.string().max(128), z.json()).describe("Versioned domain document. Read the current resource/schema first; the API validates its complete contract and rejects invalid fields.");
const empty = z.object({}).strict();
const owner = z.discriminatedUnion("type", [z.object({ type: z.literal("user") }).strict(), z.object({ type: z.literal("team"), id }).strict()]);
const scope = z.object({ type: z.enum(["user", "team", "organization"]), id }).strict();
const role = z.enum(["owner", "admin", "member"]);
const mutationId = id.nullable().optional();
const selectionCreate = z.object({ name: text(120), description: z.string().max(2000).optional(), memberEntryIds: z.array(id).max(200), clientMutationId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional() }).strict();
const selectionUpdate = z.object({ expectedRevision: expectedRevision.max(Number.MAX_SAFE_INTEGER), name: text(120).optional(), description: z.string().max(2000).optional(), memberEntryIds: z.array(id).max(200).optional().describe("Replace the complete ordered membership. An empty array removes all members.") }).strict();
const page = { limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(2048).optional() };
const bundle = { kind: z.enum(["curated", "source"]), name: text(120), purpose: text(2000), owner, visibility: z.enum(["public", "authenticated", "team", "private"]), memberSlugs: z.array(id).min(1).max(200), sourceEntryId: id.optional() };
const policy = z.object({ policy: object, expectedRevisionNumber: revision, reason }).strict();
const migration = { expectedCurrentRevisionId: id, targetPatternId: z.enum(architecturePatternIds), mapping: object.optional() };
const operation = { action: z.enum(["install", "update", "rollback"]), slug: id, version, platform: id.optional(), idempotencyKey: id };
const draftFiles = z.array(z.object({ path: text(1024), content: z.string().max(MAX_PACKAGE_TEXT_BYTES) }).strict()).max(MAX_PACKAGE_FILES).superRefine((files, ctx) => {
  try { validatePackageFiles(files); } catch { ctx.addIssue({ code: "custom", message: "Invalid bounded package files." }); }
});
const draftSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("release"), slug: id, version, platform: id.optional() }).strict(),
  z.object({ kind: z.literal("submission"), submissionId: id }).strict(),
]);
const fields: Record<string, z.ZodType> = {
  ...architecturePlanBodies,
  "draft.create": z.union([z.object({ title: text(120), files: draftFiles }).strict(), z.object({ title: text(120).optional(), source: draftSource }).strict()]),
  "draft.update": z.object({ expectedRevision: expectedRevision.max(Number.MAX_SAFE_INTEGER), title: text(120), files: draftFiles }).strict(),
  "draft.preview": z.union([z.object({ files: draftFiles }).strict(), z.object({ archive: z.object({ filename: text(255).optional(), contentBase64: z.string().min(4).max(Math.ceil(MAX_PACKAGE_ARCHIVE_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict() }).strict()]),
  "draft.validate": z.object({ expectedRevision: expectedRevision.max(Number.MAX_SAFE_INTEGER) }).strict(),
  "draft.submit": z.object({ expectedRevision: expectedRevision.max(Number.MAX_SAFE_INTEGER), release: object.optional() }).strict(),
  "skills.discover": z.object({ task: text(4000), limit: z.number().int().min(1).max(20).optional() }).strict(),
  "admin.github.test": empty,
  "skills.metadata.update": z.object({ title: text(200).optional(), summary: text(4000).optional(), tags: z.array(text(80)).max(100).optional(), visibility: z.enum(visibilityScopes).optional(), reason }).strict(),
  "skills.lifecycle.decide": z.object({ action: z.enum(["archive", "restore", "delete"]), reason }).strict(),
  "skills.releases.lifecycle.decide": z.object({ action: z.enum(["deprecate", "unpublish", "revoke", "restore", "delete"]), reason, replacement: text(128).optional() }).strict(),
  "skills.sharing.replace": z.object({ visibility: z.enum(visibilityScopes), teamIds: ids.optional(), userEmails: z.array(text(320)).max(500).optional(), organizationIds: ids.optional() }).strict(),
  "bundles.create": z.object(bundle).strict(),
  "bundles.update": z.object({ ...bundle, expectedRevision }).strict(),
  "bundles.library_reference.create": z.object({ libraryId: id, expectedRevision }).strict(),
  "submissions.create": z.object({ manifest: object.optional(), files: z.array(z.object({ path: text(1024), content: z.string().max(MAX_PACKAGE_TEXT_BYTES) }).strict()).max(MAX_PACKAGE_FILES).optional(), archive: z.object({ filename: text(255).optional(), contentBase64: z.string().min(4).max(Math.ceil(MAX_PACKAGE_ARCHIVE_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict().optional(), release: object.optional() }).strict().describe("Submit exactly one package source: files or archive. Include release metadata when required by the release contract. Server scanning and review remain mandatory."),
  "submissions.mine.withdraw": z.object({ action: z.literal("withdraw"), reason }).strict(),
  "review.submissions.decide": z.object({ action: z.enum(["approve", "request-changes", "reject", "publish"]), artifactSha256: digest.optional(), reason }).strict(),
  "libraries.create": z.object({ name: text(120), description: z.string().max(2000).optional(), owner: owner.optional(), clientMutationId: mutationId }).strict(),
  "libraries.update": z.object({ expectedRevision, name: text(120).optional(), description: z.string().max(2000).optional() }).strict(),
  "libraries.collections.create": selectionCreate,
  "library_collections.update": selectionUpdate,
  "libraries.groups.create": selectionCreate,
  "library_groups.update": selectionUpdate,
  "libraries.entries.create": z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("skill"), slug: id, clientMutationId: mutationId }).strict(),
    z.object({ kind: z.literal("source"), url: text(2000), ref: z.object({ kind: z.enum(librarySourceRefKinds), value: z.string().max(256).optional() }).strict().optional(), path: z.string().max(1024).optional(), clientMutationId: mutationId }).strict(),
  ]),
  "library_entries.discover": empty,
  "library_entries.preview": z.object({ snapshotId: id, paths: z.array(z.string().max(1024)).max(2000), mappings: z.record(z.string().max(1024), object).optional() }).strict(),
  "library_candidates.import": z.object({ expectedPackageDigest: digest, release: object.optional(), acknowledgeUnverifiedOrder: z.object({ reason: text(500) }).strict().optional(), clientMutationId: mutationId }).strict(),
  "library_candidates.ignore": empty,
  "library_candidates.self_review": z.object({ artifactSha256: digest, reason }).strict(),
  "library_candidates.request_instance_review": empty,
  "library_entries.adopt": z.object({ version, artifactSha256: digest, expectedCurrentAdoptionId: id.nullable(), reason }).strict(),
  "library_entries.tracking.update": z.object({ expectedRevision, mode: z.enum(libraryTrackingModes), acknowledgeIdentityChange: z.boolean().optional() }).strict(),
  "library_entries.check": empty,
  "libraries.subscription.set": z.object({ events: z.array(z.enum(libraryEventKinds)).optional() }).strict(),
  "library_inbox.mark_read": z.object({ eventIds: z.array(id).max(200) }).strict(),
  "library_entries.bindings.create": z.object({ targetId: id, replaceConflicting: z.boolean().optional() }).strict(),
  "admin.libraries.settings.update": z.object({ privateSelfReviewEnabled: z.boolean(), reason }).strict(),
  "review.self_reviewed.elevate": z.object({ artifactSha256: digest, reason }).strict(),
  "teams.create": z.object({ name: text(120) }).strict(),
  "teams.invitations.create": z.object({ email: text(320) }).strict(),
  "teams.invitations.accept": empty,
  "teams.members.update": z.object({ role: z.enum(["owner", "member"]) }).strict(),
  "organizations.create": z.object({ name: text(120), slug: text(120).optional(), policy: object.optional(), reason }).strict(),
  "organizations.lifecycle.decide": z.object({ action: z.literal("archive") }).strict(),
  "organizations.invitations.create": z.object({ email: text(320), role: role.optional() }).strict(),
  "organizations.invitations.accept": empty,
  "organizations.members.update": z.object({ role }).strict(),
  "organizations.policies.append": z.object({ policy: object, reason }).strict(),
  "organizations.policies.decide": z.object({ action: z.literal("activate") }).strict(),
  "organizations.teams.create": z.object({ name: text(120), slug: text(120).optional() }).strict(),
  "teams.organization.set": z.object({ organizationId: id }).strict(),
  "organizations.update_policy.set": policy,
  "architectures.create": z.object({ name: text(120), description: z.string().max(500).optional(), patternId: z.enum(architecturePatternIds), owner: owner.optional() }).strict(),
  "architectures.revisions.append": z.object({ expectedCurrentRevisionId: id.nullable(), spec: object, message: z.string().max(500).optional() }).strict(),
  "architectures.preview": z.object({ revisionId: id.optional(), profileId: id.optional(), environmentId: id.optional(), organizationId: id.optional(), fixture: z.json().optional() }).strict(),
  "architectures.draft.preview": z.object({ expectedCurrentRevisionId: id.nullable(), spec: object, profileId: id.optional(), environmentId: id.optional(), fixture: z.json().optional() }).strict(),
  "architectures.organization_grants.replace": z.object({ expectedCurrentRevisionId: id.nullable(), organizationIds: ids }).strict(),
  "architectures.pattern_migration.preview": z.object(migration).strict(),
  "architectures.pattern_migration.create": z.object({ ...migration, idempotencyKey: id, name: text(120), description: z.string().max(500).optional(), message: z.string().max(500).optional() }).strict(),
  "targets.register": z.object({ name: text(120), owner: scope.optional(), architectureId: id, environmentId: id, profileId: id, adapter: z.object({ kind: text(120), version: text(120), contractVersion: z.union([z.literal(1), z.literal(2)]) }).strict(), capabilities: z.object({ "inventory.read": z.boolean().optional(), "health.read": z.boolean().optional(), "plan.read": z.boolean().optional(), apply: z.boolean().optional(), rollback: z.boolean().optional(), "sync.write": z.boolean().optional() }).strict(), identityDigest: digest.optional(), credentialReference: text(2000).nullable().optional().describe("Existing opaque credential reference only. Never send a password or credential value."), metadata: object.optional() }).strict(),
  "targets.consent.set": z.object({ decision: z.enum(["grant", "deny"]) }).strict(),
  "targets.operations.schedule": z.object(operation).strict(),
  "target_operations.batch.schedule": z.object({ operations: z.array(z.object({ targetId: id, ...operation }).strict()).min(1).max(100) }).strict(),
  "target_operations.cancel": empty,
  "targets.update_policy.set": policy,
  "improvements.declarations.append": z.object({ declaration: object, expectedRevisionNumber: revision, reason: improvementReason }).strict(),
  "improvements.declarations.review": z.object({ decision: z.enum(["approve", "reject"]), artifactSha256: digest, declarationSha256: digest, reason: improvementReason }).strict(),
  "improvements.policy.set": policy.extend({ reason: improvementReason }),
  "improvements.profiles.create": z.object({ owner: scope, profile: object, reason: improvementReason }).strict(),
  "improvements.profiles.append": z.object({ profile: object, expectedRevisionNumber: revision, reason: improvementReason }).strict(),
  "improvements.suites.create": z.object({ owner: scope, suite: object, reason: improvementReason }).strict(),
  "improvements.suites.append": z.object({ suite: object, expectedRevisionNumber: revision, reason: improvementReason }).strict(),
  "improvements.plans.preview": z.object({ request: object }).strict(),
  "improvements.plans.create": z.object({ request: object, idempotencyKey: improvementIdempotencyKey }).strict(),
  "improvements.runs.cancel": z.object({ reason: improvementReason }).strict(),
  "improvements.evidence.share": z.object({ reportSha256: digest, disclosure: z.enum(["summary", "selected-evidence"]), proposals: z.array(z.object({ subject: z.enum(["baseline", "candidate"]), slug: id, version }).strict()).max(4), idempotencyKey: improvementIdempotencyKey }).strict(),
  "improvements.evidence.decide": z.object({ slug: id, version, subject: z.enum(["baseline", "candidate"]), evidenceSha256: digest, decision: z.enum(["accept", "reject"]), reason: improvementReason }).strict(),
  "admin.branding.update": z.object({ text: z.string().max(120), showText: z.boolean(), logoDataUrl: z.string().max(350_000).nullable() }).strict(),
  "admin.site.update": z.object({ landingPageEnabled: z.boolean() }).strict(),
  "admin.registration.set": z.object({ mode: z.enum(["closed", "request", "open"]) }).strict(),
  "admin.registration.invite": z.object({ email: text(320), name: text(120).optional() }).strict(),
  "admin.sharing.set": z.object({ publicVisibilityEnabled: z.boolean(), authenticatedVisibilityEnabled: z.boolean(), teamsEnabled: z.boolean(), teamVisibilityEnabled: z.boolean(), userVisibilityEnabled: z.boolean(), organizationVisibilityEnabled: z.boolean().optional() }).strict(),
  "admin.providers.upsert": z.object({ type: text(120), displayName: text(120), issuer: text(2000).optional(), clientId: text(2000).optional(), enabled: z.boolean().optional(), roleMappings: z.array(z.object({ claim: text(120), value: text(1000), role: text(120) }).strict()).max(500).optional() }).strict(),
  "admin.users.lifecycle.decide": z.object({ action: z.enum(["approve", "activate", "disable", "delete"]), reason }).strict(),
  "admin.users.roles.set": z.object({ roles: z.array(z.enum(["owner", "admin", "maintainer", "author", "user"])).min(1).max(5), reason }).strict(),
};
const queries: Record<string, z.ZodType> = {
  ...architecturePlanQueries,
  "skills.list": z.object({ ...page, q: z.string().max(14 * 1024 * 1024).optional() }).strict(),
  "skills.managed.list": z.object({ ...page, q: z.string().max(14 * 1024 * 1024).optional() }).strict(),
  "skills.releases.export": z.object({ platform: id.optional() }).strict(),
  "submissions.mine.export": z.object({ platform: id.optional() }).strict(),
  "review.submissions.export": z.object({ platform: id.optional() }).strict(),
  "review.submissions.list": z.object(page).strict(),
  "registry.catalog.list": z.object({ ...page, query: z.string().max(200).optional(), view: z.enum(["grouped", "list", "outline"]).optional() }).strict(),
  "bundles.list": z.object({ ...page, query: z.string().max(200).optional() }).strict(),
  "bundles.members.list": z.object({ ...page, query: z.string().max(200).optional() }).strict(),
  "libraries.list": z.object(page).strict(),
  "libraries.delete": z.object({ expectedRevision }).strict(),
  "libraries.collections.list": z.object(page).strict(),
  "library_collections.members.list": z.object(page).strict(),
  "library_collections.delete": z.object({ expectedRevision: expectedRevision.max(Number.MAX_SAFE_INTEGER) }).strict(),
  "libraries.groups.list": z.object(page).strict(),
  "library_groups.members.list": z.object(page).strict(),
  "library_groups.delete": z.object({ expectedRevision: expectedRevision.max(Number.MAX_SAFE_INTEGER) }).strict(),
  "libraries.entries.list": z.object({ ...page, kind: z.enum(["source", "skill"]).optional() }).strict(),
  "library_entries.candidates.list": z.object({ ...page, state: z.enum(libraryCandidateStates).optional() }).strict(),
  "library_candidates.get": z.object({ includeContent: z.boolean().optional() }).strict(),
  "library_inbox.list": z.object({ ...page, unread: z.boolean().optional() }).strict(),
  "targets.observations.list": z.object({ limit: z.number().int().positive().max(500).optional() }).strict(),
  "improvements.profiles.list": z.object({ ownerType: scope.shape.type, ownerId: id }).strict(),
  "improvements.suites.list": z.object({ ownerType: scope.shape.type, ownerId: id }).strict(),
  "admin.audit.list": z.object(page).strict(),
};

export function applicationInputSchema(action: DelegatedAction): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  const params = [...action.route.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]);
  if (params.length) shape.path = z.object(Object.fromEntries(params.map((name) => [name, action.id === "draft.revision" && name === "revision" ? z.string().regex(/^[1-9][0-9]*$/).refine(value => Number.isSafeInteger(Number(value))) : id]))).strict();
  if (queries[action.id]) {
    // Query is required only for deletion concurrency and explicit improvement ownership.
    shape.query = ["libraries.delete", "library_collections.delete", "library_groups.delete", "improvements.profiles.list", "improvements.suites.list"].includes(action.id) ? queries[action.id] : queries[action.id].optional();
  }
  if (action.method !== "GET" && action.method !== "DELETE") {
    if (!fields[action.id]) throw new Error(`MCP application schema missing: ${action.id}`);
    shape.body = fields[action.id] === empty ? empty.optional() : fields[action.id];
  }
  return z.object(shape).strict();
}
