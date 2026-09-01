import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type FormEvent,
} from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Edge,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eye,
  GitBranch,
  GripVertical,
  Layers3,
  Minus,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  SquareArrowOutUpRight,
  Trash2,
  Workflow,
} from "lucide-react";
import {
  validateArchitectureSpec,
  resolveArchitectureProfileBinding,
  type ArchitectureEnvironmentKind,
  type ArchitectureNode,
  type ArchitectureProfileBinding,
  type ArchitectureProfileBindingResolution,
  type ArchitectureSpecV1,
  type ArchitectureValidationIssue,
} from "@myskills-app/core";
import {
  addArchitectureEnvironment,
  addArchitectureNode,
  addArchitectureProfile,
  addArchitectureSkillRelease,
  architectureSpecKey,
  cloneArchitectureSpec,
  createArchitectureTree,
  descendantsOf,
  environmentParentOptions,
  flattenArchitectureTree,
  moveArchitectureNode,
  moveTargetsForNode,
  parentNodeId,
  profileBinding,
  removeArchitectureEnvironment,
  removeArchitectureNode,
  removeArchitectureProfile,
  updateArchitectureEnvironment,
  updateArchitectureName,
  updateArchitectureNodeLabel,
  updateArchitectureProfileBinding,
  updateArchitectureProfileName,
} from "./draft.js";
import {
  layoutArchitectureGraph,
  projectArchitectureToFlow,
  type ArchitectureFlowNode,
} from "./layout.js";
import type {
  ArchitectureEditorPreviewRequest,
  ArchitectureEditorProps,
  ArchitectureRegistryReleaseOption,
  ArchitectureRegistrySkillOption,
  ArchitectureEditorSaveRequest,
  ArchitectureEditorStatus,
  ArchitectureTreeNode,
} from "./types.js";

