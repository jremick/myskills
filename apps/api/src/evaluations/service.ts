import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { AppError, canonicalizeJson, sha256Hex, normalizeImprovementEvaluationSuiteV1, improvementDocumentDigest, packageEvaluationSummary, type PackageEvaluationResult, type ImprovementScopeRef } from "@myskills-app/core";
import { evaluatePackageFiles } from "@myskills-app/skill-package";
import { assertActionAuthority } from "../auth/postgres-action-authority.js";
import type { Database, DatabaseTransaction } from "../db/client.js";
import { readArtifactPayload } from "../artifacts/package-payload.js";
import type { ArtifactObjectStorage } from "../artifacts/storage.js";
import { PostgresSubmissionStore } from "../submissions/postgres-submission-store.js";
import { readImprovementScopeRole } from "../improvements/postgres-scope-access.js";
import { isImprovementScopeWriter } from "../improvements/scope-access.js";
import { assertCurrentTeamOwner, isCurrentTeamOwner } from "../repositories/team-ownership.js";
import type { SubmissionActor } from "../submissions/types.js";

export interface EvaluationInput { slug: string; version: string; artifactSha256: string; suiteRevisionId: string; platform: string; idempotencyKey: string; disclosure?: "private" | "public-summary" }
export interface EvaluationRecord { id: string; versionId: string; suiteRevisionId: string; createdAt: string; disclosure: "private" | "public-summary"; reviewContext: { reviewStatus: string; lifecycleStatus: string; context: "release" | "submission" }; result: PackageEvaluationResult }
const missing = () => new AppError("Evaluation resource not found.", "EVALUATION_NOT_FOUND", 404);
const conflict = () => new AppError("Evaluation request or artifact binding changed.", "EVALUATION_BINDING_CONFLICT", 409);

/** API-owned evaluator: immutable completion only; no mutable result update or provider path. */
export class EvaluationService {
  constructor(private readonly db: Database, private readonly options: { artifactStorage?: ArtifactObjectStorage } = {}) {}

