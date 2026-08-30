import { and, desc, eq, sql } from "drizzle-orm";
import { AppError, validateArchitectureSpec as validateCoreArchitectureSpec } from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { Database } from "../db/client.js";
import { auditEvents, skillArchitectureRevisions, skillArchitectures, users } from "../db/schema.js";
import {
  assertArchitectureSpecSize,
  MAX_ARCHITECTURES_PER_OWNER,
  MAX_REVISIONS_PER_ARCHITECTURE,
  validateArchitecturePattern,
  validateArchitectureSpec,
} from "./service.js";
import type {
  ArchitectureAuditEvent,
  ArchitectureAuditInput,
  ArchitectureRecord,
  ArchitectureRevisionRecord,
  ArchitectureSpec,
  ArchitectureStore,
  CreateArchitectureInput,
  CreateArchitectureRevisionInput,
} from "./types.js";

export class PostgresArchitectureStore implements ArchitectureStore {
  readonly kind = "postgres" as const;

  constructor(private readonly db: Database) {}

  async listArchitectures(ownerUserId: string): Promise<ArchitectureRecord[]> {
    const rows = await this.db
      .select({
        architecture: skillArchitectures,
        revisionCount: sql<number>`count(${skillArchitectureRevisions.id})`,
      })
      .from(skillArchitectures)
      .leftJoin(skillArchitectureRevisions, eq(skillArchitectureRevisions.architectureId, skillArchitectures.id))
      .where(eq(skillArchitectures.ownerUserId, ownerUserId))
      .groupBy(skillArchitectures.id)
      .orderBy(desc(skillArchitectures.updatedAt), desc(skillArchitectures.id))
      .limit(MAX_ARCHITECTURES_PER_OWNER);
    return rows.map((row) => this.toArchitectureRecord(row.architecture, Number(row.revisionCount)));
  }

  async getArchitecture(ownerUserId: string, architectureId: string): Promise<ArchitectureRecord | null> {
    const [row] = await this.db
      .select({
        architecture: skillArchitectures,
        revisionCount: sql<number>`count(${skillArchitectureRevisions.id})`,
      })
      .from(skillArchitectures)
      .leftJoin(skillArchitectureRevisions, eq(skillArchitectureRevisions.architectureId, skillArchitectures.id))
      .where(and(eq(skillArchitectures.id, architectureId), eq(skillArchitectures.ownerUserId, ownerUserId)))
      .groupBy(skillArchitectures.id)
      .limit(1);
    return row ? this.toArchitectureRecord(row.architecture, Number(row.revisionCount)) : null;
  }

  async listRevisions(ownerUserId: string, architectureId: string): Promise<ArchitectureRevisionRecord[] | null> {
    const architecture = await this.getOwnedArchitectureRow(ownerUserId, architectureId);
    if (!architecture) return null;
    const rows = await this.db
      .select()
      .from(skillArchitectureRevisions)
      .where(eq(skillArchitectureRevisions.architectureId, architecture.id))
      .orderBy(desc(skillArchitectureRevisions.revisionNumber), desc(skillArchitectureRevisions.id))
      .limit(MAX_REVISIONS_PER_ARCHITECTURE);
    return rows
      .slice(0, MAX_REVISIONS_PER_ARCHITECTURE)
      .map((row) => toRevisionRecord(row, architecture.id, validateArchitecturePattern(architecture.patternId)));
  }

  async getRevision(ownerUserId: string, architectureId: string, revisionId?: string): Promise<ArchitectureRevisionRecord | null> {
    const architecture = await this.getOwnedArchitectureRow(ownerUserId, architectureId);
    if (!architecture) return null;
    const conditions = [eq(skillArchitectureRevisions.architectureId, architecture.id)];
    if (revisionId) conditions.push(eq(skillArchitectureRevisions.id, revisionId));
    const [row] = await this.db
      .select()
      .from(skillArchitectureRevisions)
      .where(and(...conditions))
      .orderBy(desc(skillArchitectureRevisions.revisionNumber))
      .limit(1);
    return row ? toRevisionRecord(row, architecture.id, validateArchitecturePattern(architecture.patternId)) : null;
  }