export function ArchitectureEditor({
  initialSpec,
  expectedRevisionId = null,
  onPreview,
  onSave,
  onDraftChange,
  onSearchRegistrySkills,
  onLoadRegistryReleases,
  revisionMessage,
  readOnly = false,
  className,
}: ArchitectureEditorProps) {
  const initialSpecKey = useMemo(() => architectureSpecKey(initialSpec), [initialSpec]);
  const [draft, setDraft] = useState<ArchitectureSpecV1>(() => cloneArchitectureSpec(initialSpec));
  const [baselineKey, setBaselineKey] = useState(initialSpecKey);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => initialSpec.nodes[0]?.id ?? null);
  const [selectedProfileId, setSelectedProfileId] = useState(() => initialSpec.profiles[0]?.id ?? "");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(() => initialSpec.environments[0]?.id ?? "");
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => new Set(initialSpec.nodes.filter((node) => node.kind === "router").map((node) => node.id)));
  const [treeFocusId, setTreeFocusId] = useState<string | null>(() => initialSpec.nodes[0]?.id ?? null);
  const [newLeafSkillId, setNewLeafSkillId] = useState(() => initialSpec.skills[0]?.id ?? "");
  const [registryQuery, setRegistryQuery] = useState("");
  const [registrySkills, setRegistrySkills] = useState<ArchitectureRegistrySkillOption[]>([]);
  const [registrySkillSlug, setRegistrySkillSlug] = useState("");
  const [registryReleases, setRegistryReleases] = useState<ArchitectureRegistryReleaseOption[]>([]);
  const [registryReleaseId, setRegistryReleaseId] = useState("");
  const [registryParentId, setRegistryParentId] = useState("");
  const [registryState, setRegistryState] = useState<"idle" | "searching" | "loading-releases" | "ready" | "error">("idle");
  const [registryMessage, setRegistryMessage] = useState<string | null>(null);
  const [canvasNodes, setCanvasNodes] = useState<ArchitectureFlowNode[]>([]);
  const [operation, setOperation] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const treeItemRefs = useRef(new Map<string, HTMLDivElement>());
  const registryRequestEpoch = useRef(0);
  const latestInitialSpec = useRef(initialSpec);
  latestInitialSpec.current = initialSpec;

  // A new server revision is an intentional reset point. Object identity is
  // not used, so parent renders do not discard an in-progress draft.
  useEffect(() => {
    const nextSpec = latestInitialSpec.current;
    setDraft(cloneArchitectureSpec(nextSpec));
    setBaselineKey(initialSpecKey);
    setSelectedNodeId(nextSpec.nodes[0]?.id ?? null);
    setSelectedProfileId(nextSpec.profiles[0]?.id ?? "");
    setSelectedEnvironmentId(nextSpec.environments[0]?.id ?? "");
    setExpandedNodeIds(new Set(nextSpec.nodes.filter((node) => node.kind === "router").map((node) => node.id)));
    setTreeFocusId(nextSpec.nodes[0]?.id ?? null);
    setNewLeafSkillId(nextSpec.skills[0]?.id ?? "");
    setRegistrySkills([]);
    setRegistrySkillSlug("");
    setRegistryReleases([]);
    setRegistryReleaseId("");
    setRegistryParentId("");
    registryRequestEpoch.current += 1;
    setRegistryState("idle");
    setRegistryMessage(null);
    setOperation(null);
  }, [initialSpecKey]);

  const validation = useMemo(() => {
    try {
      return validateArchitectureSpec(draft);
    } catch (error) {
      return {
        valid: false as const,
        errors: [{
          code: "ARCHITECTURE_INVALID_OBJECT" as const,
          message: error instanceof Error ? error.message : "The draft could not be validated.",
          path: "spec",
        }],
      };
    }
  }, [draft]);
  const issues = useMemo(() => validation.valid ? [] : validation.errors, [validation]);
  const dirty = architectureSpecKey(draft) !== baselineKey;
  const editorStatus = useMemo<ArchitectureEditorStatus>(() => ({
    dirty,
    valid: issues.length === 0,
    validationIssues: issues,
  }), [dirty, issues]);

  useEffect(() => {
    onDraftChange?.(cloneArchitectureSpec(draft), editorStatus);
  }, [draft, editorStatus, onDraftChange]);

  const tree = useMemo(() => createArchitectureTree(draft), [draft]);
  const expanded = expandedNodeIds;
  const visibleTree = useMemo(() => flattenArchitectureTree(tree, expanded), [expanded, tree]);
  const selectedNode = useMemo(() => draft.nodes.find((node) => node.id === selectedNodeId), [draft.nodes, selectedNodeId]);
  const selectedProfile = useMemo(() => draft.profiles.find((profile) => profile.id === selectedProfileId), [draft.profiles, selectedProfileId]);
  const selectedEnvironment = useMemo(() => draft.environments.find((environment) => environment.id === selectedEnvironmentId), [draft.environments, selectedEnvironmentId]);
  const layout = useMemo(() => layoutArchitectureGraph(draft), [draft]);
  const flowProjection = useMemo(
    () => projectArchitectureToFlow(draft, selectedNodeId, layout),
    [draft, layout, selectedNodeId],
  );
  const flowKey = useMemo(() => architectureSpecKey(draft), [draft]);

  // Keep dragged positions across semantic edits where a node still exists.
  // This state is intentionally not part of draft or any callback payload.
  useEffect(() => {
    setCanvasNodes((current) => {
      const positions = new Map(current.map((node) => [node.id, node.position]));
      return flowProjection.nodes.map((node) => ({
        ...node,
        position: positions.get(node.id) ?? node.position,
      }));
    });
  }, [flowKey, flowProjection.nodes]);

  useEffect(() => {
    if (selectedNodeId && draft.nodes.some((node) => node.id === selectedNodeId)) return;
    setSelectedNodeId(draft.nodes[0]?.id ?? null);
  }, [draft.nodes, selectedNodeId]);

  useEffect(() => {
    if (selectedProfileId && draft.profiles.some((profile) => profile.id === selectedProfileId)) return;
    setSelectedProfileId(draft.profiles[0]?.id ?? "");
  }, [draft.profiles, selectedProfileId]);

  useEffect(() => {
    if (selectedEnvironmentId && draft.environments.some((environment) => environment.id === selectedEnvironmentId)) return;
    setSelectedEnvironmentId(draft.environments[0]?.id ?? "");
  }, [draft.environments, selectedEnvironmentId]);

  const commitDraft = useCallback((mutator: (current: ArchitectureSpecV1) => ArchitectureSpecV1) => {
    if (readOnly) return;
    setOperation(null);
    setDraft((current) => {
      return mutator(current);
    });
  }, [readOnly]);

  const selectNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setTreeFocusId(nodeId);
  }, []);

  const handleNodesChange = useCallback((changes: NodeChange<ArchitectureFlowNode>[]) => {
    setCanvasNodes((current) => applyNodeChanges(changes, current) as ArchitectureFlowNode[]);
  }, []);

  const handleFlowNodeClick = useCallback((_event: ReactMouseEvent, node: ArchitectureFlowNode) => {
    selectNode(node.id);
  }, [selectNode]);

  const handleAddNode = useCallback((kind: "router" | "leaf") => {
    const selected = selectedNodeId ? draft.nodes.find((node) => node.id === selectedNodeId) : undefined;
    const selectedParent = selected?.kind === "router" ? selected.id : undefined;
    const defaultParent = draft.pattern.id === "flat"
      ? null
      : selectedParent ?? draft.nodes.find((node) => node.kind === "router" && node.id === draft.entryNodeIds[0])?.id ?? null;
    const next = addArchitectureNode(draft, kind, defaultParent, kind === "leaf" ? newLeafSkillId : undefined);
    const added = next.nodes[next.nodes.length - 1];
    commitDraft(() => next);
    if (added) {
      selectNode(added.id);
      if (added.kind === "router") setExpandedNodeIds((current) => new Set(current).add(added.id));
    }
  }, [commitDraft, draft, newLeafSkillId, selectNode, selectedNodeId]);

  const selectedRegistryRelease = useMemo(
    () => registryReleases.find((release) => release.id === registryReleaseId),
    [registryReleaseId, registryReleases],
  );
  const registryParentOptions = useMemo(
    () => draft.nodes.filter((node): node is Extract<ArchitectureNode, { kind: "router" }> => node.kind === "router"),
    [draft.nodes],
  );

  const handleRegistrySearch = useCallback(async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!onSearchRegistrySkills || !onLoadRegistryReleases) return;
    const requestEpoch = registryRequestEpoch.current + 1;
    registryRequestEpoch.current = requestEpoch;
    if (!registryQuery.trim()) {
      setRegistryState("error");
      setRegistryMessage("Enter a skill name or slug to search the authorized registry.");
      return;
    }
    setRegistryState("searching");
    setRegistryMessage(null);
    setRegistrySkills([]);
    setRegistrySkillSlug("");
    setRegistryReleases([]);
    setRegistryReleaseId("");
    setRegistryParentId("");
    try {
      const results = await onSearchRegistrySkills(registryQuery.trim());
      if (requestEpoch !== registryRequestEpoch.current) return;
      setRegistrySkills(results);
      setRegistryState(results.length > 0 ? "ready" : "idle");
      if (results.length === 0) setRegistryMessage("No authorized registry skills matched that search.");
    } catch {
      if (requestEpoch !== registryRequestEpoch.current) return;
      setRegistryState("error");
      setRegistryMessage("The authorized registry search is not available right now.");
    }
  }, [onLoadRegistryReleases, onSearchRegistrySkills, registryQuery]);

  const handleRegistrySkillChange = useCallback(async (slug: string) => {
    setRegistrySkillSlug(slug);
    setRegistryReleases([]);
    setRegistryReleaseId("");
    setRegistryParentId("");
    setRegistryMessage(null);
    const requestEpoch = registryRequestEpoch.current + 1;
    registryRequestEpoch.current = requestEpoch;
    const skill = registrySkills.find((candidate) => candidate.slug === slug);
    if (!skill || !onLoadRegistryReleases) return;
    setRegistryState("loading-releases");
    try {
      const releases = await onLoadRegistryReleases(skill);
      if (requestEpoch !== registryRequestEpoch.current) return;
      setRegistryReleases(releases);
      setRegistryState(releases.length > 0 ? "ready" : "idle");
      if (releases.length === 0) setRegistryMessage("No approved exact releases are available for this skill.");
    } catch {
      if (requestEpoch !== registryRequestEpoch.current) return;
      setRegistryState("error");
      setRegistryMessage("The selected registry skill releases are not available right now.");
    }
  }, [onLoadRegistryReleases, registrySkills]);

  const handleAddRegistryRelease = useCallback(() => {
    if (!selectedRegistryRelease) return;
    const parentId = draft.pattern.id === "flat" ? null : registryParentId || null;
    try {
      const next = addArchitectureSkillRelease(draft, selectedRegistryRelease, parentId);
      const added = next.nodes[next.nodes.length - 1];
      commitDraft(() => next);
      if (added) selectNode(added.id);
      setRegistryMessage(null);
      setOperation({ kind: "success", message: `${selectedRegistryRelease.slug}@${selectedRegistryRelease.version} added as an exact release draft.` });
    } catch (error) {
      setRegistryState("error");
      setRegistryMessage(error instanceof Error ? error.message : "This release cannot be added to the draft.");
    }
  }, [commitDraft, draft, registryParentId, selectNode, selectedRegistryRelease]);

  const handleRemoveNode = useCallback(() => {
    if (!selectedNodeId) return;
    const removed = new Set([selectedNodeId, ...descendantsOf(draft, selectedNodeId)]);
    const selected = draft.nodes.find((node) => node.id === selectedNodeId);
    const descendantCount = removed.size - 1;
    if (!confirmEditorAction(`Remove ${selected?.label ?? "this node"}${descendantCount > 0 ? ` and ${descendantCount} descendant${descendantCount === 1 ? "" : "s"}` : ""}? This change stays in the draft until you save.`)) return;
    const next = removeArchitectureNode(draft, selectedNodeId);
    commitDraft(() => next);
    const fallback = next.nodes.find((node) => !removed.has(node.id)) ?? next.nodes[0];
    if (fallback) selectNode(fallback.id);
    else {
      setSelectedNodeId(null);
      setTreeFocusId(null);
    }
    setExpandedNodeIds((current) => {
      const nextExpanded = new Set(current);
      for (const id of removed) nextExpanded.delete(id);
      return nextExpanded;
    });
  }, [commitDraft, draft, selectedNodeId, selectNode]);

  const handleMoveNode = useCallback((parentId: string | null) => {
    if (!selectedNodeId) return;
    commitDraft((current) => moveArchitectureNode(current, selectedNodeId, parentId));
  }, [commitDraft, selectedNodeId]);

  const handlePreview = useCallback(async () => {
    if (!onPreview || !validation.valid || busy) return;
    const request: ArchitectureEditorPreviewRequest = {
      spec: cloneArchitectureSpec(draft),
      expectedRevisionId,
    };
    setBusy("preview");
    setOperation(null);
    try {
      await onPreview(request);
      setOperation({ kind: "success", message: "Preview request sent for this draft." });
    } catch (error) {
      setOperation({ kind: "error", message: error instanceof Error ? error.message : "Preview failed." });
    } finally {
      setBusy(null);
    }
  }, [busy, draft, expectedRevisionId, onPreview, validation.valid]);

  const handleSave = useCallback(async () => {
    if (!onSave || readOnly || !validation.valid || busy) return;
    const request: ArchitectureEditorSaveRequest = {
      spec: cloneArchitectureSpec(draft),
      expectedRevisionId,
      ...(revisionMessage?.trim() ? { message: revisionMessage.trim() } : {}),
    };
    setBusy("save");
    setOperation(null);
    try {
      await onSave(request);
      setBaselineKey(architectureSpecKey(draft));
      setOperation({ kind: "success", message: "Draft saved as an immutable revision." });
    } catch (error) {
      setOperation({ kind: "error", message: error instanceof Error ? error.message : "Save failed. Your draft is still available." });
    } finally {
      setBusy(null);
    }
  }, [busy, draft, expectedRevisionId, onSave, readOnly, revisionMessage, validation.valid]);

  const handleReset = useCallback(() => {
    if (readOnly || !dirty) return;
    if (!confirmEditorAction("Discard all unsaved architecture changes?")) return;
    setDraft(cloneArchitectureSpec(initialSpec));
    setBaselineKey(initialSpecKey);
    setSelectedNodeId(initialSpec.nodes[0]?.id ?? null);
    setOperation({ kind: "success", message: "Unsaved changes were discarded." });
  }, [dirty, initialSpec, initialSpecKey, readOnly]);

  const statusText = dirty ? "Unsaved changes" : "All changes saved";
  const OperationIcon = operation?.kind === "error" ? CircleAlert : Check;

  return (
    <section className={`architecture-editor ${className ?? ""}`.trim()} aria-label="Architecture editor" data-testid="architecture-editor">
      <header className="architecture-editor-header">
        <div className="architecture-editor-heading">
          <span className="architecture-editor-mark" aria-hidden="true"><Workflow size={18} /></span>
          <div>
            <p className="architecture-editor-eyebrow">Architecture workbench</p>
            <h2>Design the routing surface</h2>
            <p>Build the semantic outline first. The canvas is a navigable projection for orientation.</p>
          </div>
        </div>
        <div className="architecture-editor-header-actions">
          <span className={dirty ? "architecture-editor-save-state dirty" : "architecture-editor-save-state"} role="status" aria-live="polite">
            <span className="architecture-editor-status-dot" aria-hidden="true" /> {statusText}
          </span>
          {dirty && !readOnly && <button className="architecture-editor-button quiet" type="button" onClick={handleReset} disabled={busy !== null}><RotateCcw size={15} aria-hidden="true" /> Discard</button>}
          <button className="architecture-editor-button outline" type="button" onClick={() => void handlePreview()} disabled={!onPreview || !validation.valid || busy !== null}>
            <Eye size={15} aria-hidden="true" /> {busy === "preview" ? "Previewing…" : "Preview draft"}
          </button>
          {!readOnly && <button className="architecture-editor-button primary" type="button" onClick={() => void handleSave()} disabled={!onSave || !dirty || !validation.valid || busy !== null}>
            <Save size={15} aria-hidden="true" /> {busy === "save" ? "Saving…" : "Save revision"}
          </button>}
        </div>
      </header>

      <div className="architecture-editor-meta-grid">
        <label className="architecture-editor-field architecture-editor-title-field">
          <span>Architecture name</span>
          <input aria-label="Architecture name" disabled={readOnly} value={draft.name} onChange={(event) => commitDraft((current) => updateArchitectureName(current, event.target.value))} />
        </label>
        <label className="architecture-editor-field architecture-editor-description-field">
          <span>Description <small>(optional)</small></span>
          <input aria-label="Architecture description" disabled={readOnly} value={draft.description ?? ""} onChange={(event) => commitDraft((current) => updateArchitectureName(current, current.name, event.target.value))} />
        </label>
        <div className="architecture-editor-pattern-lock" aria-label={`Pattern ${draft.pattern.id} is immutable`}>
          <span>Pattern</span>
          <strong><GitBranch size={15} aria-hidden="true" /> {draft.pattern.id}</strong>
          <small>Immutable in this shell — derive a new pattern to change it.</small>
        </div>
      </div>

      {operation && <div className={`architecture-editor-operation ${operation.kind}`} role={operation.kind === "error" ? "alert" : "status"}><OperationIcon size={16} aria-hidden="true" /> {operation.message}</div>}

      <div className="architecture-editor-workbench">
        <aside className="architecture-editor-outline-pane" aria-label="Semantic architecture outline">
          <div className="architecture-editor-pane-heading">
            <div>
              <p className="architecture-editor-eyebrow">Canonical view</p>
              <h3>Architecture outline</h3>
            </div>
            <span className="architecture-editor-count">{draft.nodes.length} nodes</span>
          </div>
          <p className="architecture-editor-pane-copy">Use the tree and its controls to make semantic changes. Dragging in the canvas only moves its visual layout.</p>
          {!readOnly && <div className="architecture-editor-add-actions" aria-label="Add architecture node">
            <button type="button" className="architecture-editor-add-button" onClick={() => handleAddNode("router")} disabled={draft.pattern.id !== "multi-level-router"} title={draft.pattern.id === "multi-level-router" ? "Add a router" : "This pattern does not allow nested routers"}><Plus size={14} aria-hidden="true" /> Router</button>
            <button type="button" className="architecture-editor-add-button" onClick={() => handleAddNode("leaf")} disabled={draft.skills.length === 0}><Plus size={14} aria-hidden="true" /> Leaf</button>
            <label className="architecture-editor-add-skill"><span>Leaf source</span><select aria-label="Skill for new leaf" value={newLeafSkillId} onChange={(event) => setNewLeafSkillId(event.target.value)} disabled={draft.skills.length === 0}>{draft.skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.title ?? skill.slug}</option>)}</select></label>
          </div>}
          {!readOnly && onSearchRegistrySkills && onLoadRegistryReleases && <section className="architecture-editor-registry-picker" aria-labelledby="architecture-editor-registry-heading">
            <div className="architecture-editor-picker-heading">
              <div>
                <p className="architecture-editor-eyebrow">Authorized registry</p>
                <h4 id="architecture-editor-registry-heading">Add an exact release</h4>
              </div>
              <span className="architecture-editor-picker-badge">Immutable ref</span>
            </div>
            <p className="architecture-editor-picker-copy">Search API-authorized metadata, choose one exact version and digest, then place it in the semantic draft. The picker never accepts a hand-entered package reference.</p>
            <form className="architecture-editor-registry-search" onSubmit={(event) => void handleRegistrySearch(event)}>
              <label className="architecture-editor-field"><span>Search registry skills</span><input aria-label="Search registry skills" value={registryQuery} onChange={(event) => setRegistryQuery(event.target.value)} placeholder="release notes or slug" /></label>
              <button type="submit" className="architecture-editor-add-button" disabled={registryState === "searching" || registryState === "loading-releases"}><Plus size={14} aria-hidden="true" /> {registryState === "searching" ? "Searching…" : "Search"}</button>
            </form>
            {registrySkills.length > 0 && <label className="architecture-editor-field"><span>Registry skill</span><select aria-label="Registry skill" value={registrySkillSlug} onChange={(event) => void handleRegistrySkillChange(event.target.value)}><option value="">Choose a skill</option>{registrySkills.map((skill) => <option key={skill.slug} value={skill.slug}>{skill.title} · {skill.slug}</option>)}</select></label>}
            {registrySkillSlug && registryReleases.length > 0 && <label className="architecture-editor-field"><span>Exact release</span><select aria-label="Exact release" value={registryReleaseId} onChange={(event) => setRegistryReleaseId(event.target.value)}><option value="">Choose a version and digest</option>{registryReleases.map((release) => <option key={release.id} value={release.id}>{release.slug}@{release.version} · {release.digest}</option>)}</select></label>}
            {draft.pattern.id !== "flat" && <label className="architecture-editor-field"><span>Parent router <small>(required)</small></span><select aria-label="Release parent router" value={registryParentId} onChange={(event) => setRegistryParentId(event.target.value)} disabled={registryParentOptions.length === 0}><option value="">Choose a parent router</option>{registryParentOptions.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label>}
            {selectedRegistryRelease && <dl className="architecture-editor-release-facts" aria-label="Selected exact release details">
              <div><dt>Registry id</dt><dd>{selectedRegistryRelease.id}</dd></div>
              <div><dt>Slug</dt><dd>{selectedRegistryRelease.slug}</dd></div>
              <div><dt>Version</dt><dd>{selectedRegistryRelease.version}</dd></div>
              <div><dt>Digest</dt><dd>{selectedRegistryRelease.digest}</dd></div>
              <div><dt>Package visibility</dt><dd>{selectedRegistryRelease.packageVisibility}</dd></div>
            </dl>}
            <button type="button" className="architecture-editor-add-button" onClick={handleAddRegistryRelease} disabled={!selectedRegistryRelease || (draft.pattern.id !== "flat" && !registryParentId)}><Plus size={14} aria-hidden="true" /> Add selected exact release</button>
            {registryMessage && <div className="architecture-editor-picker-message" role={registryState === "error" ? "alert" : "status"}>{registryMessage}</div>}
          </section>}
          <ArchitectureOutline
            tree={tree}
            expanded={expanded}
            selectedNodeId={selectedNodeId}
            focusNodeId={treeFocusId}
            treeItemRefs={treeItemRefs}
            onSelect={selectNode}
            onSetFocus={setTreeFocusId}
            onToggle={(nodeId) => setExpandedNodeIds((current) => {
              const next = new Set(current);
              if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
              return next;
            })}
            onKeyboardNavigate={(nodeId) => {
              setTreeFocusId(nodeId);
              treeItemRefs.current.get(nodeId)?.focus();
            }}
          />
          {selectedNode && !readOnly && <NodeInspector
            spec={draft}
            node={selectedNode}
            onLabelChange={(label) => commitDraft((current) => updateArchitectureNodeLabel(current, selectedNode.id, label))}
            onMove={handleMoveNode}
            onRemove={handleRemoveNode}
          />}
        </aside>

        <section className="architecture-editor-canvas-pane" aria-label="Architecture canvas projection">
          <div className="architecture-editor-pane-heading canvas-heading">
            <div>
              <p className="architecture-editor-eyebrow">Projection</p>
              <h3>Topology canvas</h3>
            </div>
            <span className="architecture-editor-canvas-note"><GripVertical size={14} aria-hidden="true" /> Drag to arrange this view</span>
          </div>
          <div className="architecture-editor-canvas" data-testid="architecture-canvas">
            <ReactFlow<ArchitectureFlowNode, Edge>
              nodes={canvasNodes}
              edges={flowProjection.edges}
              nodeTypes={ARCHITECTURE_NODE_TYPES}
              onNodesChange={handleNodesChange}
              onNodeClick={handleFlowNodeClick}
              nodesConnectable={false}
              edgesReconnectable={false}
              nodesFocusable={false}
              elementsSelectable={false}
              nodesDraggable
              fitView
              fitViewOptions={{ padding: 0.18, minZoom: 0.38, maxZoom: 1.3 }}
              aria-label="Architecture topology canvas"
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#c6d5de" gap={24} size={1} />
              <Controls showInteractive={false} aria-label="Canvas zoom controls" />
              <MiniMap nodeColor={(node) => node.data.kind === "router" ? "#0e7490" : "#e2a34d"} nodeStrokeColor="#eff6f8" maskColor="rgba(12, 42, 57, 0.12)" aria-label="Topology minimap" />
              <Panel position="bottom-left" className="architecture-editor-canvas-panel">
                <SquareArrowOutUpRight size={13} aria-hidden="true" /> Visual layout is ephemeral
              </Panel>
            </ReactFlow>
          </div>
          <ValidationSummary issues={issues} />
        </section>
      </div>

      <ProfileEnvironmentPanel
        spec={draft}
        selectedProfileId={selectedProfileId}
        selectedEnvironmentId={selectedEnvironmentId}
        onProfileSelect={setSelectedProfileId}
        onEnvironmentSelect={setSelectedEnvironmentId}
        onAddProfile={() => {
          const next = addArchitectureProfile(draft);
          commitDraft(() => next);
          setSelectedProfileId(next.profiles[next.profiles.length - 1]?.id ?? "");
        }}
        onRemoveProfile={() => {
          if (!selectedProfileId) return;
          const profile = draft.profiles.find((candidate) => candidate.id === selectedProfileId);
          if (!confirmEditorAction(`Remove profile ${profile?.name ?? "this profile"}? Environments using it will be reassigned to another profile.`)) return;
          const next = removeArchitectureProfile(draft, selectedProfileId);
          commitDraft(() => next);
          setSelectedProfileId(next.profiles[0]?.id ?? "");
        }}
        onAddEnvironment={(kind, parentId) => {
          const next = addArchitectureEnvironment(draft, selectedProfileId, kind, parentId);
          commitDraft(() => next);
          setSelectedEnvironmentId(next.environments[next.environments.length - 1]?.id ?? "");
        }}
        onRemoveEnvironment={() => {
          if (!selectedEnvironmentId) return;
          const environment = draft.environments.find((candidate) => candidate.id === selectedEnvironmentId);
          if (!confirmEditorAction(`Remove environment ${environment?.name ?? "this environment"}? Child environments will be moved to its parent and scoped bindings will be updated.`)) return;
          const next = removeArchitectureEnvironment(draft, selectedEnvironmentId);
          commitDraft(() => next);
          setSelectedEnvironmentId(next.environments[0]?.id ?? "");
        }}
        onProfileNameChange={(name) => selectedProfileId && commitDraft((current) => updateArchitectureProfileName(current, selectedProfileId, name))}
        onEnvironmentChange={(update) => selectedEnvironmentId && commitDraft((current) => updateArchitectureEnvironment(current, selectedEnvironmentId, update))}
        onBindingChange={(nodeId, update) => selectedProfileId && commitDraft((current) => updateArchitectureProfileBinding(current, selectedProfileId, nodeId, update))}
        readOnly={readOnly}
      />
    </section>
  );
}

