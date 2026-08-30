import { randomUUID } from "node:crypto";
import { AppError } from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import {
  assertArchitectureSpecSize,
  MAX_ARCHITECTURES_PER_OWNER,
  MAX_REVISIONS_PER_ARCHITECTURE,
  validateArchitectureSpec,
} from "./service.js";
import type {
  ArchitectureAuditEvent,
  ArchitectureAuditInput,
  ArchitectureRecord,
  ArchitectureRevisionRecord,
  ArchitectureStore,
  CreateArchitectureInput,
  CreateArchitectureRevisionInput,
} from "./types.js";

interface MemoryArchitecture extends ArchitectureRecord {
  revisions: ArchitectureRevisionRecord[];
}

export class MemoryArchitectureStore implements ArchitectureStore {
  readonly kind = "memory" as const;
  private readonly architectures = new Map<string, MemoryArchitecture>();
  private readonly auditEvents: ArchitectureAuditEvent[] = [];

  async listArchitectures(ownerUserId: string): Promise<ArchitectureRecord[]> {
    return [...this.architectures.values()]
      .filter((architecture) => architecture.ownerUserId === ownerUserId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(0, MAX_ARCHITECTURES_PER_OWNER)
      .map(stripRevisions);
  }

  async getArchitecture(ownerUserId: string, architectureId: string): Promise<ArchitectureRecord | null> {
    const architecture = this.architectures.get(architectureId);
    return architecture?.ownerUserId === ownerUserId ? stripRevisions(architecture) : null;
  }

  async listRevisions(ownerUserId: string, architectureId: string): Promise<ArchitectureRevisionRecord[] | null> {
    const architecture = this.architectures.get(architectureId);
    if (!architecture || architecture.ownerUserId !== ownerUserId) return null;
    return architecture.revisions
      .map(cloneRevision)
      .reverse()
      .slice(0, MAX_REVISIONS_PER_ARCHITECTURE);
  }

  async getRevision(ownerUserId: string, architectureId: string, revisionId?: string): Promise<ArchitectureRevisionRecord | null> {
    const architecture = this.architectures.get(architectureId);
    if (!architecture || architecture.ownerUserId !== ownerUserId) return null;
    const revision = revisionId
      ? architecture.revisions.find((candidate) => candidate.id === revisionId)
      : architecture.revisions.at(-1);
    return revision ? cloneRevision(revision) : null;
  }

  async createArchitecture(input: CreateArchitectureInput): Promise<ArchitectureRecord> {
    const ownerCount = [...this.architectures.values()].filter((architecture) => architecture.ownerUserId === input.ownerUserId).length;
    if (ownerCount >= MAX_ARCHITECTURES_PER_OWNER) {
      throw new AppError(
        `An owner may create at most ${MAX_ARCHITECTURES_PER_OWNER} architectures.`,
        "ARCHITECTURE_QUOTA_EXCEEDED",
        409,
      );
    }
    const now = new Date().toISOString();
    const architecture: MemoryArchitecture = {
      id: `architecture-${this.architectures.size + 1}-${randomUUID().slice(0, 8)}`,
      ownerUserId: input.ownerUserId,
      name: input.name,
      description: input.description,
      patternId: input.patternId,
      currentRevisionId: null,
      revisionCount: 0,
      createdAt: now,
      updatedAt: now,
      revisions: [],
    };
    this.architectures.set(architecture.id, architecture);
    return stripRevisions(architecture);
  }

  async createRevision(input: CreateArchitectureRevisionInput): Promise<ArchitectureRevisionRecord | null> {
    const architecture = this.architectures.get(input.architectureId);
    if (!architecture || architecture.ownerUserId !== input.ownerUserId) return null;
    if (architecture.revisionCount >= MAX_REVISIONS_PER_ARCHITECTURE) {
      throw new AppError(
        `An architecture may contain at most ${MAX_REVISIONS_PER_ARCHITECTURE} revisions.`,
        "ARCHITECTURE_REVISION_QUOTA_EXCEEDED",
        409,
      );
    }
    const spec = validateArchitectureSpec(input.spec, architecture.patternId);
    assertArchitectureSpecSize(spec);
    const now = new Date().toISOString();
    const revision: ArchitectureRevisionRecord = {
      id: `revision-${architecture.revisionCount + 1}-${randomUUID().slice(0, 8)}`,
      architectureId: architecture.id,
      revisionNumber: architecture.revisionCount + 1,
      message: input.message,
      spec: structuredClone(spec),
      createdByUserId: input.ownerUserId,
      createdAt: now,
    };
    architecture.revisions.push(revision);
    architecture.revisionCount = revision.revisionNumber;
    architecture.currentRevisionId = revision.id;
    architecture.updatedAt = now;
    return cloneRevision(revision);
  }

  async recordAuditEvent(input: ArchitectureAuditInput): Promise<void> {
    this.auditEvents.push({
      id: `architecture-audit-${this.auditEvents.length + 1}`,
      actorUserId: input.actorUserId,
      action: input.action,
      decision: "allow",
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      details: sanitizeAuditDetails(input.details ?? {}),
      createdAt: new Date().toISOString(),
    });
  }

  async listAuditEvents(limit = 100): Promise<ArchitectureAuditEvent[]> {
    return this.auditEvents.slice(-Math.max(1, Math.min(limit, 500))).reverse().map((event) => ({
      ...event,
      details: structuredClone(event.details),
    }));
  }
}

function stripRevisions(architecture: MemoryArchitecture): ArchitectureRecord {
  const { revisions: _revisions, ...record } = architecture;
  return { ...record };
}

function cloneRevision(revision: ArchitectureRevisionRecord): ArchitectureRevisionRecord {
  return {
    ...revision,
    spec: structuredClone(revision.spec),
  };
}
