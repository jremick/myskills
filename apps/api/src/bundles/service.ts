import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  AppError,
  type BundleInput,
  type BundleMember,
  type BundleMembership,
  type BundlePageInput,
  type BundleSourceSelection,
  type BundleSummary,
  type LibraryEntry,
  type PublicSkill,
  type RegistryCatalog,
  type RegistryCatalogRow,
  type RegistryView,
} from "@myskills-app/core";
import type { Database, DatabaseTransaction } from "../db/client.js";
import { PostgresSkillRepository } from "../repositories/postgres-skill-repository.js";
import { effectiveTeamRole } from "../libraries/postgres-store.js";

type Actor = { id: string; roles: string[]; mfaVerified?: boolean };
type Db = Database | DatabaseTransaction;
type BundleRow = {
  id: string;
  kind: "source" | "curated";
  name: string;
  purpose: string;
  visibility: BundleSummary["visibility"];
  revision: number;
  owner_user_id: string | null;
  owner_team_id: string | null;
  owner_name: string;
  team_role: string | null;
  source_entry_id: string | null;
  repository_id: string | null;
  full_name: string | null;
  source_path: string | null;
  updated_at: Date;
};
type State = {
  skills: PublicSkill[];
  bundles: Array<{ summary: BundleSummary; slugs: string[] }>;
  memberships: Map<string, BundleMembership[]>;
};
const absent = () =>
  new AppError("Bundle is unavailable.", "BUNDLE_NOT_FOUND", 404);
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const matching = (query: string, ...values: string[]) =>
  values.some((value) => value.toLocaleLowerCase("en").includes(query));
const brief = (b: BundleSummary): BundleMembership => ({
  id: b.id,
  name: b.name,
  kind: b.kind,
});

/** The catalog is calculated from one database snapshot. Cursors fingerprint the
 * authorized result, never cache it; changes require a refresh instead of mixing pages. */
export class BundleService {
  constructor(private readonly db: Database) {}

  async catalog(
    actorId: string | null,
    input: BundlePageInput & { view?: RegistryView } = {},
  ): Promise<RegistryCatalog> {
    return this.read(async (tx) => {
      const state = await this.state(tx, actorId);
      const { bundles, skills } = this.filter(state, input.query);
      const memberSet = new Set(bundles.flatMap((b) => b.slugs));
      const rows: RegistryCatalogRow[] =
        input.view === "list"
          ? skills.map((skill) => ({
              kind: "skill",
              ...this.member(state, skill),
              match:
                normalizeQuery(input.query) &&
                !matching(
                  normalizeQuery(input.query),
                  skill.slug,
                  skill.title,
                  skill.summary,
                )
                  ? "bundle"
                  : "skill",
            }))
          : [
              ...bundles.map((b) => ({
                kind: "bundle" as const,
                bundle: b.summary,
              })),
              ...skills
                .filter((skill) => !memberSet.has(skill.slug))
                .map((skill) => ({
                  kind: "skill" as const,
                  ...this.member(state, skill),
                })),
            ];
      const scope = {
        actorId,
        view: input.view ?? "grouped",
        query: normalizeQuery(input.query),
      };
      const snapshot = digest({
        scope,
        skills,
        bundles: bundles.map((b) => ({ summary: b.summary, slugs: b.slugs })),
      });
      const page = paginate(rows, input, snapshot, scope);
      return {
        rows: page.items,
        nextCursor: page.nextCursor,
        totalSkills: skills.length,
        totalBundles: bundles.length,
        snapshot,
      };
    });
  }

  async get(
    id: string,
    actorId: string | null,
  ): Promise<{ bundle: BundleSummary }> {
    return this.read(async (tx) => ({
      bundle: await this.summary(tx, id, actorId),
    }));
  }