function confirmEditorAction(message: string): boolean {
  if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
  try {
    return window.confirm(message);
  } catch {
    // Some non-browser DOM shims expose confirm but do not implement it. Keep
    // editor callbacks usable in those environments; real browsers still
    // receive the confirmation prompt.
    return true;
  }
}

function resolveBindingForEditor(
  spec: ArchitectureSpecV1,
  profileId: string,
  environmentId: string,
  nodeId: string,
): ArchitectureProfileBindingResolution | null {
  try {
    return resolveArchitectureProfileBinding(spec, { profileId, environmentId, nodeId });
  } catch {
    // While a draft is being edited it can be temporarily invalid (for
    // example, when a parent is removed). Validation below remains the source
    // of truth until the overlay resolver can safely run again.
    return null;
  }
}

function bindingResolutionLabel(
  resolution: ArchitectureProfileBindingResolution,
  spec: ArchitectureSpecV1,
): string {
  switch (resolution.provenance.reason) {
    case "explicit-deny": {
      const source = resolution.sourceEnvironmentId
        ? spec.environments.find((environment) => environment.id === resolution.sourceEnvironmentId)?.name
        : undefined;
      return source ? `Denied by ${source}` : "Explicitly denied";
    }
    case "selected-environment":
      return "Selected environment rule";
    case "ancestor-environment": {
      const source = resolution.sourceEnvironmentId
        ? spec.environments.find((environment) => environment.id === resolution.sourceEnvironmentId)?.name
        : undefined;
      return source ? `Inherited from ${source}` : "Inherited from a parent environment";
    }
    case "wildcard":
      return "Applies to all environments";
    case "missing":
      return "No matching rule · disabled";
  }
}

