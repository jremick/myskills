import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity,
  Check,
  CircleAlert,
  Eye,
  Link2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  { kind: "codex-readonly", version: "1", label: "Codex · read-only adapter" },
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
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);

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
      setTargets(nextTargets);
      setSelectedId((current) => current && nextTargets.some((item) => item.id === current) ? current : nextTargets[0]?.id ?? null);
      setState("ready");
    } catch (error) {
      if (requestEpoch !== listEpoch.current) return;
      setTargets([]);
      setSelectedId(null);
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
    if (isCurrent) {
      // Selecting the active row again is an explicit refresh. Without this
      // branch, React keeps the same ID and no effect would refetch detail.
      void refreshDetail(targetId);
    }
  }, [refreshDetail, selectedId]);

  useEffect(() => {
    if (!selectedId || state !== "ready") {
      setDetail(null);
      setObservations([]);
      setDetailState("ready");
      return;
    }
    void refreshDetail(selectedId);
  }, [refreshDetail, selectedId, state]);

  return <main className="control-plane-workspace target-workspace" aria-label="Connected targets">
    <section className="control-plane-hero" aria-labelledby="targets-heading">
      <div><p className="control-plane-kicker">Physical runtime boundaries</p><h1 id="targets-heading">Connected targets</h1><p>{session.user.email} · {state === "loading" ? "Refreshing target access…" : `${targets.length} registered targets`}</p></div>
      <Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={16} aria-hidden="true" />Refresh</Button>
    </section>
    {message && <div className="safe-message control-plane-message" role="alert" tabIndex={-1}>{message}</div>}
    <section className="target-layout">
      <div className="target-sidebar">
        <RegisterTargetCard client={client} session={session} onRegistered={(target) => { setSelectedId(target.id); setRefreshKey((value) => value + 1); }} />
        <Card className="control-plane-card" aria-label="Connected target list">
          <CardHeader className="control-plane-card-heading"><div className="control-plane-card-icon"><Link2 size={17} aria-hidden="true" /></div><div><CardTitle>Registered targets</CardTitle><CardDescription>Each target is bound to one architecture, profile, and logical environment.</CardDescription></div></CardHeader>
          <CardContent className="target-list-content">
            {state === "loading" && <TargetLoadingRows />}
            {state === "error" && <TargetEmptyState icon={<CircleAlert size={22} aria-hidden="true" />} title="Targets unavailable" copy="Retry when the target service is ready." action={<Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" />Retry</Button>} />}
            {state === "ready" && targets.length === 0 && <TargetEmptyState icon={<Link2 size={22} aria-hidden="true" />} title="No connected targets" copy="Register a read-only adapter target to inspect its bounded state." />}
            {state === "ready" && targets.length > 0 && <div className="target-list" role="list">{targets.map((target) => <div key={target.id} role="listitem"><button aria-current={target.id === selectedId ? "true" : undefined} aria-pressed={target.id === selectedId} className={target.id === selectedId ? "target-list-row selected" : "target-list-row"} type="button" onClick={() => selectTarget(target.id)}><span className="target-list-icon"><Activity size={15} aria-hidden="true" /></span><span className="target-list-main"><strong>{target.name}</strong><small>{target.adapter.kind} · {target.owner.type} · {target.consent.status}</small></span><Badge variant={target.status === "connected" ? "secondary" : target.status === "revoked" ? "destructive" : "outline"}>{target.status}</Badge></button></div>)}</div>}
          </CardContent>
        </Card>
      </div>
      <TargetDetailPanel client={client} detail={detail} observations={observations} state={detailState} message={detailMessage} onRefresh={() => selectedId && void refreshDetail(selectedId)} />
    </section>
  </main>;
}

function RegisterTargetCard({ client, session, onRegistered }: { client: RegistryClient; session: TargetSession; onRegistered: (target: ArchitectureTargetRecord) => void }) {
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
        if (client.listOrganizations) {
          try {
            const orgs = await client.listOrganizations();
            if (!cancelled) setOrganizations(orgs.map((organization) => ({ id: organization.id, name: organization.name, role: organization.role })));
          } catch {
            // Organization names improve the selector, but architecture-owner
            // registration remains usable if the optional list is unavailable.
          }
        }
        if (!cancelled) setArchitectureState("ready");
      } catch (error) {
        if (cancelled) return;
        setArchitectures([]);
        setArchitectureState("error");
        setArchitectureMessage(safeArchitectureErrorMessage(error));
      }
    })();
    return () => { cancelled = true; };
  }, [client]);

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
      setFormError("adapter", "Select a supported read-only adapter.");
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
        adapter: { kind: selectedAdapter.kind, version: selectedAdapter.version, contractVersion: 1 },
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

  return <Card className="control-plane-card" aria-label="Register connected target"><CardHeader className="control-plane-card-heading"><div className="control-plane-card-icon"><Plus size={17} aria-hidden="true" /></div><div><CardTitle>Register connected target</CardTitle><CardDescription>Choose a server-authorized owner, then bind a read-only adapter to the current architecture revision, profile, and logical environment. No target can apply or write changes.</CardDescription></div></CardHeader><CardContent><form className="control-plane-form target-register-form" onSubmit={(event) => void submit(event)}>
    <label><span>Name</span><Input aria-invalid={errorField === "name"} aria-label="Target name" aria-describedby={message && errorField === "name" ? "target-registration-error" : undefined} disabled={state === "saving"} onChange={(event) => { setName(event.target.value); clearFieldError(); }} placeholder="Personal Codex" value={name} /></label>
    <fieldset className="target-capability-fieldset"><legend>1. Owner context</legend><p className="control-plane-muted">Choose a server-authorized architecture owner or organization sharing scope. The next selector shows only architectures available through that context. IDs are not entered manually.</p><label><span>Authorized owner</span><select aria-invalid={errorField === "owner"} aria-label="Authorized target owner" disabled={state === "saving" || ownerOptions.length === 0} onChange={(event) => { setOwnerKey(event.target.value); clearFieldError(); }} value={ownerKey}><option value="">Select an owner context</option>{ownerOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>{selectedOwner && <p className="control-plane-muted">{selectedOwner.detail}</p>}</fieldset>
    <fieldset className="target-capability-fieldset"><legend>2. Architecture context</legend><label><span>Architecture</span><select aria-invalid={errorField === "architecture"} aria-label="Target architecture" disabled={state === "saving" || architectureState !== "ready" || !selectedOwner} onChange={(event) => { setSelectedArchitectureId(event.target.value); clearFieldError(); }} value={selectedArchitectureId}><option value="">Select an architecture</option>{ownerArchitectures.map((architecture) => <option key={architecture.id} value={architecture.id}>{architecture.name} · {targetPatternLabel(architecture.patternId)} · {architectureRevisionLabel(architecture)}</option>)}</select></label>{architectureState === "loading" && <p className="control-plane-muted" role="status">Loading architectures…</p>}{architectureState === "error" && <div className="safe-message control-plane-inline-message" id="target-architecture-error" role="alert" tabIndex={-1}>{architectureMessage ?? "Architecture data is unavailable."}<Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => { setArchitectureState("loading"); setArchitectureMessage(null); setArchitectures([]); void client.listArchitectures().then((rows) => { setArchitectures(rows); setArchitectureState("ready"); }).catch((error: unknown) => { setArchitectureState("error"); setArchitectureMessage(safeArchitectureErrorMessage(error)); }); }}><RefreshCw size={15} aria-hidden="true" />Retry</Button></div>}{detailState === "loading" && <p className="control-plane-muted" role="status">Loading current revision…</p>}{detailState === "error" && <div className="safe-message control-plane-inline-message" id="target-detail-error" role="alert" tabIndex={-1}>{detailMessage ?? "Current revision is unavailable."}<Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={retryArchitectureDetail}><RefreshCw size={15} aria-hidden="true" />Retry</Button></div>}{selectedContext && <p className="control-plane-muted">Current revision {selectedContext.revisionNumber} is ready. Its digest is available under Advanced settings.</p>}</fieldset>
    <fieldset className="target-capability-fieldset"><legend>3. Logical environment</legend><div className="control-plane-form-grid"><label><span>Profile</span><select aria-invalid={errorField === "profile"} aria-label="Target profile" disabled={state === "saving" || !selectedContext} onChange={(event) => { setProfileId(event.target.value); clearFieldError(); }} value={profileId}><option value="">Select a profile</option>{profileOptions.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><label><span>Environment</span><select aria-invalid={errorField === "environment"} aria-label="Target logical environment" disabled={state === "saving" || !selectedProfile} onChange={(event) => { setEnvironmentId(event.target.value); clearFieldError(); }} value={environmentId}><option value="">Select a logical environment</option>{environmentOptions.map((environment) => <option key={environment.id} value={environment.id}>{environment.name} · {environment.kind}</option>)}</select></label></div><p className="control-plane-muted">These are logical architecture environments. User-owned targets prefer a matching user profile and personal environment; team-owned targets prefer a matching team profile and team environment. If that preference is unavailable, the stable name then ID order is used. Your explicit selections remain authoritative.</p></fieldset>
    <fieldset className="target-capability-fieldset"><legend>4. Adapter</legend><label><span>Read-only adapter</span><select aria-invalid={errorField === "adapter"} aria-label="Target adapter" disabled={state === "saving"} onChange={(event) => { setAdapterKind(event.target.value); clearFieldError(); }} value={adapterKind}>{SUPPORTED_ADAPTERS.map((adapter) => <option key={adapter.kind} value={adapter.kind}>{adapter.label}</option>)}</select></label><p className="control-plane-muted">Contract version 1 · adapter version {selectedAdapter.version}. Adapter registration does not invoke the adapter.</p></fieldset>
    <section className="control-plane-section" aria-labelledby="target-registration-summary-heading"><div className="control-plane-section-heading"><div><p className="control-plane-kicker">Review before saving</p><h2 id="target-registration-summary-heading">Binding and consent summary</h2></div><Badge variant="outline">consent: pending</Badge></div><dl className="target-binding-grid"><div><dt>Owner</dt><dd>{selectedOwner?.label ?? "Select owner context"}</dd></div><div><dt>Architecture</dt><dd>{selectedArchitecture?.name ?? "Select architecture"}</dd></div><div><dt>Revision</dt><dd>{selectedContext ? `Current revision ${selectedContext.revisionNumber}` : "Select architecture"}</dd></div><div><dt>Profile</dt><dd>{selectedProfile?.name ?? "Select profile"}</dd></div><div><dt>Logical environment</dt><dd>{selectedEnvironment?.name ?? "Select environment"}</dd></div><div><dt>Adapter</dt><dd>{selectedAdapter.label}</dd></div></dl><p className="control-plane-muted">Registration creates a pending target. Grant consent only after confirming the adapter and exact binding.</p></section>
    <fieldset className="target-capability-fieldset"><legend>Read-only capabilities</legend>{READ_CAPABILITY_OPTIONS.map((option) => <label className="control-plane-checkbox" key={option.key}><input checked={capabilities[option.key] === true} disabled={state === "saving"} type="checkbox" onChange={(event) => toggleCapability(option.key, event.target.checked)} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}<p className="control-plane-muted">Apply, rollback, and sync.write are deliberately unavailable in v1.</p></fieldset>
    <details className="target-advanced-settings"><summary>Advanced target settings</summary><p className="control-plane-muted">Use these only when you have an approved opaque value. Secrets and machine paths are not rendered after save.</p><div className="control-plane-form"><label><span>Current revision digest <small>(read-only, computed from the selected spec)</small></span><Input aria-label="Current revision digest" readOnly value={selectedContext?.revisionDigest ?? ""} /></label><label><span>Target identity digest <small>(optional opaque SHA-256)</small></span><Input aria-label="Target identity digest" disabled={state === "saving"} onChange={(event) => { setIdentityDigest(event.target.value); clearFieldError(); }} placeholder="64 lowercase hex characters" value={identityDigest} /></label><label><span>Credential reference <small>(write-only opaque reference)</small></span><Input aria-label="Credential reference" autoComplete="off" disabled={state === "saving"} onChange={(event) => { setCredentialReference(event.target.value); clearFieldError(); }} placeholder="Opaque secret-store reference" type="password" value={credentialReference} /></label><label><span>Freeform metadata <small>(optional JSON; keys only are shown after save)</small></span><textarea aria-label="Target metadata JSON" disabled={state === "saving"} onChange={(event) => { setMetadataJson(event.target.value); clearFieldError(); }} placeholder='{"label":"personal"}' value={metadataJson} /></label></div></details>
    {message && <div className="control-plane-inline-message" id="target-registration-error" ref={errorRef} role="alert" tabIndex={-1}>{message}</div>}
    <Button className="shadcn-action-button" disabled={state === "saving" || architectureState !== "ready" || detailState !== "ready"} size="sm" type="submit"><Plus size={15} aria-hidden="true" />{state === "saving" ? "Registering…" : "Register target"}</Button>
  </form></CardContent></Card>;
}

function TargetDetailPanel({ client, detail, observations, state, message, onRefresh }: { client: RegistryClient; detail: ArchitectureTargetRecord | null; observations: ArchitectureTargetObservationRecord[]; state: LoadState; message: string | null; onRefresh: () => void }) {
  if (!detail && state === "loading") return <Card className="control-plane-card target-detail-card empty" aria-label="Connected target detail"><CardContent className="control-plane-empty-detail"><TargetLoadingRows /></CardContent></Card>;
  if (!detail && state === "error") return <Card className="control-plane-card target-detail-card empty" aria-label="Connected target detail"><CardContent className="control-plane-empty-detail"><div className="safe-message control-plane-message" role="alert"><CircleAlert size={24} aria-hidden="true" /><strong>{message ?? "The connected target detail is unavailable."}</strong><span>The selected target could not load. Retry the request or choose a different target.</span><Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" />Retry</Button></div></CardContent></Card>;
  if (!detail) return <Card className="control-plane-card target-detail-card empty" aria-label="Connected target detail"><CardContent className="control-plane-empty-detail"><Link2 size={42} aria-hidden="true" /><h2>Select a connected target</h2><p>Choose a registered target to inspect its exact binding, consent, health, and bounded observations.</p></CardContent></Card>;
  return <Card className="control-plane-card target-detail-card" aria-label={`Connected target detail: ${detail.name}`}><CardHeader className="control-plane-detail-header"><div><p className="control-plane-kicker">Target detail</p><CardTitle>{detail.name}</CardTitle><CardDescription>{detail.adapter.kind} v{detail.adapter.version} · contract v{detail.adapter.contractVersion}</CardDescription><p className="control-plane-context-note"><ShieldCheck size={15} aria-hidden="true" /> Target access is separate from architecture ownership and organization membership.</p></div><div className="control-plane-detail-actions"><Badge variant={detail.status === "connected" ? "secondary" : detail.status === "revoked" ? "destructive" : "outline"}>{detail.status}</Badge><Badge variant="outline">consent: {detail.consent.status}</Badge></div></CardHeader><CardContent className="control-plane-detail-content">
    {state === "loading" && <TargetLoadingRows />}
    {state === "error" && message && <div className="safe-message control-plane-message" role="alert">{message}<Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" />Retry</Button></div>}
    {state === "ready" && <><TargetBindingCard target={detail} /><TargetConsentCard client={client} target={detail} onChanged={onRefresh} /><TargetHealthCard client={client} target={detail} onChanged={onRefresh} /><TargetObservationCard target={detail} observations={observations} /><TargetRevokeCard client={client} target={detail} onRevoked={onRefresh} /></>}
  </CardContent></Card>;
}

function TargetBindingCard({ target }: { target: ArchitectureTargetRecord }) {
  const metadataKeys = Object.keys(target.metadata ?? {}).sort();
  return <section className="control-plane-section" aria-labelledby="target-binding-heading"><div className="control-plane-section-heading"><div><p className="control-plane-kicker">Exact binding</p><h2 id="target-binding-heading">Architecture context</h2></div><Badge variant="outline">generation {target.generation}</Badge></div><dl className="target-binding-grid"><div><dt>Owner</dt><dd>{target.owner.type} · {target.owner.id}</dd></div><div><dt>Architecture</dt><dd>{target.architectureId}</dd></div><div><dt>Logical environment</dt><dd>{target.environmentId}</dd></div><div><dt>Profile</dt><dd>{target.profileId}</dd></div><div><dt>Identity</dt><dd>{target.identityDigest.slice(0, 12)}…</dd></div><div><dt>Metadata keys</dt><dd>{metadataKeys.length ? metadataKeys.join(", ") : "None"}</dd></div></dl><div className="target-capability-summary"><strong>Advertised read capabilities</strong><div>{READ_CAPABILITY_OPTIONS.map((option) => <Badge key={option.key} variant={target.capabilities[option.key] ? "secondary" : "outline"}>{option.label}: {target.capabilities[option.key] ? "on" : "off"}</Badge>)}</div><span>Mutation capabilities are never displayed as enabled.</span></div></section>;
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
  return <section className="control-plane-section" aria-labelledby="target-consent-heading"><div className="control-plane-section-heading"><div><p className="control-plane-kicker">Explicit consent</p><h2 id="target-consent-heading">Consent state</h2></div><Badge variant={target.consent.status === "granted" ? "secondary" : "outline"}>{target.consent.status}</Badge></div><p className="control-plane-muted">Observation is available only after an explicit grant. Deny keeps the target registered but blocks observation.</p><div className="target-action-row"><Button className="shadcn-action-button" disabled={state === "saving" || target.status === "revoked"} size="sm" type="button" onClick={() => void setConsent("grant")}><Check size={15} aria-hidden="true" />Grant consent</Button><Button className="shadcn-action-button" disabled={state === "saving" || target.status === "revoked"} size="sm" type="button" variant="outline" onClick={() => void setConsent("deny")}><X size={15} aria-hidden="true" />Deny consent</Button></div>{message && <div className="control-plane-inline-message" role={state === "error" ? "alert" : "status"}>{message}</div>}</section>;
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
  return <section className="control-plane-section" aria-labelledby="target-health-heading"><div className="control-plane-section-heading"><div><p className="control-plane-kicker">Read-only status</p><h2 id="target-health-heading">Health</h2></div><Badge variant="outline">{target.health?.status ?? "not checked"}</Badge></div><form className="target-health-form" onSubmit={(event) => void updateHealth(event)}><label><span>Reported state</span><select aria-label="Target health status" disabled={state === "saving" || target.status === "revoked"} onChange={(event) => setStatus(event.target.value as ArchitectureTargetHealth["status"])} value={status}><option value="healthy">Healthy</option><option value="degraded">Degraded</option><option value="unavailable">Unavailable</option></select></label><Button className="shadcn-action-button" disabled={state === "saving" || target.status === "revoked"} size="sm" type="submit"><Activity size={15} aria-hidden="true" />{state === "saving" ? "Updating…" : "Update health"}</Button></form>{message && <div className="control-plane-inline-message" role={state === "error" ? "alert" : "status"}>{message}</div>}</section>;
}

function TargetObservationCard({ target, observations }: { target: ArchitectureTargetRecord; observations: ArchitectureTargetObservationRecord[] }) {
  return <section className="control-plane-section" aria-labelledby="target-observations-heading"><div className="control-plane-section-heading"><div><p className="control-plane-kicker">Metadata-only readback</p><h2 id="target-observations-heading">Observations</h2></div><span>{observations.length} recent</span></div><p className="control-plane-muted">Only bounded counts and status metadata are shown here. Configuration contents, paths, prompts, and credentials are never rendered.</p><div className="target-observation-list">{observations.map((observation) => <div className="target-observation-row" key={observation.id ?? observation.observedDigest}><Eye size={16} aria-hidden="true" /><span><strong>{formatTargetDate(observation.observedAt)}</strong><small>{observation.skills.length} skills · {observation.configFindings.length} config findings · prompt detected: {observation.promptAwareness.detected ? "yes" : "no"}</small></span><Badge variant="outline">generation {observation.targetGeneration}</Badge></div>)}{observations.length === 0 && <div className="control-plane-empty-state"><Eye size={22} aria-hidden="true" /><strong>No observations yet</strong><span>{target.consent.status === "granted" ? "A read-only adapter can report bounded state after consent." : "Grant consent before an adapter can report state."}</span></div>}</div></section>;
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
  return <section className="control-plane-section target-revoke-section" aria-labelledby="target-revoke-heading"><div className="control-plane-section-heading"><div><p className="control-plane-kicker">Terminal action</p><h2 id="target-revoke-heading">Revoke connected target</h2></div></div><p className="control-plane-muted">Revocation blocks consent changes, health updates, and future observations. The target remains visible to authorized readers as audit history.</p>{target.status === "revoked" ? <Badge variant="destructive">Revoked</Badge> : <div className="target-action-row">{confirm && <p className="control-plane-muted" role="alert">This is permanent for the target binding. Confirm only if you intend to stop future observations.</p>}<Button className="shadcn-action-button" size="sm" type="button" variant={confirm ? "destructive" : "outline"} onClick={() => void revoke()}><Trash2 size={15} aria-hidden="true" />{confirm ? "Confirm revoke" : "Revoke target"}</Button>{confirm && <Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>}</div>}{message && <div className="control-plane-inline-message" role="alert">{message}</div>}</section>;
}

function TargetEmptyState({ icon, title, copy, action }: { icon: ReactNode; title: string; copy: string; action?: ReactNode }) {
  return <div className="control-plane-empty-state">{icon}<strong>{title}</strong><span>{copy}</span>{action}</div>;
}

function TargetLoadingRows() {
  return <div className="control-plane-loading" role="status" aria-live="polite"><span className="sr-only">Loading connected targets…</span><span /><span /><span className="short" /></div>;
}

function formatTargetDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown date" : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
