import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowRight, Check, CircleAlert, GitBranch, Plus, ShieldCheck, Trash2 } from "lucide-react";
import type { ArchitectureSpecV1 } from "@myskills-app/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  safeArchitectureErrorMessage,
  type ArchitectureDetail,
  type ArchitecturePattern,
  type ArchitecturePatternId,
  type ArchitecturePatternMigrationCreateResult,
  type ArchitecturePatternMigrationMapping,
  type ArchitecturePatternMigrationPreviewResult,
  type RegistryClient,
} from "../../api.js";

type MigrationState = "idle" | "previewing" | "ready" | "creating" | "created" | "error";

interface ArchitecturePatternMigrationCardProps {
  architectureId: string;
  architectureName: string;
  currentPatternId: ArchitecturePatternId;
  currentRevisionId: string | null;
  detail: ArchitectureDetail;
  patterns: ArchitecturePattern[];
  client: RegistryClient;
  onCreated?: (result: ArchitecturePatternMigrationCreateResult) => void;
}

interface RouterGroupDraft {
  id: string;
  label: string;
  parentRouterId: string;
  leafNodeIds: string[];
}

interface TopologyNodeView {
  id: string;
  kind: string;
  label: string;
}

interface TopologyEdgeView {
  from: string;
  to: string;
  kind: string;
}

interface TopologyView {
  nodes: TopologyNodeView[];
  edges: TopologyEdgeView[];
}

const MAPPING_LABEL_MAX_LENGTH = 160;
const MAX_ROUTER_GROUPS = 64;
const MAX_TOPOLOGY_PREVIEW_NODES = 40;

/**
 * Presents the server-derived pattern migration as a preview-first workflow.
 * The browser sends only migration intent and bounded mapping controls; it
 * never constructs or submits a target architecture specification.
 */