const ArchitectureFlowNodeView = memo(function ArchitectureFlowNodeView({ data }: NodeProps<ArchitectureFlowNode>) {
  const router = data.kind === "router";
  const NodeIcon = router ? Workflow : Layers3;
  return (
    <div className={router ? "architecture-flow-node router" : "architecture-flow-node leaf"} data-selected={data.selected || undefined} role="img" aria-label={`${router ? "Router" : "Leaf"}: ${data.label}`}>
      <Handle type="target" position={Position.Left} className="architecture-flow-handle" isConnectable={false} />
      <div className="architecture-flow-node-accent" aria-hidden="true"><NodeIcon size={15} /></div>
      <div className="architecture-flow-node-copy">
        <strong>{data.label}</strong>
        <span>{router ? "router" : data.skillRefId ?? "unassigned leaf"}</span>
      </div>
      {router && <Handle type="source" position={Position.Right} className="architecture-flow-handle" isConnectable={false} />}
    </div>
  );
});

const ARCHITECTURE_NODE_TYPES: NodeTypes = {
  architecture: ArchitectureFlowNodeView,
};

function ArchitectureOutline({
  tree,
  expanded,
  selectedNodeId,
  focusNodeId,
  treeItemRefs,
  onSelect,
  onSetFocus,
  onToggle,
  onKeyboardNavigate,
}: {
  tree: ArchitectureTreeNode[];
  expanded: ReadonlySet<string>;
  selectedNodeId: string | null;
  focusNodeId: string | null;
  treeItemRefs: MutableRefObject<Map<string, HTMLDivElement>>;
  onSelect: (nodeId: string) => void;
  onSetFocus: (nodeId: string) => void;
  onToggle: (nodeId: string) => void;
  onKeyboardNavigate: (nodeId: string) => void;
}) {
  const visibleItems = useMemo(() => flattenArchitectureTree(tree, expanded), [expanded, tree]);
  const parentById = useMemo(() => {
    const parents = new Map<string, string>();
    const walk = (items: readonly ArchitectureTreeNode[], parentId?: string) => {
      for (const item of items) {
        if (parentId) parents.set(item.node.id, parentId);
        walk(item.children, item.node.id);
      }
    };
    walk(tree);
    return parents;
  }, [tree]);

  const navigate = useCallback((nodeId: string | undefined) => {
    if (!nodeId) return;
    onSetFocus(nodeId);
    onKeyboardNavigate(nodeId);
  }, [onKeyboardNavigate, onSetFocus]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>, item: ArchitectureTreeNode) => {
    const index = visibleItems.findIndex((candidate) => candidate.node.id === item.node.id);
    const isExpanded = expanded.has(item.node.id);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      navigate(visibleItems[index + 1]?.node.id);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      navigate(visibleItems[index - 1]?.node.id);
    } else if (event.key === "Home") {
      event.preventDefault();
      navigate(visibleItems[0]?.node.id);
    } else if (event.key === "End") {
      event.preventDefault();
      navigate(visibleItems[visibleItems.length - 1]?.node.id);
    } else if (event.key === "ArrowRight" && item.node.kind === "router" && item.children.length > 0) {
      event.preventDefault();
      if (!isExpanded) onToggle(item.node.id);
      else navigate(item.children[0]?.node.id);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (item.node.kind === "router" && isExpanded) onToggle(item.node.id);
      else navigate(parentById.get(item.node.id));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(item.node.id);
    }
  }, [expanded, navigate, onSelect, onToggle, parentById, visibleItems]);

  return (
    <div className="architecture-editor-tree-wrap">
      <div className="architecture-editor-tree-help" id="architecture-editor-tree-help">Arrow keys navigate. Right and left expand or collapse routers. Enter selects a node.</div>
      <div className="architecture-editor-tree" role="tree" aria-label="Semantic architecture nodes" aria-describedby="architecture-editor-tree-help">
        {tree.length === 0 ? <div className="architecture-editor-empty-tree">No nodes yet. Add a router or leaf to begin.</div> : tree.map((item) => (
          <ArchitectureTreeItem
            key={item.node.id}
            item={item}
            expanded={expanded}
            selectedNodeId={selectedNodeId}
            focusNodeId={focusNodeId}
            treeItemRefs={treeItemRefs}
            onSelect={onSelect}
            onSetFocus={onSetFocus}
            onToggle={onToggle}
            onKeyDown={handleKeyDown}
          />
        ))}
      </div>
    </div>
  );
}

