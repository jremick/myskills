import type {
  ArchitectureEnvironment,
  ArchitectureNode,
  ArchitectureProfile,
  ArchitectureSpecV1,
  ArchitectureValidationIssue,
} from "@myskills-app/core";

/**
 * The editor deliberately treats the architecture spec as the only durable
 * value. Canvas positions, zoom, selection, and expansion state stay local to
 * the editor and never appear in these callback payloads.
 */
export interface ArchitectureEditorPreviewRequest {
  spec: ArchitectureSpecV1;
  expectedRevisionId: string | null;
}

export interface ArchitectureEditorSaveRequest extends ArchitectureEditorPreviewRequest {
  message?: string;
}

export interface ArchitectureEditorStatus {
  dirty: boolean;
  valid: boolean;
  validationIssues: ArchitectureValidationIssue[];
}

/** API-authorized registry metadata used by the exact-release picker. */
export interface ArchitectureRegistrySkillOption {
  slug: string;
  title: string;
  summary?: string;
  visibility: ArchitectureSpecV1["skills"][number]["packageVisibility"];
  latestVersion?: string | null;
  tags?: string[];
}

/** A release is immutable only when all of these values come from the API. */
export interface ArchitectureRegistryReleaseOption {
  id: string;
  slug: string;
  title: string;
  summary?: string;
  version: string;
  digest: string;
  packageVisibility: ArchitectureSpecV1["skills"][number]["packageVisibility"];
  tags?: string[];
}

export interface ArchitectureEditorProps {
  /** The server-provided revision used to seed the ephemeral draft. */
  initialSpec: ArchitectureSpecV1;
  /** Optimistic concurrency token forwarded unchanged to save and preview. */
  expectedRevisionId?: string | null;
  /** Preview remains a caller-owned operation; this module performs no I/O. */
  onPreview?: (request: ArchitectureEditorPreviewRequest) => void | Promise<void>;
  /** Save remains a caller-owned operation; this module performs no I/O. */
  onSave?: (request: ArchitectureEditorSaveRequest) => void | Promise<void>;
  /** Receives the current draft after each semantic edit. */
  onDraftChange?: (spec: ArchitectureSpecV1, status: ArchitectureEditorStatus) => void;
  /** Search already-authorized registry metadata for exact release selection. */
  onSearchRegistrySkills?: (query: string) => Promise<ArchitectureRegistrySkillOption[]>;
  /** Load exact immutable release records for a selected registry skill. */
  onLoadRegistryReleases?: (skill: ArchitectureRegistrySkillOption) => Promise<ArchitectureRegistryReleaseOption[]>;
  /** Optional revision note forwarded with save. */
  revisionMessage?: string;
  /** Team members can inspect a draft without being offered write controls. */
  readOnly?: boolean;
  className?: string;
}

export interface ArchitectureTreeNode {
  node: ArchitectureNode;
  children: ArchitectureTreeNode[];
  depth: number;
  position: number;
  siblingCount: number;
}

export type ArchitectureFlowNodeData = Record<string, unknown> & {
  label: string;
  kind: ArchitectureNode["kind"];
  skillRefId?: string;
  selected: boolean;
};

export interface ArchitectureGraphPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArchitectureProfileBindingView {
  binding: ArchitectureProfile["bindings"][number];
  node: ArchitectureNode;
}

export interface ArchitectureEditorSnapshot {
  spec: ArchitectureSpecV1;
  selectedNodeId: string | null;
  selectedProfileId: string;
  selectedEnvironmentId: string;
  selectedNode?: ArchitectureNode;
  selectedProfile?: ArchitectureProfile;
  selectedEnvironment?: ArchitectureEnvironment;
}