  async members(
    id: string,
    actorId: string | null,
    input: BundlePageInput = {},
  ) {
    return this.read(async (tx) => {
      const state = await this.state(tx, actorId);
      if (!state.bundles.some((b) => b.summary.id === id)) throw absent();
      const filtered = this.filter(state, input.query).bundles.find(
        (b) => b.summary.id === id,
      );
      const skills = (filtered?.slugs ?? []).map((slug) =>
        this.member(
          state,
          state.skills.find((s) => s.slug === slug)!,
        ),
      );
      const scope = { id, actorId, query: normalizeQuery(input.query) };
      const page = paginate(
        skills,
        input,
        digest({
          scope,
          skills,
          revision: state.bundles.find((b) => b.summary.id === id)!.summary
            .revision,
        }),
        scope,
      );
      return {
        skills: page.items,
        total: skills.length,
        nextCursor: page.nextCursor,
        match: filtered?.summary.match ?? ("members" as const),
      };
    });
  }

  async memberships(slug: string, actorId: string | null) {
    return this.read(async (tx) => {
      const state = await this.state(tx, actorId);
      if (!state.skills.some((s) => s.slug === slug))
        throw new AppError("Skill is unavailable.", "SKILL_NOT_FOUND", 404);
      return { bundles: state.memberships.get(slug) ?? [] };
    });
  }

  async sources(actor: Actor): Promise<{ sources: BundleSourceSelection[] }> {
    return this.read(async (tx) => ({
      sources: await this.sourceSelections(tx, actor.id),
    }));
  }