function ArchitectureTreeItem({
  item,
  expanded,
  selectedNodeId,
  focusNodeId,
  treeItemRefs,
  onSelect,
  onSetFocus,
  onToggle,
  onKeyDown,
}: {
  item: ArchitectureTreeNode;
  expanded: ReadonlySet<string>;
  selectedNodeId: string | null;
  focusNodeId: string | null;
  treeItemRefs: MutableRefObject<Map<string, HTMLDivElement>>;
  onSelect: (nodeId: string) => void;
  onSetFocus: (nodeId: string) => void;
  onToggle: (nodeId: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>, item: ArchitectureTreeNode) => void;
}) {
  const hasChildren = item.children.length > 0;
  const isExpanded = expanded.has(item.node.id);
  const selected = selectedNodeId === item.node.id;
  const focusable = focusNodeId === null ? item.position === 1 : focusNodeId === item.node.id;
  return (
    <div className="architecture-editor-tree-item">
      <div
        id={`architecture-treeitem-${item.node.id}`}
        ref={(element) => {
          if (element) treeItemRefs.current.set(item.node.id, element); else treeItemRefs.current.delete(item.node.id);
        }}
        className={selected ? "architecture-editor-tree-row selected" : "architecture-editor-tree-row"}
        role="treeitem"
        tabIndex={focusable ? 0 : -1}
        aria-level={item.depth}
        aria-posinset={item.position}
        aria-setsize={item.siblingCount}
        aria-selected={selected}
        aria-expanded={item.node.kind === "router" ? isExpanded : undefined}
        onFocus={() => onSetFocus(item.node.id)}
        onClick={() => onSelect(item.node.id)}
        onKeyDown={(event) => onKeyDown(event, item)}
      >
        <span className="architecture-editor-tree-indent" aria-hidden="true" />
        {item.node.kind === "router" ? <button type="button" className="architecture-editor-tree-toggle" aria-label={`${isExpanded ? "Collapse" : "Expand"} ${item.node.label}`} onClick={(event) => { event.stopPropagation(); onToggle(item.node.id); }} disabled={!hasChildren}>{isExpanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</button> : <span className="architecture-editor-tree-spacer" aria-hidden="true" />}
        <span className={item.node.kind === "router" ? "architecture-editor-tree-icon router" : "architecture-editor-tree-icon leaf"} aria-hidden="true">{item.node.kind === "router" ? <Workflow size={14} /> : <Layers3 size={14} />}</span>
        <span className="architecture-editor-tree-label">
          <strong>{item.node.label}</strong>
          <small>{item.node.kind}{item.node.kind === "leaf" && "skillRefId" in item.node ? ` · ${item.node.skillRefId}` : ""}</small>
        </span>
        {selected && <span className="architecture-editor-tree-selected" aria-label="Selected"><Check size={13} aria-hidden="true" /></span>}
      </div>
      {isExpanded && hasChildren && <div role="group" aria-label={`Children of ${item.node.label}`}>{item.children.map((child) => <ArchitectureTreeItem key={child.node.id} item={child} expanded={expanded} selectedNodeId={selectedNodeId} focusNodeId={focusNodeId} treeItemRefs={treeItemRefs} onSelect={onSelect} onSetFocus={onSetFocus} onToggle={onToggle} onKeyDown={onKeyDown} />)}</div>}
    </div>
  );
}

function NodeInspector({
  spec,
  node,
  onLabelChange,
  onMove,
  onRemove,
}: {
  spec: ArchitectureSpecV1;
  node: ArchitectureNode;
  onLabelChange: (label: string) => void;
  onMove: (parentId: string | null) => void;
  onRemove: () => void;
}) {
  const targets = moveTargetsForNode(spec, node.id);
  const currentParent = parentNodeId(spec, node.id);
  const descendantCount = descendantsOf(spec, node.id).size;
  return (
    <section className="architecture-editor-inspector" aria-labelledby="architecture-editor-inspector-heading">
      <div className="architecture-editor-inspector-heading"><Settings2 size={15} aria-hidden="true" /><h4 id="architecture-editor-inspector-heading">Selected node</h4><span>{node.kind}</span></div>
      <label className="architecture-editor-field">
        <span>Label</span>
        <input aria-label="Selected node label" value={node.label} onChange={(event) => onLabelChange(event.target.value)} />
      </label>
      <label className="architecture-editor-field">
        <span>Move selected under</span>
        <select aria-label="Move selected node" value={currentParent ?? ""} onChange={(event) => onMove(event.target.value || null)}>
          {targets.map((target) => <option key={target.id ?? "top-level"} value={target.id ?? ""} disabled={target.disabled}>{target.label}</option>)}
        </select>
      </label>
      <button type="button" className="architecture-editor-danger-button" onClick={onRemove}><Trash2 size={14} aria-hidden="true" /> Remove {node.kind}{descendantCount > 0 ? ` and ${descendantCount} descendant${descendantCount === 1 ? "" : "s"}` : ""}</button>
    </section>
  );
}

function ValidationSummary({ issues }: { issues: ArchitectureValidationIssue[] }) {
  return (
    <section className={issues.length > 0 ? "architecture-editor-validation invalid" : "architecture-editor-validation valid"} aria-labelledby="architecture-editor-validation-heading" aria-live="polite">
      <div className="architecture-editor-validation-heading"><span aria-hidden="true">{issues.length > 0 ? <CircleAlert size={15} /> : <Check size={15} />}</span><h4 id="architecture-editor-validation-heading">{issues.length > 0 ? `${issues.length} validation issue${issues.length === 1 ? "" : "s"}` : "Draft passes schema validation"}</h4></div>
      {issues.length > 0 && <ul>{issues.slice(0, 8).map((issue, index) => <li key={`${issue.code}-${issue.path ?? "root"}-${index}`}><code>{issue.path ?? "spec"}</code> {issue.message}</li>)}</ul>}
    </section>
  );
}

function ProfileEnvironmentPanel({
  spec,
  selectedProfileId,
  selectedEnvironmentId,
  onProfileSelect,
  onEnvironmentSelect,
  onAddProfile,
  onRemoveProfile,
  onAddEnvironment,
  onRemoveEnvironment,
  onProfileNameChange,
  onEnvironmentChange,
  onBindingChange,
  readOnly,
}: {
  spec: ArchitectureSpecV1;
  selectedProfileId: string;
  selectedEnvironmentId: string;
  onProfileSelect: (id: string) => void;
  onEnvironmentSelect: (id: string) => void;
  onAddProfile: () => void;
  onRemoveProfile: () => void;
  onAddEnvironment: (kind: ArchitectureEnvironmentKind, parentId: string | null) => void;
  onRemoveEnvironment: () => void;
  onProfileNameChange: (name: string) => void;
  onEnvironmentChange: (update: { name?: string; kind?: ArchitectureEnvironmentKind; profileId?: string; parentId?: string | null }) => void;
  onBindingChange: (nodeId: string, update: Partial<Pick<ArchitectureProfileBinding, "enabled" | "runtimeExposure" | "environmentIds">>) => void;
  readOnly: boolean;
}) {
  const profile = spec.profiles.find((candidate) => candidate.id === selectedProfileId);
  const environment = spec.environments.find((candidate) => candidate.id === selectedEnvironmentId);
  const allEnvironmentIds = spec.environments.map((candidate) => candidate.id);
  const [newEnvironmentKind, setNewEnvironmentKind] = useState<ArchitectureEnvironmentKind>(environment?.kind ?? "personal");
  const [newEnvironmentParentId, setNewEnvironmentParentId] = useState<string | null>(null);
  useEffect(() => {
    setNewEnvironmentKind(environment?.kind ?? "personal");
    setNewEnvironmentParentId(null);
  }, [environment?.id]);
  const environmentParents = useMemo(
    () => environment ? environmentParentOptions(spec, environment.id) : [],
    [environment, spec],
  );
  return (
    <section className="architecture-editor-context-panel" aria-labelledby="architecture-editor-context-heading">
      <div className="architecture-editor-pane-heading">
        <div><p className="architecture-editor-eyebrow">Runtime context</p><h3 id="architecture-editor-context-heading">Profiles and environments</h3></div>
        <span className="architecture-editor-pane-copy compact">Bindings control exposure per environment. They do not change the package catalogue.</span>
      </div>
      <div className="architecture-editor-context-grid">
        <div className="architecture-editor-context-card">
          <div className="architecture-editor-context-card-heading"><div><span className="architecture-editor-label">Profiles</span><strong>{spec.profiles.length} declared</strong></div><button type="button" className="architecture-editor-icon-button" aria-label="Add profile" onClick={onAddProfile} disabled={readOnly}><Plus size={15} aria-hidden="true" /></button></div>
          <label className="architecture-editor-field"><span>Active profile</span><select aria-label="Active architecture profile" disabled={!profile} value={selectedProfileId} onChange={(event) => onProfileSelect(event.target.value)}>{spec.profiles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
          {profile && <>
            <label className="architecture-editor-field"><span>Profile name</span><input aria-label="Profile name" disabled={readOnly} value={profile.name} onChange={(event) => onProfileNameChange(event.target.value)} /></label>
            <div className="architecture-editor-context-subline"><span>Subject</span><code>{profile.subject.type}:{profile.subject.id}</code></div>
            <button type="button" className="architecture-editor-danger-button subtle" onClick={onRemoveProfile} disabled={readOnly || spec.profiles.length <= 1}><Minus size={14} aria-hidden="true" /> Remove profile</button>
          </>}
        </div>

        <div className="architecture-editor-context-card">
          <div className="architecture-editor-context-card-heading"><div><span className="architecture-editor-label">Logical environments</span><strong>{spec.environments.length} connected contexts</strong></div></div>
          <label className="architecture-editor-field"><span>Active environment</span><select aria-label="Active architecture environment" disabled={!environment} value={selectedEnvironmentId} onChange={(event) => onEnvironmentSelect(event.target.value)}>{spec.environments.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.kind}</option>)}</select></label>
          {environment && <>
            <label className="architecture-editor-field"><span>Environment name</span><input aria-label="Environment name" disabled={readOnly} value={environment.name} onChange={(event) => onEnvironmentChange({ name: event.target.value })} /></label>
            <label className="architecture-editor-field"><span>Environment kind</span><select aria-label="Environment kind" disabled={readOnly} value={environment.kind} onChange={(event) => onEnvironmentChange({ kind: event.target.value as ArchitectureEnvironmentKind })}><option value="personal">Personal</option><option value="work">Work</option><option value="team">Team</option></select></label>
            <label className="architecture-editor-field"><span>Uses profile</span><select aria-label="Environment profile" disabled={readOnly} value={environment.profileId} onChange={(event) => onEnvironmentChange({ profileId: event.target.value })}>{spec.profiles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
            <label className="architecture-editor-field"><span>Parent environment <small>(optional)</small></span><select aria-label="Environment parent" disabled={readOnly} value={environment.parentId ?? ""} onChange={(event) => onEnvironmentChange({ parentId: event.target.value || null })}>{environmentParents.map((option) => <option key={option.id ?? "no-parent"} value={option.id ?? ""}>{option.label}</option>)}</select></label>
            <button type="button" className="architecture-editor-danger-button subtle" onClick={onRemoveEnvironment} disabled={readOnly || spec.environments.length <= 1}><Minus size={14} aria-hidden="true" /> Remove environment</button>
          </>}
          {!readOnly && <div className="architecture-editor-environment-create">
            <div className="architecture-editor-context-card-heading"><div><span className="architecture-editor-label">Add context</span><strong>Declare a new environment</strong></div></div>
            <label className="architecture-editor-field"><span>New environment kind</span><select aria-label="New environment kind" value={newEnvironmentKind} onChange={(event) => setNewEnvironmentKind(event.target.value as ArchitectureEnvironmentKind)}><option value="personal">Personal</option><option value="work">Work</option><option value="team">Team</option></select></label>
            <label className="architecture-editor-field"><span>New environment parent <small>(optional)</small></span><select aria-label="New environment parent" value={newEnvironmentParentId ?? ""} onChange={(event) => setNewEnvironmentParentId(event.target.value || null)}><option value="">No parent (top level)</option>{spec.environments.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.kind}</option>)}</select></label>
            <button type="button" className="architecture-editor-add-button" aria-label="Add environment" onClick={() => onAddEnvironment(newEnvironmentKind, newEnvironmentParentId)} disabled={spec.profiles.length === 0}><Plus size={14} aria-hidden="true" /> Add environment</button>
          </div>}
        </div>
      </div>

      {profile && environment && <div className="architecture-editor-binding-card">
        <div className="architecture-editor-context-card-heading"><div><span className="architecture-editor-label">Exposure bindings</span><strong>{profile.name}</strong></div><span className="architecture-editor-binding-note">Default: disabled</span></div>
        <div className="architecture-editor-binding-list">
          {spec.nodes.map((node) => {
            const binding = profileBinding(spec, profile.id, node.id);
            const scoped = binding.environmentIds !== undefined;
            const resolution = resolveBindingForEditor(spec, profile.id, environment.id, node.id);
            return <div className="architecture-editor-binding-row" key={node.id}>
              <label className="architecture-editor-binding-enable"><input type="checkbox" aria-label={`Enable ${node.label} in ${profile.name}`} disabled={readOnly} checked={binding.enabled} onChange={(event) => onBindingChange(node.id, { enabled: event.target.checked })} /><span><strong>{node.label}</strong><small>{node.kind}</small>{resolution && <small className={resolution.decision === "disabled" ? "architecture-editor-binding-explanation denied" : "architecture-editor-binding-explanation"}>{bindingResolutionLabel(resolution, spec)}</small>}</span></label>
              <label className="architecture-editor-binding-exposure"><span>Exposure</span><select aria-label={`${node.label} runtime exposure`} disabled={readOnly || !binding.enabled} value={binding.enabled ? binding.runtimeExposure : "disabled"} onChange={(event) => onBindingChange(node.id, { enabled: event.target.value !== "disabled", runtimeExposure: event.target.value as "disabled" | "router" | "leaf" })}><option value="disabled">Disabled</option><option value="router" disabled={node.kind !== "router"}>Router</option><option value="leaf" disabled={node.kind !== "leaf"}>Leaf</option></select></label>
              <fieldset className="architecture-editor-binding-scope"><legend>Environment scope</legend><label><input type="checkbox" aria-label={`Use all environments for ${node.label}`} disabled={readOnly || !binding.enabled} checked={!scoped} onChange={(event) => onBindingChange(node.id, { environmentIds: event.target.checked ? undefined : [] })} /> All</label>{spec.environments.map((candidate) => <label key={candidate.id}><input type="checkbox" aria-label={`${candidate.name} binding for ${node.label}`} disabled={readOnly || !binding.enabled} checked={!scoped || binding.environmentIds?.includes(candidate.id) === true} onChange={(event) => {
                const current = new Set(binding.environmentIds ?? allEnvironmentIds);
                if (event.target.checked) current.add(candidate.id); else current.delete(candidate.id);
                const values = [...current].sort();
                onBindingChange(node.id, { environmentIds: values.length === allEnvironmentIds.length ? undefined : values });
              }} /> {candidate.name}</label>)}</fieldset>
            </div>;
          })}
        </div>
      </div>}
    </section>
  );
}