export function ArchitecturePatternMigrationCard({
  architectureId,
  architectureName,
  currentPatternId,
  currentRevisionId,
  detail,
  patterns,
  client,
  onCreated,
}: ArchitecturePatternMigrationCardProps) {
  const availablePatterns = useMemo(() => patterns
    .filter((pattern) => pattern.id !== currentPatternId && pattern.status !== "planned" && pattern.status !== "unsupported")
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)), [currentPatternId, patterns]);
  const sourceSpec = detail.latestRevision?.spec;
  const sourceRouters = useMemo(() => sourceSpec?.nodes.filter((node) => node.kind === "router") ?? [], [sourceSpec]);
  const sourceLeaves = useMemo(() => sourceSpec?.nodes.filter((node) => node.kind === "leaf") ?? [], [sourceSpec]);
  const sourceRootId = useMemo(() => {
    const entryRoot = sourceSpec?.entryNodeIds.find((entryNodeId) => sourceRouters.some((router) => router.id === entryNodeId));
    return entryRoot ?? sourceRouters[0]?.id ?? "";
  }, [sourceRouters, sourceSpec?.entryNodeIds]);

  const [targetPatternId, setTargetPatternId] = useState<ArchitecturePatternId>(availablePatterns[0]?.id ?? "flat");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [message, setMessage] = useState("");
  const [rootRouterId, setRootRouterId] = useState("");
  const [rootLabel, setRootLabel] = useState("");
  const [allowUnassignedLeafFallback, setAllowUnassignedLeafFallback] = useState(false);
  const [routerGroups, setRouterGroups] = useState<RouterGroupDraft[]>([]);
  const [previewResult, setPreviewResult] = useState<ArchitecturePatternMigrationPreviewResult | null>(null);
  const [state, setState] = useState<MigrationState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => createClientIdempotencyKey());

  useEffect(() => {
    if (!availablePatterns.some((pattern) => pattern.id === targetPatternId)) {
      setTargetPatternId(availablePatterns[0]?.id ?? "flat");
      resetPreview();
    }
  }, [availablePatterns, targetPatternId]);

  const mappingSupported = targetPatternId !== "flat";
  const rootLabelError = rootLabel.length > MAPPING_LABEL_MAX_LENGTH
    ? `Root label must be ${MAPPING_LABEL_MAX_LENGTH} characters or fewer.`
    : null;
  const groupErrors = routerGroups.map((group) => ({
    id: group.id,
    label: !group.label.trim()
      ? "Give this router group a label."
      : group.label.length > MAPPING_LABEL_MAX_LENGTH
        ? `Router group labels must be ${MAPPING_LABEL_MAX_LENGTH} characters or fewer.`
        : null,
    leaves: group.leafNodeIds.length === 0 ? "Select at least one leaf skill for this router group." : null,
  }));
  const mappingError = mappingSupported && (rootLabelError || routerGroups.length > MAX_ROUTER_GROUPS || groupErrors.some((error) => error.label || error.leaves))
    ? "Resolve the highlighted mapping fields before previewing this migration."
    : null;
  const mapping = useMemo(() => buildMapping({
    allowUnassignedLeafFallback,
    rootLabel,
    rootRouterId,
    routerGroups,
    targetPatternId,
  }), [allowUnassignedLeafFallback, rootLabel, rootRouterId, routerGroups, targetPatternId]);
  const migration = previewResult?.migration;
  const blocked = migration?.mappingStatus === "blocked";
  const canPreview = Boolean(
    currentRevisionId
      && availablePatterns.length > 0
      && client.previewArchitecturePatternMigration
      && !mappingError
      && state !== "previewing"
      && state !== "creating",
  );
  const canCreate = Boolean(
    currentRevisionId
      && previewResult
      && !blocked
      && name.trim()
      && client.createArchitecturePatternMigration
      && state !== "previewing"
      && state !== "creating"
      && state !== "created",
  );
  const maxRouterGroups = Math.min(MAX_ROUTER_GROUPS, Math.max(1, sourceLeaves.length || 1));

  function resetPreview() {
    if (state === "created") {
      setIdempotencyKey(createClientIdempotencyKey());
    }
    setPreviewResult(null);
    setConfirmCreate(false);
    setErrorMessage(null);
    setStatusMessage(null);
    if (state !== "creating") setState("idle");
  }

  function updateMapping(next: () => void) {
    next();
    resetPreview();
  }

  function cancelCreateConfirmation() {
    setConfirmCreate(false);
    setErrorMessage(null);
    setStatusMessage(null);
    if (state === "error") setState("ready");
  }

  async function runPreview() {
    if (!client.previewArchitecturePatternMigration || !currentRevisionId || !canPreview) return;
    setState("previewing");
    setPreviewResult(null);
    setErrorMessage(null);
    setStatusMessage(null);
    setConfirmCreate(false);
    try {
      const result = await client.previewArchitecturePatternMigration(architectureId, {
        expectedCurrentRevisionId: currentRevisionId,
        targetPatternId,
        ...(mapping ? { mapping } : {}),
      });
      setPreviewResult(result);
      setState("ready");
      setStatusMessage(result.migration.mappingStatus === "blocked"
        ? "Migration preview is blocked. Review the bounded issues before creating a shell."
        : "Migration preview ready. The source architecture is unchanged.");
    } catch (error) {
      setState("error");
      setErrorMessage(safeArchitectureErrorMessage(error));
    }
  }

  function previewMigration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runPreview();
  }

  async function createMigration() {
    if (!confirmCreate || !client.createArchitecturePatternMigration || !currentRevisionId || !previewResult || blocked || !name.trim() || !mappingOk(mapping)) return;
    setState("creating");
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const result = await client.createArchitecturePatternMigration(architectureId, {
        expectedCurrentRevisionId: currentRevisionId,
        targetPatternId,
        idempotencyKey,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(mapping ? { mapping } : {}),
      });
      setState("created");
      setConfirmCreate(false);
      setStatusMessage(result.replayed ? "The existing derived shell was returned for this request." : "Derived shell created. The source architecture was not changed.");
      onCreated?.(result);
    } catch (error) {
      setState("error");
      setErrorMessage(safeArchitectureErrorMessage(error));
    }
  }

  function addRouterGroup() {
    if (routerGroups.length >= maxRouterGroups) return;
    const id = nextRouterGroupId(routerGroups);
    updateMapping(() => setRouterGroups((current) => [...current, { id, label: "", parentRouterId: "", leafNodeIds: [] }]));
  }

  function removeRouterGroup(groupId: string) {
    updateMapping(() => setRouterGroups((current) => current
      .filter((group) => group.id !== groupId)
      .map((group) => group.parentRouterId === groupId ? { ...group, parentRouterId: "" } : group)));
  }

  function updateRouterGroup(groupId: string, patch: Partial<RouterGroupDraft>) {
    updateMapping(() => setRouterGroups((current) => current.map((group) => group.id === groupId ? { ...group, ...patch } : group)));
  }

  function toggleGroupLeaf(groupId: string, leafId: string, checked: boolean) {
    updateMapping(() => setRouterGroups((current) => current.map((group) => {
      if (group.id === groupId) {
        const leafNodeIds = checked ? [...new Set([...group.leafNodeIds, leafId])] : group.leafNodeIds.filter((id) => id !== leafId);
        return { ...group, leafNodeIds };
      }
      return checked ? { ...group, leafNodeIds: group.leafNodeIds.filter((id) => id !== leafId) } : group;
    })));
  }

  return (
    <Card className="architecture-migration-card" aria-label="Migrate architecture pattern">
      <CardHeader className="architecture-card-heading">
        <div className="architecture-card-heading-icon"><GitBranch size={17} aria-hidden="true" /></div>
        <div>
          <CardTitle>Derive a new pattern shell</CardTitle>
          <CardDescription>Preview a server-derived migration from {patternLabel(currentPatternId)} to another available pattern for {architectureName}. The source revision remains immutable.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {!currentRevisionId && <div className="architecture-governance-status" role="status"><CircleAlert size={15} aria-hidden="true" /> Add a current revision before deriving a pattern shell.</div>}
        {availablePatterns.length === 0 && <div className="architecture-governance-status" role="status"><CircleAlert size={15} aria-hidden="true" /> No alternate pattern is available for this architecture.</div>}
        <form className="architecture-migration-form" onSubmit={previewMigration}>
          <label htmlFor="migration-target-pattern">
            <span>Target pattern</span>
            <select id="migration-target-pattern" disabled={!currentRevisionId || state === "previewing" || state === "creating"} onChange={(event) => { setTargetPatternId(event.target.value as ArchitecturePatternId); resetPreview(); }} value={targetPatternId}>
              {availablePatterns.map((pattern) => <option key={pattern.id} value={pattern.id}>{pattern.name}</option>)}
            </select>
            {availablePatterns.find((pattern) => pattern.id === targetPatternId)?.description && <small>{availablePatterns.find((pattern) => pattern.id === targetPatternId)?.description}</small>}
          </label>

          {mappingSupported ? (
            <fieldset className="control-plane-form" disabled={state === "previewing" || state === "creating"}>
              <legend>Bounded topology mapping <small>(optional)</small></legend>
              <p className="architecture-governance-footnote">Use selectors to choose the root and router groups. The server still validates the mapping and owns the derived specification.</p>
              <label htmlFor="migration-root-router">
                <span>Root router</span>
                <select id="migration-root-router" aria-describedby="migration-root-router-help" onChange={(event) => updateMapping(() => setRootRouterId(event.target.value))} value={rootRouterId}>
                  <option value="">Use the source or generated root</option>
                  {sourceRouters.map((router) => <option key={router.id} value={router.id}>{router.label} · {router.id}</option>)}
                </select>
                <small id="migration-root-router-help">Source root suggestion: {sourceRootId || "generated for this shell"}.</small>
              </label>
              <label htmlFor="migration-root-label">
                <span>Root label <small>(optional)</small></span>
                <Input id="migration-root-label" aria-describedby={rootLabelError ? "migration-root-label-error" : undefined} aria-invalid={Boolean(rootLabelError)} maxLength={MAPPING_LABEL_MAX_LENGTH} onChange={(event) => updateMapping(() => setRootLabel(event.target.value))} placeholder="Skill router" value={rootLabel} />
                {rootLabelError && <small id="migration-root-label-error" role="alert">{rootLabelError}</small>}
              </label>

              {targetPatternId === "multi-level-router" && (
                <>
                  <div>
                    <strong>Router groups</strong>
                    <p className="architecture-governance-footnote">Assign each leaf to at most one group. Group parents use earlier groups, so the form cannot create a parent cycle.</p>
                  </div>
                  {routerGroups.map((group, index) => {
                    const errors = groupErrors[index];
                    const groupLabelErrorId = `${group.id}-label-error`;
                    return (
                      <fieldset className="control-plane-form" key={group.id}>
                        <legend>Router group {index + 1}</legend>
                        <label htmlFor={`${group.id}-label`}>
                          <span>Group label</span>
                          <Input id={`${group.id}-label`} aria-describedby={errors?.label ? groupLabelErrorId : undefined} aria-invalid={Boolean(errors?.label)} maxLength={MAPPING_LABEL_MAX_LENGTH} onChange={(event) => updateRouterGroup(group.id, { label: event.target.value })} placeholder="Domain router" value={group.label} />
                          {errors?.label && <small id={groupLabelErrorId} role="alert">{errors.label}</small>}
                        </label>
                        <label htmlFor={`${group.id}-parent`}>
                          <span>Parent router</span>
                          <select id={`${group.id}-parent`} onChange={(event) => updateRouterGroup(group.id, { parentRouterId: event.target.value })} value={group.parentRouterId}>
                            <option value="">Root router</option>
                            {routerGroups.slice(0, index).map((parent) => <option key={parent.id} value={parent.id}>{parent.label || parent.id}</option>)}
                          </select>
                        </label>
                        <fieldset>
                          <legend>Leaf skills in this group</legend>
                          {sourceLeaves.length > 0 ? sourceLeaves.map((leaf) => (
                            <label className="control-plane-checkbox" key={leaf.id} htmlFor={`${group.id}-leaf-${leaf.id}`}>
                              <input id={`${group.id}-leaf-${leaf.id}`} checked={group.leafNodeIds.includes(leaf.id)} onChange={(event) => toggleGroupLeaf(group.id, leaf.id, event.target.checked)} type="checkbox" />
                              <span><strong>{leaf.label}</strong><small>{leaf.id}</small></span>
                            </label>
                          )) : <p className="architecture-governance-footnote">No leaf skills are available in the source revision.</p>}
                          {errors?.leaves && <p role="alert" className="architecture-governance-footnote">{errors.leaves}</p>}
                        </fieldset>
                        <Button size="sm" type="button" variant="outline" onClick={() => removeRouterGroup(group.id)}><Trash2 size={15} aria-hidden="true" /> Remove group</Button>
                      </fieldset>
                    );
                  })}
                  <Button disabled={routerGroups.length >= maxRouterGroups} size="sm" type="button" variant="outline" onClick={addRouterGroup}><Plus size={15} aria-hidden="true" /> Add router group ({routerGroups.length}/{maxRouterGroups})</Button>
                  <label className="control-plane-checkbox" htmlFor="migration-leaf-fallback">
                    <input id="migration-leaf-fallback" checked={allowUnassignedLeafFallback} onChange={(event) => updateMapping(() => setAllowUnassignedLeafFallback(event.target.checked))} type="checkbox" />
                    <span><strong>Keep unassigned leaves in General</strong><small>Allow the server to add a deterministic fallback router for leaves not assigned above.</small></span>
                  </label>
                </>
              )}
              {mappingError && <p className="architecture-inline-message" id="migration-mapping-error" role="alert">{mappingError}</p>}
            </fieldset>
          ) : (
            <div className="architecture-governance-status" role="status"><ShieldCheck size={15} aria-hidden="true" /> Flat library migrations preserve leaf skills directly; router mapping controls apply only to domain and multi-level targets.</div>
          )}

          <Button disabled={!canPreview} size="sm" type="submit"><ArrowRight size={15} aria-hidden="true" /> {state === "previewing" ? "Previewing…" : "Preview migration"}</Button>
        </form>

        {state === "previewing" && <div className="architecture-governance-status" role="status" aria-live="polite">Loading migration preview…</div>}
        {state === "creating" && <div className="architecture-governance-status" role="status" aria-live="polite">Creating the derived shell…</div>}

        {migration && <MigrationPreviewSummary migration={migration} sourceSpec={sourceSpec} />}
        {statusMessage && <div className="architecture-inline-message success" role="status" aria-live="polite">{statusMessage}</div>}
        {errorMessage && (
          <div className="architecture-inline-message" role="alert">
            <span>{errorMessage}</span>
            {previewResult && !blocked && confirmCreate
              ? <Button size="sm" type="button" variant="outline" onClick={() => void createMigration()}>Retry create</Button>
              : <Button size="sm" type="button" variant="outline" onClick={() => void runPreview()}><ArrowRight size={15} aria-hidden="true" /> Retry preview</Button>}
          </div>
        )}

        {previewResult && !blocked && (
          <div className="architecture-migration-create">
            <div className="architecture-migration-create-heading"><ShieldCheck size={15} aria-hidden="true" /><strong>Review before creating a derived shell</strong></div>
            <p>The API allocates a new shell and first immutable revision atomically. Organization grants and connected targets are never copied.</p>
            <label htmlFor="derived-architecture-name"><span>Name</span><Input id="derived-architecture-name" aria-label="Derived architecture name" aria-required="true" disabled={state === "creating"} maxLength={120} onChange={(event) => setName(event.target.value)} value={name} /></label>
            <label htmlFor="derived-architecture-description"><span>Description <small>(optional)</small></span><textarea id="derived-architecture-description" aria-label="Derived architecture description" disabled={state === "creating"} maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="What the derived shell is for" value={description} /></label>
            <label htmlFor="derived-architecture-message"><span>Revision message <small>(optional)</small></span><Input id="derived-architecture-message" aria-label="Derived architecture revision message" disabled={state === "creating"} maxLength={500} onChange={(event) => setMessage(event.target.value)} placeholder="Explain this pattern migration" value={message} /></label>
            {!name.trim() && <p className="architecture-governance-footnote" role="status">Enter a name to enable the create review.</p>}
            {!confirmCreate ? (
              <Button disabled={!canCreate} size="sm" type="button" onClick={() => setConfirmCreate(true)}><Check size={15} aria-hidden="true" /> Review create</Button>
            ) : (
              <div className="architecture-governance-status" role="alert">
                <CircleAlert size={15} aria-hidden="true" />
                <span>Confirm creation of a new {patternLabel(targetPatternId)} shell named “{name.trim()}”. The source, grants, and targets remain unchanged.</span>
                <Button disabled={state === "creating"} size="sm" type="button" onClick={() => void createMigration()}><Check size={15} aria-hidden="true" /> {state === "creating" ? "Creating shell…" : "Confirm create derived shell"}</Button>
                <Button disabled={state === "creating"} size="sm" type="button" variant="outline" onClick={cancelCreateConfirmation}>Cancel</Button>
              </div>
            )}
          </div>
        )}
        {state === "created" && <p className="architecture-governance-footnote">The new shell starts with its own identity and no copied grants or targets. Use the architecture list to inspect its first revision.</p>}
        <p className="architecture-governance-footnote">Client request key is stable across retries. Current source revision: {detail.latestRevision?.revisionNumber ?? "—"}.</p>
      </CardContent>
    </Card>
  );
}

