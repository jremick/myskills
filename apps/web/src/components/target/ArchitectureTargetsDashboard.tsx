import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Check,
  CircleAlert,
  Eye,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  safeArchitectureErrorMessage,
  safeArchitectureTargetErrorMessage,
  type ArchitectureDetail,
  type ArchitectureSummary,
  type ArchitectureTargetObservationRecord,
  type ArchitectureTargetRecord,
  type RegistryClient,
} from "../../api.js";
import type {
  ArchitectureTargetCapabilities,
  ArchitectureTargetHealth,
  ArchitectureTargetMetadata,
  ArchitectureTargetOwnerReference,
} from "@myskills-app/core";
import { architectureDigest, type ArchitectureSpecV1 } from "@myskills-app/core";
import { CodexWorkspaceGuide } from "./CodexWorkspaceGuide.js";
import { useSplitLayout } from "../registry/useSplitLayout.js";
import {
  adapterLabel,
  consentLabel,
  healthLabel,
  ownerLabel,
  shortId,
  targetStatusLabel,
  toneOf,
} from "../control-plane/control-plane-display.js";

type TargetPanel = "detail" | "register" | "guide";
type PendingFocus = { kind: "title"; id: string } | { kind: "row"; id: string } | { kind: "register" } | { kind: "guide" };

interface TargetSession {
  user: {
    id: string;
    email: string;
  };
}

type LoadState = "loading" | "ready" | "error";

const READ_CAPABILITY_OPTIONS: Array<{ key: "inventory.read" | "health.read" | "plan.read"; label: string; description: string }> = [
  { key: "inventory.read", label: "Inventory", description: "Read bounded skill inventory" },
  { key: "health.read", label: "Health", description: "Read target health" },
  { key: "plan.read", label: "Plan", description: "Read dry-run plan results" },
];

const SUPPORTED_ADAPTERS = [
  { kind: "codex-readonly", version: "1", contractVersion: 1 as const, label: "Codex · read-only adapter" },
] as const;

interface TargetArchitectureContext {
  spec: ArchitectureSpecV1;
  revisionId: string;
  revisionNumber: number;
  revisionDigest: string;
  profiles: ArchitectureSpecV1["profiles"];
  environments: ArchitectureSpecV1["environments"];
}

interface TargetOwnerOption {
  key: string;
  owner: ArchitectureTargetOwnerReference;
  label: string;
  detail: string;
}

function architectureContextFor(detail: ArchitectureDetail | null): TargetArchitectureContext | null {
  const revision = detail?.latestRevision;
  if (!detail || !revision || !detail.currentRevisionId || revision.id !== detail.currentRevisionId) return null;
  try {
    const spec = revision.spec;
    if (!Array.isArray(spec.profiles) || !Array.isArray(spec.environments)) return null;
    return {
      spec,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      revisionDigest: architectureDigest(spec),
      profiles: spec.profiles,
      environments: spec.environments,
    };
  } catch {
    return null;
  }
}

function targetOwnerOptions(
  architectures: readonly ArchitectureSummary[],
  organizations: Array<{ id: string; name: string; role?: string }>,
): TargetOwnerOption[] {
  const options: TargetOwnerOption[] = [];
  for (const architecture of architectures) {
    const owner = architectureOwnerReference(architecture);
    if (owner && architecture.access?.canCreate === true && architecture.access.canManage === true
      && !options.some((option) => option.key === `${owner.type}:${owner.id}`)) {
      options.push({
        key: `${owner.type}:${owner.id}`,
        owner,
        label: owner.type === "team" ? "Team owner" : "Architecture owner",
        detail: owner.type === "team"
          ? "The target will use the architecture team's server-authorized ownership boundary."
          : "The target will use the architecture owner's server-authorized ownership boundary.",
      });
    }
    for (const organizationId of architecture.access?.allowedOrganizationIds ?? []) {
      if (options.some((option) => option.key === `organization:${organizationId}`)) continue;
      const organization = organizations.find((candidate) => candidate.id === organizationId);
      // Organization target ownership requires a current owner/admin role.
      // Keep member-only sharing scopes out of the registration selector; the
      // API still rechecks the current membership and policy at submit time.
      if (!organization || (organization.role !== "owner" && organization.role !== "admin")) continue;
      options.push({
        key: `organization:${organizationId}`,
        owner: { type: "organization", id: organizationId },
        label: organization ? `Organization · ${organization.name}` : "Organization sharing scope",
        detail: "The target will use an organization sharing boundary. Current membership and policy gates are checked by the API.",
      });
    }
  }
  return options;
}

function architectureSupportsOwner(
  architecture: ArchitectureSummary,
  owner: ArchitectureTargetOwnerReference | undefined,
): boolean {
  if (!owner) return false;
  if (owner.type === "organization") {
    return architecture.access?.allowedOrganizationIds?.includes(owner.id) === true;
  }
  const architectureOwner = architectureOwnerReference(architecture);
  return architecture.access?.canCreate === true
    && architecture.access.canManage === true
    && architectureOwner?.type === owner.type
    && architectureOwner.id === owner.id;
}

function architectureOwnerReference(architecture: ArchitectureSummary): ArchitectureTargetOwnerReference | null {
  if (architecture.owner?.id && (architecture.owner.type === "user" || architecture.owner.type === "team")) {
    return { type: architecture.owner.type, id: architecture.owner.id };
  }
  if (architecture.ownerType && architecture.ownerId && (architecture.ownerType === "user" || architecture.ownerType === "team")) {
    return { type: architecture.ownerType, id: architecture.ownerId };
  }
  if (architecture.ownerUserId) return { type: "user", id: architecture.ownerUserId };
  if (architecture.ownerTeamId) return { type: "team", id: architecture.ownerTeamId };
  return null;
}

function targetPatternLabel(patternId: string): string {
  if (patternId === "flat") return "Flat";
  if (patternId === "domain-router") return "Domain router";
  if (patternId === "multi-level-router") return "Multi-level router";
  return "Architecture pattern";
}

function architectureRevisionLabel(architecture: ArchitectureSummary): string {
  if (architecture.currentRevisionId && architecture.latestRevision?.revisionNumber) {
    return `revision ${architecture.latestRevision.revisionNumber}`;
  }
  if (architecture.currentRevisionId) return "current revision";
  return "no revision";
}