  async write(
    actor: Actor,
    input: BundleInput,
    id?: string,
    expectedRevision?: number,
  ): Promise<{ bundle: BundleSummary }> {
    const bundleId = await this.db.transaction(async (tx) => {
      await this.lockActor(tx, actor);
      const roles = await tx.execute<{ role: string }>(
        sql`SELECT role FROM role_assignments WHERE user_id=${actor.id}::uuid FOR SHARE`,
      );
      if (
        !roles.rows.some((r) =>
          ["owner", "admin", "maintainer", "author"].includes(r.role),
        )
      )
        throw new AppError(
          "An author role is required.",
          "SUBMISSION_ROLE_REQUIRED",
          403,
        );
      await tx.execute(
        sql`SELECT key FROM instance_settings WHERE key='sharing' FOR SHARE`,
      );
      const repo = new PostgresSkillRepository(tx);
      const sharing = await repo.getSharingSettings();
      if (
        (input.visibility === "public" && !sharing.publicVisibilityEnabled) ||
        (input.visibility === "authenticated" &&
          !sharing.authenticatedVisibilityEnabled) ||
        (input.visibility === "team" &&
          (!sharing.teamsEnabled || !sharing.teamVisibilityEnabled))
      )
        throw new AppError(
          "This audience is disabled.",
          "BUNDLE_AUDIENCE_DISABLED",
          422,
        );
      if (input.owner.type === "team") {
        await this.lockTeamOwner(tx, input.owner.id, actor.id);
        if (!actor.mfaVerified)
          throw new AppError(
            "MFA verification is required.",
            "MFA_VERIFICATION_REQUIRED",
            403,
          );
      }
      let current: BundleRow | undefined;
      if (id) {
        await tx.execute(
          sql`SELECT id FROM skill_bundles WHERE id=${id}::uuid FOR UPDATE`,
        );
        current = (await this.bundleRows(tx, actor.id)).find(
          (b) => b.id === id,
        );
        if (!current || !this.editable(current, actor.id)) throw absent();
        if (current.revision !== expectedRevision)
          throw new AppError(
            "This bundle changed. Refresh before saving.",
            "BUNDLE_REVISION_CONFLICT",
            409,
          );
        if (
          current.kind !== input.kind ||
          current.owner_user_id !==
            (input.owner.type === "user" ? actor.id : null) ||
          current.owner_team_id !==
            (input.owner.type === "team" ? input.owner.id : null) ||
          current.source_entry_id !== (input.sourceEntryId ?? null)
        )
          throw new AppError(
            "Bundle kind, owner and source are fixed.",
            "BUNDLE_IDENTITY_IMMUTABLE",
            422,
          );
      }
      // Sharing mutations take the same skill-row lock, so membership/audience
      // validation cannot race a permission change between checking and commit.
      const memberRows = await tx.execute<{ id: string; slug: string }>(
        sql`SELECT id,slug FROM skills WHERE slug IN (${sql.join(
          input.memberSlugs.map((s) => sql`${s}`),
          sql`,`,
        )}) ORDER BY id FOR SHARE`,
      );
      if (memberRows.rows.length !== input.memberSlugs.length)
        throw new AppError(
          "One or more skills are unavailable for this audience.",
          "BUNDLE_MEMBER_NOT_AUTHORIZED",
          422,
        );
      for (const slug of input.memberSlugs) {
        const skill = await repo.getVisibleSkillBySlug(slug, actor.id);
        const audienceOk =
          skill &&
          ((input.visibility === "private" && input.owner.type === "user") ||
            (input.visibility === "public"
              ? skill.visibility === "public"
              : input.visibility === "authenticated"
                ? skill.visibility === "authenticated" ||
                  (skill.visibility === "public" && sharing.publicVisibilityEnabled)
                : input.owner.type === "team" &&
                  Boolean(
                    await repo.getSkillVisibleToTeamBySlug(
                      slug,
                      input.owner.id,
                    ),
                  )));
        if (!audienceOk)
          throw new AppError(
            "One or more skills are unavailable for this audience.",
            "BUNDLE_MEMBER_NOT_AUTHORIZED",
            422,
          );
      }
      if (input.kind === "source") {
        const selection = (await this.sourceSelections(tx, actor.id)).find(
          (s) => s.entryId === input.sourceEntryId,
        );
        if (
          !selection ||
          input.memberSlugs.some(
            (slug) => !selection.skills.some((s) => s.slug === slug),
          )
        )
          throw new AppError(
            "Choose reviewed imports from this source selection.",
            "BUNDLE_SOURCE_SELECTION_INVALID",
            422,
          );
        await tx.execute(
          sql`SELECT id FROM library_entries WHERE id=${selection.entryId}::uuid FOR SHARE`,
        );
      }
      let resultId = id;
      if (!resultId) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bundle-owner:${input.owner.type === "user" ? actor.id : input.owner.id}`},0))`,
        );
        const count = await tx.execute<{ count: string }>(
          sql`SELECT count(*)::text AS count FROM skill_bundles WHERE ${input.owner.type === "user" ? sql`owner_user_id=${actor.id}::uuid` : sql`owner_team_id=${input.owner.id}::uuid`}`,
        );
        if (Number(count.rows[0]!.count) >= 100)
          throw new AppError(
            "This owner has reached the bundle limit.",
            "BUNDLE_LIMIT_EXCEEDED",
            422,
          );
        if (
          input.sourceEntryId &&
          (
            await tx.execute(
              sql`SELECT id FROM skill_bundles WHERE source_entry_id=${input.sourceEntryId}::uuid`,
            )
          ).rows.length
        )
          throw new AppError(
            "This source selection already has a bundle.",
            "BUNDLE_SOURCE_DUPLICATE",
            409,
          );
        const inserted = await tx.execute<{
          id: string;
        }>(sql`INSERT INTO skill_bundles(kind,name,purpose,owner_user_id,owner_team_id,visibility,source_entry_id)
          VALUES(${input.kind},${input.name},${input.purpose},${input.owner.type === "user" ? actor.id : null}::uuid,${input.owner.type === "team" ? input.owner.id : null}::uuid,${input.visibility},${input.sourceEntryId ?? null}::uuid) RETURNING id`);
        resultId = inserted.rows[0]!.id;
      } else {
        await tx.execute(
          sql`UPDATE skill_bundles SET name=${input.name},purpose=${input.purpose},visibility=${input.visibility},revision=revision+1,updated_at=now() WHERE id=${resultId}::uuid`,
        );
        await tx.execute(
          sql`DELETE FROM skill_bundle_members WHERE bundle_id=${resultId}::uuid`,
        );
      }
      for (const [position, slug] of input.memberSlugs.entries())
        await tx.execute(
          sql`INSERT INTO skill_bundle_members(bundle_id,skill_id,position) VALUES(${resultId}::uuid,${memberRows.rows.find((s) => s.slug === slug)!.id}::uuid,${position})`,
        );
      await tx.execute(
        sql`INSERT INTO audit_events(actor_user_id,action,decision,resource_type,resource_id,details) VALUES(${actor.id}::uuid,${id ? "bundle.update" : "bundle.create"},'allow','bundle',${resultId},${JSON.stringify({ kind: input.kind, visibility: input.visibility, revision: id ? (expectedRevision ?? 0) + 1 : 1 })}::jsonb)`,
      );
      return resultId;
    });
    return this.get(bundleId, actor.id);
  }

  async save(
    id: string,
    actor: Actor,
    input: { libraryId: string; expectedRevision: number },
  ): Promise<{ entry: LibraryEntry; replayed: boolean }> {
    return this.db.transaction(async (tx) => {
      await this.lockActor(tx, actor);
      await tx.execute(
        sql`SELECT id FROM skill_bundles WHERE id=${id}::uuid FOR SHARE`,
      );
      const bundle = await this.summary(tx, id, actor.id);
      if (bundle.revision !== input.expectedRevision)
        throw new AppError(
          "This bundle changed. Review it before saving.",
          "BUNDLE_REVISION_CONFLICT",
          409,
        );
      const libs = await tx.execute<{
        owner_user_id: string | null;
        owner_team_id: string | null;
      }>(
        sql`SELECT owner_user_id,owner_team_id FROM libraries WHERE id=${input.libraryId}::uuid AND status='active' FOR UPDATE`,
      );
      const lib = libs.rows[0];
      if (!lib)
        throw new AppError("Library is unavailable.", "LIBRARY_NOT_FOUND", 404);
      if (lib.owner_team_id) {
        await this.lockTeamOwner(tx, lib.owner_team_id, actor.id);
        if (!actor.mfaVerified)
          throw new AppError(
            "MFA verification is required.",
            "MFA_VERIFICATION_REQUIRED",
            403,
          );
      } else if (lib.owner_user_id !== actor.id)
        throw new AppError("Library is unavailable.", "LIBRARY_NOT_FOUND", 404);
      // Hold any audience membership used for this read through the reference write.
      if (bundle.owner.type === "team")
        await this.lockTeam(tx, bundle.owner.id, actor.id);
      await this.summary(tx, id, actor.id);
      const prior = await tx.execute<{
        id: string;
        bundle_revision_saved: number;
        created_at: Date;
      }>(
        sql`SELECT id,bundle_revision_saved,created_at FROM library_entries WHERE library_id=${input.libraryId}::uuid AND bundle_id=${id}::uuid AND kind='bundle' AND status='active'`,
      );
      let row = prior.rows[0];
      if (!row) {
        const count = await tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM library_entries WHERE library_id=${input.libraryId}::uuid AND status='active'`,
        );
        if (Number(count.rows[0]!.n) >= 500)
          throw new AppError(
            "This library has reached its entry limit.",
            "LIBRARY_LIMIT_EXCEEDED",
            422,
          );
        const inserted = await tx.execute<{
          id: string;
          bundle_revision_saved: number;
          created_at: Date;
        }>(
          sql`INSERT INTO library_entries(library_id,kind,title,bundle_id,bundle_revision_saved,created_by_user_id) VALUES(${input.libraryId}::uuid,'bundle','Bundle reference',${id}::uuid,${bundle.revision},${actor.id}::uuid) RETURNING id,bundle_revision_saved,created_at`,
        );
        row = inserted.rows[0]!;
        await tx.execute(
          sql`INSERT INTO audit_events(actor_user_id,action,decision,resource_type,resource_id,details) VALUES(${actor.id}::uuid,'library.bundle.save','allow','library_entry',${row.id},${JSON.stringify({ bundleId: id, revision: bundle.revision })}::jsonb)`,
        );
      }
      return {
        replayed: prior.rows.length > 0,
        entry: {
          id: row.id,
          libraryId: input.libraryId,
          kind: "bundle",
          status: "active",
          revision: 1,
          title: bundle.name,
          bundle: {
            id,
            revisionSaved: row.bundle_revision_saved,
            revision: bundle.revision,
            state: "available",
            memberCount: bundle.memberCount,
          },
          adoption: null,
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.created_at).toISOString(),
        },
      };
    });
  }

  private read<T>(fn: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(fn, {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  }
  private async summary(tx: Db, id: string, actorId: string | null) {
    const b = (await this.state(tx, actorId)).bundles.find(
      (b) => b.summary.id === id,
    );
    if (!b) throw absent();
    return b.summary;
  }
  private member(state: State, skill: PublicSkill): BundleMember {
    return { skill, memberships: state.memberships.get(skill.slug) ?? [] };
  }
  private editable(b: BundleRow, actorId: string | null) {
    return Boolean(
      actorId && (b.owner_user_id === actorId || b.team_role === "owner"),
    );
  }

  private async state(tx: Db, actorId: string | null): Promise<State> {
    const repo = new PostgresSkillRepository(tx);
    const skills: PublicSkill[] = [];
    let afterSlug: string | undefined;
    for (;;) {
      const page = await repo.searchVisibleSkills({
        actorId,
        limit: 200,
        afterSlug,
      });
      skills.push(...page);
      if (page.length < 200) break;
      afterSlug = page.at(-1)!.slug;
    }
    const canPublish = actorId
      ? (
          await tx.execute<{ role: string }>(
            sql`SELECT role FROM role_assignments WHERE user_id=${actorId}::uuid`,
          )
        ).rows.some((row) =>
          ["author", "maintainer", "admin", "owner"].includes(row.role),
        )
      : false;
    const visible = new Set(skills.map((s) => s.slug));
    const rows = await this.bundleRows(tx, actorId);
    const members = rows.length
      ? (
          await tx.execute<{ bundle_id: string; slug: string }>(
            sql`SELECT m.bundle_id,s.slug FROM skill_bundle_members m JOIN skills s ON s.id=m.skill_id WHERE m.bundle_id IN (${sql.join(
              rows.map((r) => sql`${r.id}::uuid`),
              sql`,`,
            )}) ORDER BY m.bundle_id,m.position`,
          )
        ).rows
      : [];
    const bundles = rows.map((b) => {
      const all = members.filter((m) => m.bundle_id === b.id),
        slugs = all.filter((m) => visible.has(m.slug)).map((m) => m.slug);
      const summary: BundleSummary = {
        id: b.id,
        kind: b.kind,
        name: b.name,
        purpose: b.purpose,
        visibility: b.visibility,
        revision: b.revision,
        owner: {
          type: b.owner_team_id ? "team" : "user",
          id: (b.owner_team_id ?? b.owner_user_id)!,
          name: b.owner_name,
        },
        source: b.source_entry_id
          ? {
              entryId: b.source_entry_id,
              repositoryId: b.repository_id!,
              fullName: b.full_name!,
              path: b.source_path ?? "",
            }
          : null,
        memberCount: slugs.length,
        preview: slugs.slice(0, 4).map((slug) => ({ slug })),
        canEdit: canPublish && this.editable(b, actorId),
        partial: this.editable(b, actorId) && slugs.length < all.length,
        match: "all",
        updatedAt: new Date(b.updated_at).toISOString(),
      };
      return { summary, slugs };
    });
    const memberships = new Map<string, BundleMembership[]>();
    for (const b of bundles)
      for (const slug of b.slugs)
        memberships.set(slug, [
          ...(memberships.get(slug) ?? []),
          brief(b.summary),
        ]);
    return { skills, bundles, memberships };
  }

  private filter(state: State, raw?: string) {
    const q = normalizeQuery(raw);
    if (!q) return { skills: state.skills, bundles: state.bundles };
    const direct = new Set(
      state.skills
        .filter((s) => matching(q, s.slug, s.title, s.summary))
        .map((s) => s.slug),
    );
    const included = new Set(direct);
    const bundles = state.bundles.flatMap((b) => {
      const titleMatch = matching(
        q,
        b.summary.name,
        b.summary.purpose,
        b.summary.owner.name,
        b.summary.source?.fullName ?? "",
      );
      const slugs = titleMatch
        ? b.slugs
        : b.slugs.filter((slug) => direct.has(slug));
      if (!titleMatch && !slugs.length) return [];
      for (const slug of slugs) included.add(slug);
      return [
        {
          summary: {
            ...b.summary,
            match: titleMatch ? ("bundle" as const) : ("members" as const),
          },
          slugs,
        },
      ];
    });
    return {
      bundles,
      skills: state.skills.filter((s) => included.has(s.slug)),
    };
  }

  private async bundleRows(
    tx: Db,
    actorId: string | null,
  ): Promise<BundleRow[]> {
    const role = actorId
      ? effectiveTeamRole(sql`b.owner_team_id`, actorId)
      : sql`NULL::text`;
    return (
      await tx.execute<BundleRow>(sql`
      SELECT b.*,coalesce(t.name,u.name,'Curator') AS owner_name,${role} AS team_role,src.repository_id,
        e.acknowledged_full_name AS full_name,e.source_path
      FROM skill_bundles b LEFT JOIN users u ON u.id=b.owner_user_id LEFT JOIN teams t ON t.id=b.owner_team_id
      LEFT JOIN library_entries e ON e.id=b.source_entry_id LEFT JOIN library_sources src ON src.id=e.source_id
      WHERE (b.owner_user_id=${actorId}::uuid OR ${role}='owner'
        OR (b.visibility='public' AND coalesce((SELECT (value->>'publicVisibilityEnabled')::boolean FROM instance_settings WHERE key='sharing'),true))
        OR (b.visibility='authenticated' AND ${actorId}::uuid IS NOT NULL AND coalesce((SELECT (value->>'authenticatedVisibilityEnabled')::boolean FROM instance_settings WHERE key='sharing'),true))
        OR (b.visibility='team' AND ${role} IS NOT NULL AND coalesce((SELECT (value->>'teamsEnabled')::boolean FROM instance_settings WHERE key='sharing'),true) AND coalesce((SELECT (value->>'teamVisibilityEnabled')::boolean FROM instance_settings WHERE key='sharing'),true)))
      ORDER BY b.name COLLATE "C",b.id
    `)
    ).rows;
  }

  private async sourceSelections(
    tx: Db,
    actorId: string,
  ): Promise<BundleSourceSelection[]> {
    const entries = await tx.execute<{
      id: string;
      title: string;
      repository_id: string;
      source_path: string;
    }>(sql`
      SELECT e.id,e.title,s.repository_id,e.source_path FROM library_entries e JOIN libraries l ON l.id=e.library_id JOIN library_sources s ON s.id=e.source_id
      WHERE e.kind='source' AND e.status='active' AND e.pending_full_name IS NULL AND l.status='active' AND l.owner_user_id=${actorId}::uuid ORDER BY e.id`);
    const repo = new PostgresSkillRepository(tx);
    const result: BundleSourceSelection[] = [];
    for (const entry of entries.rows) {
      // An actual imported entry plus immutable release provenance establishes
      // membership in this selected source; repository/name coincidence cannot.
      const rows = await tx.execute<{ slug: string }>(
        sql`SELECT DISTINCT s.slug FROM library_entries e JOIN library_import_lineages l ON l.id=e.lineage_id JOIN skills s ON s.slug=l.slug JOIN skill_versions v ON v.skill_id=s.id JOIN skill_release_provenance p ON p.skill_version_id=v.id AND p.lineage_id=l.id WHERE e.source_entry_id=${entry.id}::uuid AND e.kind='skill' AND e.status='active' AND v.published_at IS NOT NULL AND v.review_status='approved' AND v.security_status='passed' AND v.lifecycle_status IN ('approved','deprecated') AND v.deleted_at IS NULL ORDER BY s.slug`,
      );
      const skills: PublicSkill[] = [];
      for (const row of rows.rows) {
        const skill = await repo.getVisibleSkillBySlug(row.slug, actorId);
        if (skill) skills.push(skill);
      }
      if (skills.length)
        result.push({
          entryId: entry.id,
          title: entry.title,
          repositoryId: entry.repository_id,
          path: entry.source_path,
          skills,
        });
    }
    return result;
  }

  private async lockActor(tx: DatabaseTransaction, actor: Actor) {
    const rows = await tx.execute<{ status: string }>(
      sql`SELECT status FROM users WHERE id=${actor.id}::uuid FOR SHARE`,
    );
    if (rows.rows[0]?.status !== "active")
      throw new AppError(
        "Authentication is required.",
        "AUTHENTICATION_REQUIRED",
        401,
      );
  }
  private async lockTeam(tx: DatabaseTransaction, id: string, actorId: string) {
    const teams = await tx.execute<{ organization_id: string | null }>(
      sql`SELECT organization_id FROM teams WHERE id=${id}::uuid FOR SHARE`,
    );
    const org = teams.rows[0]?.organization_id;
    if (org) {
      await tx.execute(
        sql`SELECT id FROM organizations WHERE id=${org}::uuid FOR SHARE`,
      );
      await tx.execute(
        sql`SELECT id FROM organization_memberships WHERE organization_id=${org}::uuid AND user_id=${actorId}::uuid FOR SHARE`,
      );
    }
    await tx.execute(
      sql`SELECT id FROM team_memberships WHERE team_id=${id}::uuid AND user_id=${actorId}::uuid FOR SHARE`,
    );
  }
  private async lockTeamOwner(
    tx: DatabaseTransaction,
    id: string,
    actorId: string,
  ) {
    await this.lockTeam(tx, id, actorId);
    const role = (
      await tx.execute<{ role: string | null }>(
        sql`SELECT ${effectiveTeamRole(sql`${id}::uuid`, actorId)} AS role`,
      )
    ).rows[0]?.role;
    if (role !== "owner")
      throw new AppError(
        "Team curator access is required.",
        "TEAM_OWNER_REQUIRED",
        403,
      );
  }
}

function normalizeQuery(query?: string) {
  return (query ?? "").trim().toLocaleLowerCase("en");
}
function paginate<T>(
  items: T[],
  input: BundlePageInput,
  snapshot: string,
  scope: unknown,
): { items: T[]; nextCursor: string | null } {
  const limit = input.limit ?? 25;
  let offset = 0;
  if (input.cursor) {
    let cursor: { snapshot: string; scope: string; offset: number };
    try {
      cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
    } catch {
      throw new AppError("Invalid page cursor.", "INVALID_PAGE_CURSOR", 400);
    }
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      throw new AppError("Invalid page cursor.", "INVALID_PAGE_CURSOR", 400);
    }
    if (
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      cursor.scope !== digest(scope)
    )
      throw new AppError("Invalid page cursor.", "INVALID_PAGE_CURSOR", 400);
    if (cursor.snapshot !== snapshot)
      throw new AppError(
        "The catalog changed. Refresh to continue.",
        "CATALOG_CHANGED",
        409,
      );
    offset = cursor.offset;
  }
  const end = offset + limit;
  return {
    items: items.slice(offset, end),
    nextCursor:
      end < items.length
        ? Buffer.from(
            JSON.stringify({ snapshot, scope: digest(scope), offset: end }),
          ).toString("base64url")
        : null,
  };
}
