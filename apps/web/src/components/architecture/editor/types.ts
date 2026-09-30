import type { ReactNode } from "react";
import type {
  ArchitectureEnvironment,
  ArchitectureNode,
  ArchitectureProfile,
  ArchitectureSpecV1,
  ArchitectureValidationIssue,
} from "@myskills-app/core";
import type { ArchitectureDraftChange } from "./architecture-draft-changes.js";

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
  /**
   * Renders the revision message field in the toolbar. The caller owns the
   * value; the editor clears it after a save or an accepted discard.
   */
  onRevisionMessageChange?: (message: string) => void;
  /** Title block shown beside the toolbar actions. */
  heading?: ReactNode;
  /** Caller-owned content for the Preview tab (API draft preview). */
  previewPanel?: ReactNode;
  /** Caller-owned content for the Advanced tab. */
  advancedPanel?: ReactNode;
  /** Team members can inspect a draft without being offered write controls. */
  readOnly?: boolean;
  className?: string;
  /**
   * Node to select in the Design outline and inspector on mount, and again
   * whenever this value changes to a different node that exists in the
   * current draft (its branch is expanded and scrolled into view). Unknown
   * ids are ignored. Applying it never calls `onSelectedNodeChange`.
   */
  initialSelectedNodeId?: string | null;
  /**
   * Called only when the user changes the selected node: outline or canvas
   * selection, adding or removing a node, or discarding the draft. The id can
   * belong to a node that exists only in this draft.
   */
  onSelectedNodeChange?: (nodeId: string | null) => void;
  /**
   * Shared profile context for the Profiles & environments tab. Adopted on
   * mount and whenever it changes to a profile that exists in the draft;
   * otherwise the editor keeps its own default (the first profile).
   */
  selectedProfileId?: string;
  /** Shared environment context; same rules as `selectedProfileId`. */
  selectedEnvironmentId?: string;
  /**
   * Called only when the user picks another active profile in the editor.
   * The id can belong to a profile that exists only in this draft.
   */
  onProfileChange?: (profileId: string) => void;
  /** Called only when the user picks another active environment in the editor. */
  onEnvironmentChange?: (environmentId: string) => void;
  /**
   * Short name of the revision this draft started from, such as
   * "Revision 2". Shown with the draft changes; omit it for an unnamed base.
   */
  baselineLabel?: string;
}

export interface ArchitectureDraftChangesProps {
  /** Named changes, usually from `describeArchitectureDraftChanges`. */
  changes: readonly ArchitectureDraftChange[];
  /** Short name of the baseline revision, such as "Revision 2". */
  baselineLabel?: string;
  /** While collapsed, show the change for this node first (the selected node). */
  focusNodeId?: string | null;
  /** Maximum changes rendered when expanded; the remainder is counted. */
  limit?: number;
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