type ArchitectureProfileOption = ArchitectureSpecV1["profiles"][number];
type ArchitectureEnvironmentOption = ArchitectureSpecV1["environments"][number];

function stableCompare(left: string, right: string): number {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareArchitectureOptions(left: ArchitectureSummary, right: ArchitectureSummary): number {
  return stableCompare(left.name, right.name) || stableCompare(left.id, right.id);
}

function compareProfileOptions(left: ArchitectureProfileOption, right: ArchitectureProfileOption): number {
  return stableCompare(left.name, right.name) || stableCompare(left.id, right.id);
}

function compareEnvironmentOptions(left: ArchitectureEnvironmentOption, right: ArchitectureEnvironmentOption): number {
  return stableCompare(left.name, right.name) || stableCompare(left.id, right.id);
}

function ownerMatchesProfile(profile: ArchitectureProfileOption, owner: ArchitectureTargetOwnerReference | undefined): boolean {
  return owner !== undefined
    && owner.type !== "organization"
    && profile.subject.type === owner.type
    && profile.subject.id === owner.id;
}

function preferredOwnerKey(options: readonly TargetOwnerOption[], currentUserId: string): string {
  const sorted = [...options].sort((left, right) => {
    const rank = (option: TargetOwnerOption): number => {
      if (option.owner.type === "user" && option.owner.id === currentUserId) return 0;
      if (option.owner.type === "team") return 1;
      if (option.owner.type === "user") return 2;
      return 3;
    };
    return rank(left) - rank(right) || stableCompare(left.key, right.key);
  });
  return sorted[0]?.key ?? "";
}

function preferredProfileId(
  profiles: readonly ArchitectureProfileOption[],
  owner: ArchitectureTargetOwnerReference | undefined,
): string {
  const sorted = [...profiles].sort((left, right) => {
    const leftMatches = ownerMatchesProfile(left, owner);
    const rightMatches = ownerMatchesProfile(right, owner);
    return Number(rightMatches) - Number(leftMatches) || compareProfileOptions(left, right);
  });
  return sorted[0]?.id ?? "";
}

function preferredEnvironmentId(
  environments: readonly ArchitectureEnvironmentOption[],
  owner: ArchitectureTargetOwnerReference | undefined,
): string {
  const preferredKind = owner?.type === "team" ? "team" : owner?.type === "user" ? "personal" : null;
  const sorted = [...environments].sort((left, right) => {
    const leftPreferred = preferredKind !== null && left.kind === preferredKind;
    const rightPreferred = preferredKind !== null && right.kind === preferredKind;
    return Number(rightPreferred) - Number(leftPreferred) || compareEnvironmentOptions(left, right);
  });
  return sorted[0]?.id ?? "";
}

export function ArchitectureTargetsDashboard({ client, session }: { client: RegistryClient; session: TargetSession }) {
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [targets, setTargets] = useState<ArchitectureTargetRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArchitectureTargetRecord | null>(null);
  const [observations, setObservations] = useState<ArchitectureTargetObservationRecord[]>([]);
  const [detailState, setDetailState] = useState<LoadState>("ready");
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [panel, setPanel] = useState<TargetPanel>("detail");
  const [opened, setOpened] = useState(false);
  const [architectureNames, setArchitectureNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [organizationNames, setOrganizationNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const { layout, ref: measureSurface } = useSplitLayout();
  const surfaceNode = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const guideHeadingRef = useRef<HTMLHeadingElement>(null);
  const registerNameRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);
  const stacked = layout === "stack";

  const surfaceRef = useCallback((node: HTMLDivElement | null) => {
    surfaceNode.current = node;
    measureSurface(node);
  }, [measureSurface]);

  // The register form already loads architectures and organizations; reuse
  // those rows for binding labels instead of requesting them again.
  const handleRegisterDataLoaded = useCallback((architectures: readonly ArchitectureSummary[], organizations: ReadonlyArray<{ id: string; name: string }>) => {
    setArchitectureNames(new Map(architectures.map((architecture) => [architecture.id, architecture.name])));
    setOrganizationNames(new Map(organizations.map((organization) => [organization.id, organization.name])));
  }, []);

  const refreshTargets = useCallback(async () => {
    const requestEpoch = listEpoch.current + 1;
    listEpoch.current = requestEpoch;
    // A list refresh invalidates any in-flight detail request. The refreshed
    // list may select a different target, so an older response must not
    // repopulate the detail panel after it has been cleared.
    detailEpoch.current += 1;
    setDetail(null);
    setObservations([]);
    setState("loading");
    setMessage(null);
    if (!client.listArchitectureTargets) {
      setState("error");
      setMessage("Connected-target management is not available in this workspace yet.");
      return;
    }
    try {
      const nextTargets = await client.listArchitectureTargets();
      if (requestEpoch !== listEpoch.current) return;
      const current = selectedRef.current;
      const kept = current !== null && nextTargets.some((item) => item.id === current);
      // A selection that left the list (for example after revocation of
      // access) closes the phone detail instead of opening another target.
      if (!kept) setOpened(false);
      setTargets([...nextTargets]);
      setSelectedId(kept ? current : nextTargets[0]?.id ?? null);
      setState("ready");
    } catch (error) {
      if (requestEpoch !== listEpoch.current) return;
      setTargets([]);
      setSelectedId(null);
      setOpened(false);
      setState("error");
      setMessage(safeArchitectureTargetErrorMessage(error));
    }
  }, [client]);

  useEffect(() => {
    void refreshTargets();
  }, [refreshTargets, refreshKey]);

  const refreshDetail = useCallback(async (targetId: string) => {
    const requestEpoch = detailEpoch.current + 1;
    detailEpoch.current = requestEpoch;
    setDetailState("loading");
    setDetailMessage(null);
    if (!client.getArchitectureTarget || !client.listArchitectureTargetObservations) {
      setDetailState("error");
      setDetailMessage("Connected-target detail is not available in this workspace yet.");
      return;
    }
    try {
      const [nextDetail, nextObservations] = await Promise.all([
        client.getArchitectureTarget(targetId),
        client.listArchitectureTargetObservations(targetId, 25),
      ]);
      if (requestEpoch !== detailEpoch.current) return;
      setDetail(nextDetail);
      setObservations(nextObservations);
      setDetailState("ready");
    } catch (error) {
      if (requestEpoch !== detailEpoch.current) return;
      setDetail(null);
      setObservations([]);
      setDetailState("error");
      setDetailMessage(safeArchitectureTargetErrorMessage(error));
    }
  }, [client]);

  const selectTarget = useCallback((targetId: string) => {
    const isCurrent = selectedId === targetId;
    detailEpoch.current += 1;
    setDetail(null);
    setObservations([]);
    setSelectedId(targetId);
    setPanel("detail");
    if (stacked) {
      setOpened(true);
      pendingFocus.current = { kind: "title", id: targetId };
    }
    if (isCurrent) {
      // Selecting the active row again is an explicit refresh. Without this
      // branch, React keeps the same ID and no effect would refetch detail.
      void refreshDetail(targetId);
    }
  }, [refreshDetail, selectedId, stacked]);

  function openPanel(next: "register" | "guide", opener: HTMLElement) {
    openerRef.current = opener;
    setPanel(next);
    pendingFocus.current = { kind: next };
  }

  // Cancel and Close keep the panel mounted, so a register draft survives.
  function closePanel() {
    setPanel("detail");
    const opener = openerRef.current;
    openerRef.current = null;
    pendingFocus.current = null;
    opener?.focus();
  }

  function backToTargets() {
    setOpened(false);
    if (selectedId) pendingFocus.current = { kind: "row", id: selectedId };
  }

  const handleRegistered = useCallback((target: ArchitectureTargetRecord) => {
    openerRef.current = null;
    setPanel("detail");
    setOpened(true);
    setSelectedId(target.id);
    pendingFocus.current = { kind: "title", id: target.id };
    setRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    const next = pendingFocus.current;
    if (!next) return;
    const element = next.kind === "title" ? (detail?.id === next.id ? titleRef.current : null)
      : next.kind === "register" ? registerNameRef.current
        : next.kind === "guide" ? guideHeadingRef.current
          : Array.from(surfaceNode.current?.querySelectorAll<HTMLElement>("[data-target-id]") ?? []).find((item) => item.dataset.targetId === next.id) ?? null;
    if (!element || element.closest("[hidden]")) return;
    pendingFocus.current = null;
    element.focus();
  });

  useEffect(() => {
    if (!selectedId || state !== "ready") {
      setDetail(null);
      setObservations([]);
      setDetailState("ready");
      return;
    }
    void refreshDetail(selectedId);
  // A fast list refresh can batch loading and ready into one render. The
  // new list identity still reloads detail when the selected ID is unchanged.
  }, [refreshDetail, selectedId, state, targets]);

  const noTargets = state === "ready" && targets.length === 0;
  const inspectorPanel: TargetPanel = panel === "register" ? "register" : panel === "guide" || noTargets ? "guide" : "detail";
  const showList = !stacked || noTargets || (!opened && panel === "detail");
  const showInspector = !stacked || noTargets || opened || panel !== "detail";

  return <main className="control-plane-workspace target-workspace cp-page" aria-label="Connected targets">
    <header className="cp-page-head app-page-header">
      <div><h1 id="targets-heading">Connected targets</h1></div>
      <div className="cp-page-actions">
        <Button aria-controls="target-guide-panel" aria-expanded={inspectorPanel === "guide"} size="sm" type="button" variant="outline" onClick={(event) => openPanel("guide", event.currentTarget)}><BookOpen size={15} aria-hidden="true" />Setup guide</Button>
        <Button aria-controls="target-register-panel" aria-expanded={panel === "register"} size="sm" type="button" variant="outline" onClick={(event) => openPanel("register", event.currentTarget)}><Plus size={15} aria-hidden="true" />Register read-only target</Button>
        <Button aria-label="Refresh" size="icon-sm" title="Refresh" type="button" variant="outline" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={16} aria-hidden="true" /></Button>
      </div>
    </header>
    <div className="cp-surface" data-layout={layout} data-empty={noTargets ? "true" : undefined} ref={surfaceRef}>
      <div className="cp-body">
        <section className="cp-list" aria-label="Connected target list" hidden={!showList}>
          <div className="cp-list-label"><h2>Targets</h2><span aria-live="polite">{state === "ready" ? targets.length : ""}</span></div>
          {state === "loading" && <TargetLoadingRows />}
          {state === "error" && <div className="cp-list-state" role="alert"><strong>Targets unavailable</strong><p>{message ?? "Retry when the target service is ready."}</p><Button size="sm" type="button" variant="outline" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />Retry</Button></div>}
          {noTargets && <div className="cp-list-state"><strong>No connected targets</strong><p>Enroll a Codex workspace with the CLI setup guide, or register a read-only target.</p></div>}
          {state === "ready" && targets.length > 0 && <div className="cp-rows" role="list">{targets.map((target) => {
            const status = targetStatusLabel(target.status);
            return <div key={target.id} role="listitem"><button aria-current={target.id === selectedId ? "true" : undefined} aria-pressed={target.id === selectedId} className="cp-row" data-target-id={target.id} type="button" onClick={() => selectTarget(target.id)}>
              <span className="cp-row-text"><span className="cp-row-title">{target.name}</span><span className="cp-row-meta">{adapterLabel(target.adapter.kind)} · {ownerLabel(target.owner, session.user.id, organizationNames)} · {consentLabel(target.consent.status).label}</span></span>
              <span className="cp-chip" data-tone={toneOf(status)}>{status.label}</span>
            </button></div>;
          })}</div>}
        </section>
        <div className="cp-inspector" hidden={!showInspector}>
          <div className="cp-panel" hidden={inspectorPanel !== "detail"}>
            <TargetDetailPanel
              client={client}
              detail={detail}
              observations={observations}
              state={detailState}
              message={detailMessage}
              selectedId={selectedId}
              currentUserId={session.user.id}
              architectureNames={architectureNames}
              organizationNames={organizationNames}
              titleRef={titleRef}
              onBack={stacked ? backToTargets : undefined}
              onRefresh={() => selectedId && void refreshDetail(selectedId)}
            />
          </div>
          <div className="cp-panel" id="target-register-panel" hidden={inspectorPanel !== "register"}>
            <RegisterTargetCard client={client} session={session} nameRef={registerNameRef} onCancel={closePanel} onLoaded={handleRegisterDataLoaded} onRegistered={handleRegistered} />
          </div>
          <div className="cp-panel" id="target-guide-panel" hidden={inspectorPanel !== "guide"}>
            {!noTargets && <div className="cp-panel-bar"><Button size="sm" type="button" variant="outline" onClick={closePanel}><X size={15} aria-hidden="true" />Close</Button></div>}
            <CodexWorkspaceGuide headingRef={guideHeadingRef} />
          </div>
        </div>
      </div>
    </div>
  </main>;
}

function RegisterTargetCard({ client, session, nameRef, onRegistered, onCancel, onLoaded }: {
  client: RegistryClient;
  session: TargetSession;
  nameRef: RefObject<HTMLInputElement | null>;
  onRegistered: (target: ArchitectureTargetRecord) => void;
  onCancel: () => void;
  onLoaded: (architectures: readonly ArchitectureSummary[], organizations: ReadonlyArray<{ id: string; name: string }>) => void;
}) {
  const [name, setName] = useState("");
  const [architectures, setArchitectures] = useState<ArchitectureSummary[]>([]);
  const [organizations, setOrganizations] = useState<Array<{ id: string; name: string; role?: string }>>([]);
  const [architectureState, setArchitectureState] = useState<LoadState>("loading");
  const [architectureMessage, setArchitectureMessage] = useState<string | null>(null);
  const [selectedArchitectureId, setSelectedArchitectureId] = useState("");
  const [selectedArchitectureDetail, setSelectedArchitectureDetail] = useState<ArchitectureDetail | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("ready");
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const [ownerKey, setOwnerKey] = useState("");
  const [profileId, setProfileId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [adapterKind, setAdapterKind] = useState<string>(SUPPORTED_ADAPTERS[0].kind);
  const [identityDigest, setIdentityDigest] = useState("");
  const [credentialReference, setCredentialReference] = useState("");
  const [metadataJson, setMetadataJson] = useState("");
  const [capabilities, setCapabilities] = useState<ArchitectureTargetCapabilities>({ "inventory.read": true, "health.read": true, "plan.read": true });
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<"name" | "owner" | "architecture" | "profile" | "environment" | "adapter" | "advanced" | null>(null);
  const architectureEpoch = useRef(0);
  const errorRef = useRef<HTMLDivElement>(null);

  const ownerOptions = useMemo(
    () => targetOwnerOptions(architectures, organizations),
    [architectures, organizations],
  );
  const selectedOwner = ownerOptions.find((option) => option.key === ownerKey);
  const ownerArchitectures = useMemo(
    () => architectures.filter((architecture) => architectureSupportsOwner(architecture, selectedOwner?.owner)).sort(compareArchitectureOptions),
    [architectures, selectedOwner],
  );
  const selectedArchitecture = useMemo(
    () => ownerArchitectures.find((architecture) => architecture.id === selectedArchitectureId) ?? null,
    [ownerArchitectures, selectedArchitectureId],
  );
  const selectedContext = useMemo(
    () => architectureContextFor(selectedArchitectureDetail),
    [selectedArchitectureDetail],
  );
  const profileOptions = useMemo(
    () => [...(selectedContext?.profiles ?? [])].sort(compareProfileOptions),
    [selectedContext?.profiles],
  );
  const environmentOptions = useMemo(
    () => [...(selectedContext?.environments.filter((environment) => environment.profileId === profileId) ?? [])].sort(compareEnvironmentOptions),
    [profileId, selectedContext?.environments],
  );
  const selectedProfile = profileOptions.find((profile) => profile.id === profileId);
  const selectedEnvironment = environmentOptions.find((environment) => environment.id === environmentId);
  const selectedAdapter = SUPPORTED_ADAPTERS.find((adapter) => adapter.kind === adapterKind) ?? SUPPORTED_ADAPTERS[0];

  useEffect(() => {
    let cancelled = false;
    setArchitectureState("loading");
    setArchitectureMessage(null);
    void (async () => {
      try {
        const rows = await client.listArchitectures();
        if (cancelled) return;
        setArchitectures(rows);
        let visibleOrganizations: Array<{ id: string; name: string; role?: string }> = [];
        if (client.listOrganizations) {
          try {
            const orgs = await client.listOrganizations();
            visibleOrganizations = orgs.map((organization) => ({ id: organization.id, name: organization.name, role: organization.role }));
            if (!cancelled) setOrganizations(visibleOrganizations);
          } catch {
            // Organization names improve the selector, but architecture-owner
            // registration remains usable if the optional list is unavailable.
          }
        }
        if (!cancelled) {
          setArchitectureState("ready");
          onLoaded(rows, visibleOrganizations);
        }
      } catch (error) {
        if (cancelled) return;
        setArchitectures([]);
        setArchitectureState("error");
        setArchitectureMessage(safeArchitectureErrorMessage(error));
      }
    })();
    return () => { cancelled = true; };
  }, [client, onLoaded]);

  useEffect(() => {
    const architectureId = selectedArchitectureId;
    if (!architectureId || architectureState !== "ready") {
      setSelectedArchitectureDetail(null);
      setDetailState("ready");
      setDetailMessage(null);
      return;
    }
    const requestEpoch = architectureEpoch.current + 1;
    architectureEpoch.current = requestEpoch;
    setSelectedArchitectureDetail(null);
    setDetailState("loading");
    setDetailMessage(null);
    void client.getArchitecture(architectureId).then((detail) => {
      if (requestEpoch !== architectureEpoch.current) return;
      setSelectedArchitectureDetail(detail);
      setDetailState("ready");
    }).catch((error: unknown) => {
      if (requestEpoch !== architectureEpoch.current) return;
      setSelectedArchitectureDetail(null);
      setDetailState("error");
      setDetailMessage(safeArchitectureErrorMessage(error));
    });
  }, [architectureState, client, selectedArchitectureId]);

  useEffect(() => {
    setOwnerKey((current) => ownerOptions.some((option) => option.key === current) ? current : preferredOwnerKey(ownerOptions, session.user.id));
  }, [ownerOptions, session.user.id]);

  useEffect(() => {
    setSelectedArchitectureId((current) => ownerArchitectures.some((architecture) => architecture.id === current) ? current : ownerArchitectures[0]?.id ?? "");
  }, [ownerArchitectures]);

  useEffect(() => {
    setProfileId((current) => profileOptions.some((profile) => profile.id === current) ? current : preferredProfileId(profileOptions, selectedOwner?.owner));
  }, [profileOptions, selectedOwner]);

  useEffect(() => {
    setEnvironmentId((current) => environmentOptions.some((environment) => environment.id === current) ? current : preferredEnvironmentId(environmentOptions, selectedOwner?.owner));
  }, [environmentOptions, selectedOwner]);

  useEffect(() => {
    if (state === "error") errorRef.current?.focus();
  }, [message, state]);

  function retryArchitectureDetail() {
    if (!selectedArchitectureId) return;
    const requestEpoch = architectureEpoch.current + 1;
    architectureEpoch.current = requestEpoch;
    setDetailState("loading");
    setDetailMessage(null);
    void client.getArchitecture(selectedArchitectureId).then((detail) => {
      if (requestEpoch !== architectureEpoch.current) return;
      setSelectedArchitectureDetail(detail);
      setDetailState("ready");
    }).catch((error: unknown) => {
      if (requestEpoch !== architectureEpoch.current) return;
      setSelectedArchitectureDetail(null);
      setDetailState("error");
      setDetailMessage(safeArchitectureErrorMessage(error));
    });
  }

  function setFormError(field: typeof errorField, text: string) {
    setErrorField(field);
    setState("error");
    setMessage(text);
  }

  function clearFieldError() {
    if (state === "error") {
      setState("idle");
      setMessage(null);
      setErrorField(null);
    }
  }

  function toggleCapability(key: keyof ArchitectureTargetCapabilities, enabled: boolean) {
    setCapabilities((current) => ({ ...current, [key]: enabled }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client.registerArchitectureTarget) {
      setFormError(null, "Target registration is not available in this workspace yet.");
      return;
    }
    if (!name.trim()) {
      setFormError("name", "Enter a name for this connected target.");
      return;
    }
    if (architectureState !== "ready" || !selectedArchitecture) {
      setFormError("architecture", "Select an available architecture before registering the target.");
      return;
    }
    if (detailState !== "ready" || !selectedContext || !selectedArchitectureDetail?.latestRevision || selectedArchitectureDetail.latestRevision.id !== selectedArchitectureDetail.currentRevisionId) {
      setFormError("architecture", "The current architecture revision is not ready. Retry the architecture details before registering.");
      return;
    }
    if (!selectedOwner) {
      setFormError("owner", "Select the server-authorized owner context before registering the target.");
      return;
    }
    if (!selectedProfile) {
      setFormError("profile", "Select a profile from the current architecture revision.");
      return;
    }
    if (!selectedEnvironment) {
      setFormError("environment", "Select a logical environment bound to the selected profile.");
      return;
    }
    if (!selectedAdapter) {
      setFormError("adapter", "Select a supported adapter.");
      return;
    }
    let metadata: ArchitectureTargetMetadata | undefined;
    if (metadataJson.trim()) {
      try {
        const parsed: unknown = JSON.parse(metadataJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("metadata must be an object");
        metadata = parsed as ArchitectureTargetMetadata;
      } catch {
        setFormError("advanced", "Metadata must be a valid JSON object with bounded values.");
        return;
      }
    }
    setState("saving");
    setMessage(null);
    try {
      const target = await client.registerArchitectureTarget({
        name: name.trim(),
        owner: selectedOwner.owner,
        architectureId: selectedArchitecture.id,
        environmentId: selectedEnvironment.id,
        profileId: selectedProfile.id,
        adapter: { kind: selectedAdapter.kind, version: selectedAdapter.version, contractVersion: selectedAdapter.contractVersion },
        capabilities,
        ...(identityDigest.trim() ? { identityDigest: identityDigest.trim() } : {}),
        ...(credentialReference.trim() ? { credentialReference: credentialReference.trim() } : {}),
        ...(metadata ? { metadata } : {}),
      });
      setName("");
      setIdentityDigest("");
      setCredentialReference("");
      setMetadataJson("");
      setState("idle");
      onRegistered(target);
    } catch (error) {
      setFormError(null, safeArchitectureTargetErrorMessage(error));
    }
  }

  return <section className="target-register" aria-labelledby="target-register-heading"><div className="cp-title-block"><h2 id="target-register-heading">Register read-only target</h2><p className="cp-meta">Register a read-only observer against an architecture, profile, and logical environment. To install and update skills, enroll a Codex workspace with the CLI setup guide instead.</p></div><form className="control-plane-form target-register-form" onSubmit={(event) => void submit(event)}>
    <label><span>Name</span><Input ref={nameRef} aria-invalid={errorField === "name"} aria-label="Target name" aria-describedby={message && errorField === "name" ? "target-registration-error" : undefined} disabled={state === "saving"} onChange={(event) => { setName(event.target.value); clearFieldError(); }} placeholder="Personal Codex" value={name} /></label>
    <fieldset className="target-capability-fieldset"><legend>1. Owner context</legend><p className="control-plane-muted">Choose a server-authorized architecture owner or organization sharing scope. The next selector shows only architectures available through that context. IDs are not entered manually.</p><label><span>Authorized owner</span><select aria-invalid={errorField === "owner"} aria-label="Authorized target owner" disabled={state === "saving" || ownerOptions.length === 0} onChange={(event) => { setOwnerKey(event.target.value); clearFieldError(); }} value={ownerKey}><option value="">Select an owner context</option>{ownerOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>{selectedOwner && <p className="control-plane-muted">{selectedOwner.detail}</p>}</fieldset>
    <fieldset className="target-capability-fieldset"><legend>2. Architecture context</legend><label><span>Architecture</span><select aria-invalid={errorField === "architecture"} aria-label="Target architecture" disabled={state === "saving" || architectureState !== "ready" || !selectedOwner} onChange={(event) => { setSelectedArchitectureId(event.target.value); clearFieldError(); }} value={selectedArchitectureId}><option value="">Select an architecture</option>{ownerArchitectures.map((architecture) => <option key={architecture.id} value={architecture.id}>{architecture.name} · {targetPatternLabel(architecture.patternId)} · {architectureRevisionLabel(architecture)}</option>)}</select></label>{architectureState === "loading" && <p className="control-plane-muted" role="status">Loading architectures…</p>}{architectureState === "error" && <div className="safe-message control-plane-inline-message" id="target-architecture-error" role="alert" tabIndex={-1}>{architectureMessage ?? "Architecture data is unavailable."}<Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => { setArchitectureState("loading"); setArchitectureMessage(null); setArchitectures([]); void client.listArchitectures().then((rows) => { setArchitectures(rows); setArchitectureState("ready"); onLoaded(rows, organizations); }).catch((error: unknown) => { setArchitectureState("error"); setArchitectureMessage(safeArchitectureErrorMessage(error)); }); }}><RefreshCw size={15} aria-hidden="true" />Retry</Button></div>}{detailState === "loading" && <p className="control-plane-muted" role="status">Loading current revision…</p>}{detailState === "error" && <div className="safe-message control-plane-inline-message" id="target-detail-error" role="alert" tabIndex={-1}>{detailMessage ?? "Current revision is unavailable."}<Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={retryArchitectureDetail}><RefreshCw size={15} aria-hidden="true" />Retry</Button></div>}{selectedContext && <p className="control-plane-muted">Current revision {selectedContext.revisionNumber} is ready. Its digest is available under Advanced settings.</p>}</fieldset>
    <fieldset className="target-capability-fieldset"><legend>3. Logical environment</legend><div className="control-plane-form-grid"><label><span>Profile</span><select aria-invalid={errorField === "profile"} aria-label="Target profile" disabled={state === "saving" || !selectedContext} onChange={(event) => { setProfileId(event.target.value); clearFieldError(); }} value={profileId}><option value="">Select a profile</option>{profileOptions.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><label><span>Environment</span><select aria-invalid={errorField === "environment"} aria-label="Target logical environment" disabled={state === "saving" || !selectedProfile} onChange={(event) => { setEnvironmentId(event.target.value); clearFieldError(); }} value={environmentId}><option value="">Select a logical environment</option>{environmentOptions.map((environment) => <option key={environment.id} value={environment.id}>{environment.name} · {environment.kind}</option>)}</select></label></div><p className="control-plane-muted">These are logical architecture environments. User-owned targets prefer a matching user profile and personal environment; team-owned targets prefer a matching team profile and team environment. If that preference is unavailable, the stable name then ID order is used. Your explicit selections remain authoritative.</p></fieldset>
    <fieldset className="target-capability-fieldset"><legend>4. Adapter</legend><label><span>Adapter</span><select aria-invalid={errorField === "adapter"} aria-label="Target adapter" disabled={state === "saving"} onChange={(event) => { setAdapterKind(event.target.value); clearFieldError(); }} value={adapterKind}>{SUPPORTED_ADAPTERS.map((adapter) => <option key={adapter.kind} value={adapter.kind}>{adapter.label}</option>)}</select></label><p className="control-plane-muted">Contract version {selectedAdapter.contractVersion} · adapter version {selectedAdapter.version}. This observer cannot execute installs, updates, or rollbacks. Use the CLI workspace enrollment guide for those actions.</p></fieldset>
    <section className="cp-summary" aria-labelledby="target-registration-summary-heading"><div className="cp-section-head"><h3 id="target-registration-summary-heading">Binding and consent summary</h3><span className="cp-chip" data-tone="amber">Consent pending</span></div><dl className="cp-facts"><div><dt>Owner</dt><dd>{selectedOwner?.label ?? "Select owner context"}</dd></div><div><dt>Architecture</dt><dd>{selectedArchitecture ? `${selectedArchitecture.name}${selectedContext ? `, current revision ${selectedContext.revisionNumber}` : ""}` : "Select architecture"}</dd></div><div><dt>Profile</dt><dd>{selectedProfile?.name ?? "Select profile"}</dd></div><div><dt>Logical environment</dt><dd>{selectedEnvironment?.name ?? "Select environment"}</dd></div><div><dt>Adapter</dt><dd>{selectedAdapter.label}</dd></div></dl><p className="control-plane-muted">Registration creates a pending target. Grant consent only after confirming the adapter and exact binding.</p></section>
    <fieldset className="target-capability-fieldset"><legend>Capabilities</legend>{READ_CAPABILITY_OPTIONS.map((option) => <label className="control-plane-checkbox" key={option.key}><input checked={capabilities[option.key] === true} disabled={state === "saving"} type="checkbox" onChange={(event) => toggleCapability(option.key, event.target.checked)} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}</fieldset>
    <details className="target-advanced-settings"><summary>Advanced target settings</summary><p className="control-plane-muted">Use these only when you have an approved opaque value. Secrets and machine paths are not rendered after save.</p><div className="control-plane-form"><label><span>Current revision digest <small>(read-only, computed from the selected spec)</small></span><Input aria-label="Current revision digest" readOnly value={selectedContext?.revisionDigest ?? ""} /></label><label><span>Target identity digest <small>(optional opaque SHA-256)</small></span><Input aria-label="Target identity digest" disabled={state === "saving"} onChange={(event) => { setIdentityDigest(event.target.value); clearFieldError(); }} placeholder="64 lowercase hex characters" value={identityDigest} /></label><label><span>Credential reference <small>(write-only opaque reference)</small></span><Input aria-label="Credential reference" autoComplete="off" disabled={state === "saving"} onChange={(event) => { setCredentialReference(event.target.value); clearFieldError(); }} placeholder="Opaque secret-store reference" type="password" value={credentialReference} /></label><label><span>Freeform metadata <small>(optional JSON; keys only are shown after save)</small></span><textarea aria-label="Target metadata JSON" disabled={state === "saving"} onChange={(event) => { setMetadataJson(event.target.value); clearFieldError(); }} placeholder='{"label":"personal"}' value={metadataJson} /></label></div></details>
    {message && <div className="control-plane-inline-message" id="target-registration-error" ref={errorRef} role="alert" tabIndex={-1}>{message}</div>}
    <div className="cp-actions"><Button disabled={state === "saving" || architectureState !== "ready" || detailState !== "ready"} size="sm" type="submit"><Plus size={15} aria-hidden="true" />{state === "saving" ? "Registering…" : "Register target"}</Button><Button disabled={state === "saving"} size="sm" type="button" variant="outline" onClick={onCancel}>Cancel</Button></div>
  </form></section>;
}

function TargetDetailPanel({ client, detail, observations, state, message, selectedId, currentUserId, architectureNames, organizationNames, titleRef, onBack, onRefresh }: {
  client: RegistryClient;
  detail: ArchitectureTargetRecord | null;
  observations: ArchitectureTargetObservationRecord[];
  state: LoadState;
  message: string | null;
  selectedId: string | null;
  currentUserId: string;
  architectureNames: ReadonlyMap<string, string>;
  organizationNames: ReadonlyMap<string, string>;
  titleRef: RefObject<HTMLHeadingElement | null>;
  onBack?: () => void;
  onRefresh: () => void;
}) {
  const back = onBack && <Button className="cp-back" type="button" variant="ghost" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />Back to targets</Button>;
  if (!detail && state === "loading") return <div className="cp-detail">{back}<TargetLoadingRows /></div>;
  if (!detail && state === "error") return <div className="cp-detail">{back}<div className="cp-inspector-state" role="alert"><CircleAlert size={18} aria-hidden="true" /><div><strong>{message ?? "The connected target detail is unavailable."}</strong><p>The selected target could not load. Retry the request or choose a different target.</p><div className="cp-actions"><Button size="sm" type="button" variant="outline" onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" />Retry</Button></div></div></div></div>;
  // Details render only for the loaded selection, never from a stale response.
  if (!detail || detail.id !== selectedId) return <div className="cp-detail">{back}<p className="cp-inspector-empty">Choose a registered target to inspect its exact binding, consent, health, and bounded observations.</p></div>;
  const status = targetStatusLabel(detail.status);
  const consent = consentLabel(detail.consent.status);
  return <article className="cp-detail" aria-labelledby="target-detail-title">
    <header className="cp-detail-head">
      {back}
      <div className="cp-title-block">
        <h2 id="target-detail-title" ref={titleRef} tabIndex={-1}>{detail.name}</h2>
        <p className="cp-meta">{adapterLabel(detail.adapter.kind)} · adapter v{detail.adapter.version} · contract v{detail.adapter.contractVersion}</p>
        <div className="cp-chips"><span className="cp-chip" data-tone={toneOf(status)}>{status.label}</span><span className="cp-chip" data-tone={toneOf(consent)}>{consent.label}</span></div>
      </div>
    </header>
    {state === "loading" && <TargetLoadingRows />}
    {state === "error" && message && <div className="cp-notice" data-tone="danger" role="alert">{message}<Button size="sm" type="button" variant="outline" onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" />Retry</Button></div>}
    {state === "ready" && <div className="cp-detail-body" key={detail.id}>
      <TargetBindingFacts target={detail} currentUserId={currentUserId} architectureNames={architectureNames} organizationNames={organizationNames} />
      <TargetConsentCard client={client} target={detail} onChanged={onRefresh} />
      <TargetObservationCard target={detail} observations={observations} />
      <TargetHealthCard client={client} target={detail} onChanged={onRefresh} />
      <TargetRevokeCard client={client} target={detail} onRevoked={onRefresh} />
    </div>}
  </article>;
}

function TargetBindingFacts({ target, currentUserId, architectureNames, organizationNames }: { target: ArchitectureTargetRecord; currentUserId: string; architectureNames: ReadonlyMap<string, string>; organizationNames: ReadonlyMap<string, string> }) {
  const metadataKeys = Object.keys(target.metadata ?? {}).sort();
  const mutable = target.adapter.contractVersion === 2;
  const capabilities = [
    ...READ_CAPABILITY_OPTIONS.filter((option) => target.capabilities[option.key]).map((option) => option.label),
    ...(mutable && target.capabilities.apply ? ["Apply"] : []),
    ...(mutable && target.capabilities.rollback ? ["Rollback"] : []),
  ];
  const architectureName = architectureNames.get(target.architectureId);
  return <section className="cp-section" aria-labelledby="target-binding-heading">
    <h3 id="target-binding-heading">Binding</h3>
    <dl className="cp-facts">
      <div><dt>Owner</dt><dd>{ownerLabel(target.owner, currentUserId, organizationNames)}</dd></div>
      <div><dt>Architecture</dt>{architectureName ? <dd>{architectureName}</dd> : <dd className="cp-mono">{shortId(target.architectureId)}</dd>}</div>
      <div><dt>Profile ID</dt><dd className="cp-mono">{target.profileId}</dd></div>
      <div><dt>Environment ID</dt><dd className="cp-mono">{target.environmentId}</dd></div>
      <div><dt>Health</dt><dd>{healthLabel(target.health?.status).label}</dd></div>
      <div><dt>Generation</dt><dd>{target.generation}</dd></div>
      <div><dt>Identity</dt><dd className="cp-mono">{target.identityDigest ? `${target.identityDigest.slice(0, 12)}…` : "None"}</dd></div>
      <div><dt>Metadata keys</dt><dd>{metadataKeys.length ? metadataKeys.join(", ") : "None"}</dd></div>
      <div><dt>Capabilities</dt><dd>{capabilities.join(", ") || "None"} · {mutable ? "Mutation requires consent and companion claim fencing." : "This target is read-only."}</dd></div>
    </dl>
    <p className="cp-footnote"><ShieldCheck size={14} aria-hidden="true" /> Target access is separate from architecture ownership and organization membership.</p>
  </section>;
}

function TargetConsentCard({ client, target, onChanged }: { client: RegistryClient; target: ArchitectureTargetRecord; onChanged: () => void }) {
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  async function setConsent(decision: "grant" | "deny") {
    if (!client.setArchitectureTargetConsent || target.status === "revoked") return;
    setState("saving");
    setMessage(null);
    try {
      await client.setArchitectureTargetConsent(target.id, decision);
      setState("idle");
      onChanged();
    } catch (error) {
      setState("error");
      setMessage(safeArchitectureTargetErrorMessage(error));
    }
  }
  const consent = consentLabel(target.consent.status);
  const granted = target.consent.status === "granted";
  const denied = target.consent.status === "denied";
  const locked = state === "saving" || target.status === "revoked";
  // Keep the current decision disabled and denial visually secondary.
  return <section className="cp-section" aria-labelledby="target-consent-heading"><div className="cp-section-head"><h3 id="target-consent-heading">Consent</h3><span className="cp-chip" data-tone={toneOf(consent)}>{consent.label}</span></div><p className="cp-muted">Observation is available only after an explicit grant. Deny keeps the target registered but blocks observation.</p><div className="cp-actions"><Button disabled={locked || granted} size="sm" type="button" variant={granted ? "outline" : "default"} onClick={() => void setConsent("grant")}><Check size={15} aria-hidden="true" />Grant consent</Button><Button className="cp-danger-button" disabled={locked || denied} size="sm" type="button" variant="outline" onClick={() => void setConsent("deny")}><X size={15} aria-hidden="true" />Deny consent</Button></div>{message && <div className="cp-notice" data-tone={state === "error" ? "danger" : undefined} role={state === "error" ? "alert" : "status"}>{message}</div>}</section>;
}

function TargetHealthCard({ client, target, onChanged }: { client: RegistryClient; target: ArchitectureTargetRecord; onChanged: () => void }) {
  const [status, setStatus] = useState<ArchitectureTargetHealth["status"]>(target.health?.status ?? "unavailable");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => setStatus(target.health?.status ?? "unavailable"), [target.health?.status, target.id]);
  async function updateHealth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client.updateArchitectureTargetHealth || target.status === "revoked") return;
    setState("saving");
    setMessage(null);
    try {
      await client.updateArchitectureTargetHealth(target.id, { status, checkedAt: new Date().toISOString() });
      setState("idle");
      onChanged();
    } catch (error) {
      setState("error");
      setMessage(safeArchitectureTargetErrorMessage(error));
    }
  }
  return <section className="cp-section" aria-labelledby="target-health-heading"><details className="cp-details"><summary id="target-health-heading">Report health manually</summary><div className="cp-details-body"><p className="cp-muted">Current health: {healthLabel(target.health?.status).label}. A manual report replaces it until the adapter reports again.</p><form className="target-health-form" onSubmit={(event) => void updateHealth(event)}><label><span>Reported state</span><select aria-label="Target health status" disabled={state === "saving" || target.status === "revoked"} onChange={(event) => setStatus(event.target.value as ArchitectureTargetHealth["status"])} value={status}><option value="healthy">Healthy</option><option value="degraded">Degraded</option><option value="unavailable">Unavailable</option></select></label><Button disabled={state === "saving" || target.status === "revoked"} size="sm" type="submit" variant="outline"><Activity size={15} aria-hidden="true" />{state === "saving" ? "Updating…" : "Update health"}</Button></form>{message && <div className="cp-notice" data-tone={state === "error" ? "danger" : undefined} role={state === "error" ? "alert" : "status"}>{message}</div>}</div></details></section>;
}

function TargetObservationCard({ target, observations }: { target: ArchitectureTargetRecord; observations: ArchitectureTargetObservationRecord[] }) {
  return <section className="cp-section" aria-labelledby="target-observations-heading"><div className="cp-section-head"><h3 id="target-observations-heading">Observations</h3><span className="cp-muted">{observations.length} recent</span></div><p className="cp-muted">Only bounded counts and status metadata are shown here. Configuration contents, paths, prompts, and credentials are never rendered.</p>{observations.length > 0 ? <div className="target-observation-list">{observations.map((observation) => <div className="target-observation-row" key={observation.id ?? observation.observedDigest}><Eye size={16} aria-hidden="true" /><span><strong>{formatTargetDate(observation.observedAt)}</strong><small>{observation.skills.length} skills · {observation.configFindings.length} config findings · prompt detected: {observation.promptAwareness.detected ? "yes" : "no"}</small></span><span className="cp-chip">Generation {observation.targetGeneration}</span></div>)}</div> : <p className="cp-muted"><strong>No observations yet.</strong> {target.consent.status === "granted" ? "A read-only adapter can report bounded state after consent." : "Grant consent before an adapter can report state."}</p>}</section>;
}

function TargetRevokeCard({ client, target, onRevoked }: { client: RegistryClient; target: ArchitectureTargetRecord; onRevoked: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function revoke() {
    if (!client.revokeArchitectureTarget || target.status === "revoked") return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setMessage(null);
    try {
      await client.revokeArchitectureTarget(target.id);
      setConfirm(false);
      onRevoked();
    } catch (error) {
      setMessage(safeArchitectureTargetErrorMessage(error));
    }
  }
  return <section className="cp-section target-revoke-section" aria-labelledby="target-revoke-heading"><div className="cp-section-head"><h3 id="target-revoke-heading">Revoke connected target</h3></div><p className="cp-muted">Revocation blocks consent changes, health updates, and future observations. The target remains visible to authorized readers as audit history.</p>{target.status === "revoked" ? <div className="cp-chips"><span className="cp-chip" data-tone="danger">Revoked</span></div> : <>{confirm && <p className="cp-notice" data-tone="danger" role="alert">This is permanent for the target binding. Confirm only if you intend to stop future observations.</p>}<div className="cp-actions"><Button className="cp-danger-button" size="sm" type="button" variant={confirm ? "destructive" : "outline"} onClick={() => void revoke()}><Trash2 size={15} aria-hidden="true" />{confirm ? "Confirm revoke" : "Revoke target"}</Button>{confirm && <Button size="sm" type="button" variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>}</div></>}{message && <div className="cp-notice" data-tone="danger" role="alert">{message}</div>}</section>;
}

function TargetLoadingRows() {
  return <div className="control-plane-loading" role="status" aria-live="polite"><span className="sr-only">Loading connected targets…</span><span /><span /><span className="short" /></div>;
}

function formatTargetDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown date" : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
