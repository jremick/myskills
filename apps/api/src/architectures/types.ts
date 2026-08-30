import type { ArchitecturePatternId, ArchitectureSpecV1 } from "@myskills-app/core";

export type {
  ArchitectureEnvironment,
  ArchitecturePattern,
  ArchitecturePatternId,
  ArchitectureProfile,
  ArchitectureProfileBinding,
  ArchitectureSkillRef,
  ArchitectureSpecV1,
} from "@myskills-app/core";

export type ArchitectureSpec = ArchitectureSpecV1;

export interface ArchitectureRecord {
  id: string;
  ownerUserId: string;
  name: string;
  description: string;
  patternId: ArchitecturePatternId;
  currentRevisionId: string | null;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArchitectureRevisionRecord {
  id: string;
  architectureId: string;
  revisionNumber: number;
  message: string;
  spec: ArchitectureSpec;
  createdByUserId: string;
  createdAt: string;
}

export interface ArchitectureAuditEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  decision: "allow" | "deny";
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ArchitectureAuditInput {
  actorUserId: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  details?: Record<string, unknown>;
}

export interface CreateArchitectureInput {
  ownerUserId: string;
  name: string;
  description: string;
  patternId: ArchitecturePatternId;
}

export interface CreateArchitectureRevisionInput {
  ownerUserId: string;
  architectureId: string;
  message: string;
  spec: ArchitectureSpec;
}

export interface ArchitectureStore {
  readonly kind: "memory" | "postgres";
  listArchitectures(ownerUserId: string): Promise<ArchitectureRecord[]>;
  getArchitecture(ownerUserId: string, architectureId: string): Promise<ArchitectureRecord | null>;
  listRevisions(ownerUserId: string, architectureId: string): Promise<ArchitectureRevisionRecord[] | null>;
  getRevision(ownerUserId: string, architectureId: string, revisionId?: string): Promise<ArchitectureRevisionRecord | null>;
  createArchitecture(input: CreateArchitectureInput): Promise<ArchitectureRecord>;
  createRevision(input: CreateArchitectureRevisionInput): Promise<ArchitectureRevisionRecord | null>;
  recordAuditEvent(input: ArchitectureAuditInput): Promise<void>;
  listAuditEvents(limit?: number): Promise<ArchitectureAuditEvent[]>;
}