function MigrationPreviewSummary({
  migration,
  sourceSpec,
}: {
  migration: ArchitecturePatternMigrationPreviewResult["migration"];
  sourceSpec: ArchitectureSpecV1 | undefined;
}) {
  const diff = migration.diff;
  const sourceTopology = topologyView(sourceSpec);
  const targetTopology = topologyView(migration.target?.spec);
  return (
    <section className="architecture-migration-preview" aria-label="Pattern migration preview" aria-live="polite">
      <div className="architecture-migration-preview-heading">
        <div><strong>Bounded topology and semantic diff</strong><small>{patternLabel(migration.source.patternId)} <ArrowRight size={13} aria-hidden="true" /> {migration.target?.patternId ? patternLabel(migration.target.patternId) : "Blocked"}</small></div>
        <Badge variant={migration.mappingStatus === "blocked" ? "destructive" : "secondary"}>{migration.mappingStatus}</Badge>
      </div>
      <TopologyPreview source={sourceTopology} target={targetTopology} />
      <dl className="architecture-migration-diff-grid">
        <div><dt>Preserved skills</dt><dd>{diff.preservedSkillRefIds.length}</dd></div>
        <div><dt>Preserved leaves</dt><dd>{diff.preservedLeafNodeIds.length}</dd></div>
        <div><dt>Routers added</dt><dd>{diff.addedRouterNodeIds.length}</dd></div>
        <div><dt>Routers dropped</dt><dd>{diff.droppedRouterNodeIds.length}</dd></div>
        <div><dt>Edges added</dt><dd>{diff.addedEdgeCount}</dd></div>
        <div><dt>Edges removed</dt><dd>{diff.removedEdgeCount}</dd></div>
        <div><dt>Bindings rewritten</dt><dd>{diff.rewrittenBindingCount}</dd></div>
      </dl>
      <div className="architecture-governance-footnote">
        <strong>What changes</strong>
        <ul>
          <li>Added routers: {describeNodeIds(diff.addedRouterNodeIds, targetTopology)}</li>
          <li>Dropped routers: {describeNodeIds(diff.droppedRouterNodeIds, sourceTopology)}</li>
          <li>Preserved leaf skills: {describeNodeIds(diff.preservedLeafNodeIds, sourceTopology)}</li>
        </ul>
      </div>
      {migration.issues.length > 0 && (
        <div className="architecture-migration-issues" role="alert">
          <strong>Issues to resolve</strong>
          <ul>{migration.issues.map((issue, index) => <li key={`${issue.code}:${issue.path ?? ""}:${index}`}>{issue.path ? `${issue.path}: ` : ""}{issue.message}</li>)}</ul>
        </div>
      )}
      {migration.mappingStatus !== "blocked" && <p className="architecture-governance-footnote">Exact skill references and effective leaf exposure are preserved by the server-derived candidate.</p>}
    </section>
  );
}