  async create(actor: SubmissionActor, input: EvaluationInput): Promise<{ run: EvaluationRecord; created: boolean }> {
    const requestSha = sha256Hex(canonicalizeJson({ ...input, disclosure: input.disclosure ?? "private" }));
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`evaluation:${actor.id}:${input.idempotencyKey}`},0))`);
      const version = await this.authorizeVersion(tx, actor, input.slug, input.version, true);
      if (version.sha256 !== input.artifactSha256) throw conflict();
      const suite = await tx.execute(sql`SELECT r.*, d.owner_type, d.owner_id FROM improvement_document_revisions r
        JOIN improvement_documents d ON d.id=r.document_id WHERE r.id=${input.suiteRevisionId}::uuid AND d.kind='suite' FOR SHARE OF r,d`);
      const revision = suite.rows[0];
      if (!revision) throw missing();
      const scope = { type: revision.owner_type, id: revision.owner_id } as ImprovementScopeRef;
      const scopeRole = await readImprovementScopeRole(tx, actor.id, scope);
      if (!scopeRole) throw missing();
      const disclosure = input.disclosure ?? "private";
      if (disclosure === "public-summary") {
        if (!isImprovementScopeWriter(scope, scopeRole) || !await this.canDisclose(tx, actor.id, version, true)) {
          throw new AppError("Evidence disclosure requires scope management and exact public release authority.", "EVALUATION_DISCLOSURE_FORBIDDEN", 403);
        }
        await assertActionAuthority(tx, actor, ["improvements:run"], version.reviewerAccess ? "review" : "read", { requireMfa: scope.type !== "user" });
      }
      const body = normalizeImprovementEvaluationSuiteV1(revision.body);
      if (!body.assertions || improvementDocumentDigest("suite", body) !== revision.body_sha256) throw conflict();
      const existing = await tx.execute(sql`SELECT * FROM package_evaluation_runs WHERE actor_user_id=${actor.id}::uuid AND idempotency_key=${input.idempotencyKey}`);
      if (existing.rows[0]) {
        if (existing.rows[0].request_sha256 !== requestSha) throw conflict();
        await assertActionAuthority(tx, actor, ["improvements:run"], version.reviewerAccess ? "review" : "read", { requireMfa: disclosure === "public-summary" && scope.type !== "user" });
        return { run: record(existing.rows[0]), created: false };
      }
      const payload = await readArtifactPayload({ artifactStorage: this.options.artifactStorage, artifact: {
        storageKey: String(version.storage_key), sha256: String(version.sha256), byteSize: Number(version.byte_size), contentType: String(version.content_type), payload: version.payload,
      } });
      const context = version.published_at ? "release" as const : "submission" as const;
      const result = evaluatePackageFiles({ files: payload.files, suite: body, target: { platform: input.platform, context }, provenance: "api-owned" });
      if (result.artifactSha256 !== input.artifactSha256 || result.suiteSha256 !== revision.body_sha256) throw conflict();
      const reviewContext = { reviewStatus: String(version.review_status), lifecycleStatus: String(version.lifecycle_status), context };
      // Recheck expiry after artifact IO/evaluation, with retained role/scope locks.
      await assertActionAuthority(tx, actor, ["improvements:run"], version.reviewerAccess ? "review" : "read", { requireMfa: disclosure === "public-summary" && scope.type !== "user" });
      const inserted = await tx.execute(sql`INSERT INTO package_evaluation_runs
        (id,skill_version_id,artifact_sha256,suite_revision_id,suite_sha256,actor_user_id,idempotency_key,request_sha256,result,review_context,disclosure)
        VALUES (${randomUUID()}::uuid,${version.id}::uuid,${input.artifactSha256},${input.suiteRevisionId}::uuid,${result.suiteSha256},${actor.id}::uuid,
          ${input.idempotencyKey},${requestSha},${JSON.stringify(result)}::jsonb,${JSON.stringify(reviewContext)}::jsonb,${disclosure}) RETURNING *`);
      await tx.execute(sql`INSERT INTO audit_events(actor_user_id,action,decision,resource_type,resource_id,details)
        VALUES (${actor.id}::uuid,'evaluation.complete','allow','package_evaluation',${inserted.rows[0]!.id}::uuid,
        ${JSON.stringify({ artifactSha256: result.artifactSha256, suiteSha256: result.suiteSha256, status: result.status, totals: result.totals })}::jsonb)`);
      await assertActionAuthority(tx, actor, ["improvements:run"], version.reviewerAccess ? "review" : "read", { requireMfa: disclosure === "public-summary" && scope.type !== "user" });
      return { run: record(inserted.rows[0]!), created: true };
    });
  }

  async list(actor: SubmissionActor | null, slug: string, version: string, publicSummary = false) {
    return this.db.transaction(async tx => {
      const current = await this.authorizeVersion(tx, actor, slug, version, false, publicSummary);
      const result = await tx.execute(sql`SELECT e.*,d.owner_type,d.owner_id FROM package_evaluation_runs e
        JOIN improvement_document_revisions r ON r.id=e.suite_revision_id JOIN improvement_documents d ON d.id=r.document_id
        WHERE e.skill_version_id=${current.id}::uuid AND e.artifact_sha256=${current.sha256}
          ${publicSummary ? sql`AND e.disclosure='public-summary'` : sql``}
        ORDER BY e.created_at DESC,e.id DESC LIMIT 20 FOR SHARE OF e,r,d`);
      const runs: EvaluationRecord[] = [];
      for (const row of result.rows) {
        const scope = { type: row.owner_type, id: row.owner_id } as ImprovementScopeRef;
        const reader = publicSummary ? String(row.actor_user_id) : actor!.id;
        const role = await readImprovementScopeRole(tx, reader, scope);
        if (!role || (publicSummary && (!isImprovementScopeWriter(scope, role) || !await this.canDisclose(tx, reader, current, false)))) continue;
        runs.push(record(row));
      }
      // Includes time spent waiting for suite, organization, membership and disclosure rows.
      if (actor) await assertActionAuthority(tx, actor, ["improvements:read"], current.reviewerAccess ? "review" : "read");
      return publicSummary ? runs.map(run => ({ id: run.id, versionId: run.versionId, createdAt: run.createdAt, summary: packageEvaluationSummary(run.result) })) : runs;
    });
  }

  private async canDisclose(tx: DatabaseTransaction, actorId: string, version: Record<string, unknown>, lockTeam: boolean): Promise<boolean> {
    await retainAudience(tx, actorId, String(version.skill_id));
    const users = await tx.execute(sql`SELECT id FROM users WHERE id=${actorId}::uuid AND status='active' AND email_verified_at IS NOT NULL FOR SHARE`);
    if (!users.rows.length) return false;
    const authority = new PostgresSubmissionStore(tx as unknown as Database);
    const release = await authority.getPublicRelease({ slug: String(version.slug), version: String(version.version), actorId: null });
    if (!release || release.artifact.sha256 !== version.sha256 || version.review_status !== "approved" || !version.published_at) return false;
    if (version.owner_user_id === actorId) return true;
    const roles = await tx.execute(sql`SELECT role FROM role_assignments WHERE user_id=${actorId}::uuid AND scope_type='instance'
      AND scope_id='00000000-0000-0000-0000-000000000000'::uuid FOR SHARE`);
    if (roles.rows.some(row => ["owner", "admin", "maintainer"].includes(String(row.role)))) return true;
    if (!version.owner_team_id) return false;
    if (lockTeam) await assertCurrentTeamOwner(tx, String(version.owner_team_id), actorId);
    return isCurrentTeamOwner(tx, String(version.owner_team_id), actorId);
  }

  private async authorizeVersion(tx: DatabaseTransaction, actor: SubmissionActor | null, slug: string, version: string, write: boolean, publicOnly = false): Promise<Record<string, unknown> & { reviewerAccess: boolean }> {
    await tx.execute(sql`LOCK TABLE instance_settings IN SHARE MODE`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`submission:${slug}`},0))`);
    const result = await tx.execute(sql`SELECT v.*,s.owner_user_id,s.owner_team_id,s.slug,a.sha256,a.storage_key,a.byte_size,a.content_type,a.payload FROM skills s JOIN skill_versions v ON v.skill_id=s.id
      JOIN skill_artifacts a ON a.skill_version_id=v.id WHERE s.slug=${slug} AND v.version=${version} FOR SHARE OF s,v,a`);
    const row = result.rows[0];
    if (!row) throw missing();
    if (actor) {
      await retainAudience(tx, actor.id, String(row.skill_id));
      await assertActionAuthority(tx, actor, [write ? "improvements:run" : "improvements:read"], "read");
    }
    const authority = new PostgresSubmissionStore(tx as unknown as Database);
    const release = await authority.getPublicRelease({ slug, version, actorId: publicOnly ? null : actor?.id ?? null });
    let reviewerAccess = false;
    if (publicOnly) { if (!release || row.review_status !== "approved" || !row.published_at) throw missing(); }
    else if (!release) {
      if (!actor) throw missing();
      const roles = await tx.execute(sql`SELECT role FROM role_assignments WHERE user_id=${actor.id}::uuid AND scope_type='instance'
        AND scope_id='00000000-0000-0000-0000-000000000000'::uuid`);
      const reviewer = roles.rows.some(r => ["owner","admin","maintainer"].includes(String(r.role)));
      reviewerAccess = reviewer;
      if (reviewer) await assertActionAuthority(tx, actor, [write ? "improvements:run" : "improvements:read"], "review");
      else if (!await authority.getUserSubmissionDetail({ userId: actor.id, submissionId: String(row.id) })) throw missing();
    }
    return { ...row, reviewerAccess };
  }
}
function record(row: Record<string, unknown>): EvaluationRecord {
  return { id: String(row.id), versionId: String(row.skill_version_id), suiteRevisionId: String(row.suite_revision_id),
    disclosure: row.disclosure === "public-summary" ? "public-summary" : "private", createdAt: (row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at))).toISOString(), reviewContext: row.review_context as EvaluationRecord["reviewContext"], result: row.result as PackageEvaluationResult };
}
async function retainAudience(tx: DatabaseTransaction, actorId: string, skillId: string) {
  await tx.execute(sql`SELECT id FROM teams WHERE id IN (SELECT team_id FROM team_memberships WHERE user_id=${actorId}::uuid
    UNION SELECT team_id FROM skill_team_grants WHERE skill_id=${skillId}::uuid UNION SELECT owner_team_id FROM skills WHERE id=${skillId}::uuid) ORDER BY id FOR SHARE`);
  await tx.execute(sql`SELECT id FROM organizations WHERE id IN (SELECT organization_id FROM organization_memberships WHERE user_id=${actorId}::uuid
    UNION SELECT organization_id FROM skill_organization_grants WHERE skill_id=${skillId}::uuid
    UNION SELECT t.organization_id FROM teams t WHERE t.id IN (SELECT team_id FROM team_memberships WHERE user_id=${actorId}::uuid
      UNION SELECT team_id FROM skill_team_grants WHERE skill_id=${skillId}::uuid UNION SELECT owner_team_id FROM skills WHERE id=${skillId}::uuid)) ORDER BY id FOR SHARE`);
}