  async createArchitecture(input: CreateArchitectureInput): Promise<ArchitectureRecord> {
    return this.db.transaction(async (tx) => {
      // Lock the owner row so concurrent creates cannot bypass the quota check.
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.ownerUserId))
        .for("update")
        .limit(1);
      if (!owner) throw new AppError("Architecture owner was not found.", "ARCHITECTURE_NOT_FOUND", 404);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(skillArchitectures)
        .where(eq(skillArchitectures.ownerUserId, input.ownerUserId));
      if (Number(count) >= MAX_ARCHITECTURES_PER_OWNER) {
        throw new AppError(
          `An owner may create at most ${MAX_ARCHITECTURES_PER_OWNER} architectures.`,
          "ARCHITECTURE_QUOTA_EXCEEDED",
          409,
        );
      }
      const [row] = await tx
        .insert(skillArchitectures)
        .values({
          ownerUserId: input.ownerUserId,
          name: input.name,
          description: input.description,
          patternId: input.patternId,
        })
        .returning();
      if (!row) throw new Error("Architecture insert failed.");
      return this.toArchitectureRecord(row, 0);
    });
  }

  async createRevision(input: CreateArchitectureRevisionInput): Promise<ArchitectureRevisionRecord | null> {
    return this.db.transaction(async (tx) => {
      const [architecture] = await tx
        .select()
        .from(skillArchitectures)
        .where(and(eq(skillArchitectures.id, input.architectureId), eq(skillArchitectures.ownerUserId, input.ownerUserId)))
        .for("update")
        .limit(1);
      if (!architecture) return null;
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(skillArchitectureRevisions)
        .where(eq(skillArchitectureRevisions.architectureId, architecture.id));
      if (Number(count) >= MAX_REVISIONS_PER_ARCHITECTURE) {
        throw new AppError(
          `An architecture may contain at most ${MAX_REVISIONS_PER_ARCHITECTURE} revisions.`,
          "ARCHITECTURE_REVISION_QUOTA_EXCEEDED",
          409,
        );
      }
      const spec = validateArchitectureSpec(input.spec, validateArchitecturePattern(architecture.patternId));
      assertArchitectureSpecSize(spec);
      const revisionNumber = (await tx
        .select({ max: sql<number>`coalesce(max(${skillArchitectureRevisions.revisionNumber}), 0)` })
        .from(skillArchitectureRevisions)
        .where(eq(skillArchitectureRevisions.architectureId, architecture.id)))[0]?.max ?? 0;
      const nextRevisionNumber = Number(revisionNumber) + 1;
      const [row] = await tx
        .insert(skillArchitectureRevisions)
        .values({
          architectureId: architecture.id,
          revisionNumber: nextRevisionNumber,
          message: input.message,
          spec,
          createdByUserId: input.ownerUserId,
        })
        .returning();
      if (!row) throw new Error("Architecture revision insert failed.");
      await tx
        .update(skillArchitectures)
        .set({ currentRevisionId: row.id, updatedAt: new Date() })
        .where(eq(skillArchitectures.id, architecture.id));
      return toRevisionRecord(row, architecture.id, validateArchitecturePattern(architecture.patternId));
    });
  }

  async recordAuditEvent(input: ArchitectureAuditInput): Promise<void> {
    await this.db.insert(auditEvents).values({
      actorUserId: input.actorUserId,
      action: input.action,
      decision: "allow",
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      details: sanitizeAuditDetails(input.details ?? {}),
    });
  }

  async listAuditEvents(limit = 100): Promise<ArchitectureAuditEvent[]> {
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceType, "skill_architecture"))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(Math.max(1, Math.min(limit, 500)));
    return rows.map((event) => ({
      id: event.id,
      actorUserId: event.actorUserId,
      action: event.action,
      decision: event.decision === "allow" ? "allow" : "deny",
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      details: parseDetails(event.details),
      createdAt: event.createdAt.toISOString(),
    }));
  }

  private async getOwnedArchitectureRow(ownerUserId: string, architectureId: string) {
    const [row] = await this.db
      .select()
      .from(skillArchitectures)
      .where(and(eq(skillArchitectures.id, architectureId), eq(skillArchitectures.ownerUserId, ownerUserId)))
      .limit(1);
    return row ?? null;
  }

  private toArchitectureRecord(row: typeof skillArchitectures.$inferSelect, revisionCount: number): ArchitectureRecord {
    return {
      id: row.id,
      ownerUserId: row.ownerUserId,
      name: row.name,
      description: row.description,
      patternId: row.patternId as ArchitectureRecord["patternId"],
      currentRevisionId: row.currentRevisionId,
      revisionCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function toRevisionRecord(
  row: typeof skillArchitectureRevisions.$inferSelect,
  architectureId: string,
  expectedPatternId: ArchitectureRecord["patternId"],
): ArchitectureRevisionRecord {
  const result = validateCoreArchitectureSpec(row.spec);
  if (!result.valid || result.value.id !== architectureId || result.value.pattern.id !== expectedPatternId) {
    throw new AppError("Persisted architecture revision is invalid.", "PERSISTED_ARCHITECTURE_INVALID", 500);
  }
  try {
    assertArchitectureSpecSize(result.value);
  } catch {
    throw new AppError("Persisted architecture revision is invalid.", "PERSISTED_ARCHITECTURE_INVALID", 500);
  }
  return {
    id: row.id,
    architectureId: row.architectureId,
    revisionNumber: row.revisionNumber,
    message: row.message,
    spec: result.value as ArchitectureSpec,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function parseDetails(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