function TopologyPreview({ source, target }: { source: TopologyView; target: TopologyView }) {
  return (
    <div className="architecture-migration-topology" aria-label="Migration topology comparison">
      <TopologyColumn title="Current topology" view={source} />
      <ArrowRight size={18} aria-hidden="true" />
      <TopologyColumn title="Derived topology" view={target} />
    </div>
  );
}

function TopologyColumn({ title, view }: { title: string; view: TopologyView }) {
  const shownNodes = view.nodes.slice(0, MAX_TOPOLOGY_PREVIEW_NODES);
  return (
    <section aria-label={title}>
      <strong>{title}</strong>
      <small>{view.nodes.filter((node) => node.kind === "router").length} routers · {view.nodes.filter((node) => node.kind === "leaf").length} leaves · {view.edges.length} edges</small>
      {shownNodes.length > 0 ? (
        <ul>
          {shownNodes.map((node) => <li key={node.id}><strong>{node.label}</strong><small>{node.kind} · {node.id}</small></li>)}
        </ul>
      ) : <p className="architecture-governance-footnote">No topology data returned.</p>}
      {view.nodes.length > shownNodes.length && <p className="architecture-governance-footnote">Showing the first {shownNodes.length} nodes.</p>}
    </section>
  );
}

function topologyView(value: unknown): TopologyView {
  if (!isRecord(value)) return { nodes: [], edges: [] };
  const nodes = Array.isArray(value.nodes) ? value.nodes.flatMap((node) => {
    if (!isRecord(node) || typeof node.id !== "string" || typeof node.kind !== "string" || typeof node.label !== "string") return [];
    return [{ id: node.id, kind: node.kind, label: node.label }];
  }).sort((left, right) => left.id.localeCompare(right.id)) : [];
  const edges = Array.isArray(value.edges) ? value.edges.flatMap((edge) => {
    if (!isRecord(edge) || typeof edge.from !== "string" || typeof edge.to !== "string" || typeof edge.kind !== "string") return [];
    return [{ from: edge.from, to: edge.to, kind: edge.kind }];
  }).sort((left, right) => `${left.from}:${left.to}:${left.kind}`.localeCompare(`${right.from}:${right.to}:${right.kind}`)) : [];
  return { nodes, edges };
}

function describeNodeIds(ids: string[], topology: TopologyView): string {
  if (ids.length === 0) return "none";
  const labels = ids.map((id) => topology.nodes.find((node) => node.id === id)?.label ?? id);
  return labels.length > 5 ? `${labels.slice(0, 5).join(", ")} + ${labels.length - 5} more` : labels.join(", ");
}

function patternLabel(patternId: ArchitecturePatternId): string {
  switch (patternId) {
    case "flat": return "Flat library";
    case "domain-router": return "Domain router";
    case "multi-level-router": return "Multi-level router";
    default: return patternId;
  }
}

function buildMapping(input: {
  allowUnassignedLeafFallback: boolean;
  rootLabel: string;
  rootRouterId: string;
  routerGroups: RouterGroupDraft[];
  targetPatternId: ArchitecturePatternId;
}): ArchitecturePatternMigrationMapping | undefined {
  if (input.targetPatternId === "flat") return undefined;
  const mapping: ArchitecturePatternMigrationMapping = {};
  if (input.rootRouterId) mapping.rootRouterId = input.rootRouterId;
  if (input.rootLabel.trim()) mapping.rootLabel = input.rootLabel.trim();
  if (input.targetPatternId === "multi-level-router") {
    if (input.routerGroups.length > 0) {
      mapping.routerGroups = input.routerGroups.map((group) => ({
        id: group.id,
        label: group.label.trim(),
        ...(group.parentRouterId ? { parentRouterId: group.parentRouterId } : {}),
        leafNodeIds: [...group.leafNodeIds].sort((left, right) => left.localeCompare(right)),
      }));
    }
    if (input.allowUnassignedLeafFallback) mapping.allowUnassignedLeafFallback = true;
  }
  return Object.keys(mapping).length > 0 ? mapping : undefined;
}

function mappingOk(mapping: ArchitecturePatternMigrationMapping | undefined): boolean {
  return mapping === undefined || (typeof mapping === "object" && !Array.isArray(mapping));
}

function nextRouterGroupId(groups: RouterGroupDraft[]): string {
  const reserved = new Set(groups.map((group) => group.id));
  let index = groups.length + 1;
  while (reserved.has(`router-group-${index}`)) index += 1;
  return `router-group-${index}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createClientIdempotencyKey(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  } catch {
    // Use a non-secret opaque fallback when Web Crypto is unavailable.
  }
  return `migration-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
