import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleAlert,
  Clipboard,
  GitBranch,
  Layers3,
  Network,
  Plus,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  safeArchitectureErrorMessage,
  type ArchitectureObservedFixture,
  type ArchitectureDetail,
  type ArchitectureEnvironment,
  type ArchitecturePattern,
  type ArchitecturePatternId,
  type ArchitecturePreview,
  type ArchitecturePreviewPlan,
  type ArchitectureProfile,
  type ArchitectureSummary,
  type ArchitectureTopologyEdge,
  type ArchitectureTopologyNode,
  type RegistryClient,
} from "../../api.js";

interface WebSessionLike {
  user: {
    email: string;
  };
}

type ArchitectureLoadState = "loading" | "ready" | "error" | "unsupported";

const BUILTIN_PATTERNS: ArchitecturePattern[] = [
  {
    id: "flat",
    name: "Flat library",
    description: "Expose a curated set of skills from one predictable entry point.",
    supportsNestedRouters: false,
    status: "available",
  },
  {
    id: "domain-router",
    name: "Domain router",
    description: "Route requests through domain-specific branches before selecting a leaf skill.",
    supportsNestedRouters: false,
    status: "available",
  },
  {
    id: "multi-level-router",
    name: "Multi-level router",
    description: "Compose router, sub-router, and leaf skills for larger skill libraries.",
    supportsNestedRouters: true,
    status: "available",
  },
];

export function ArchitecturesDashboard({ client, session }: { client: RegistryClient; session: WebSessionLike }) {
  const [loadState, setLoadState] = useState<ArchitectureLoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [patterns, setPatterns] = useState<ArchitecturePattern[]>(BUILTIN_PATTERNS);
  const [architectures, setArchitectures] = useState<ArchitectureSummary[]>([]);
  const [profiles, setProfiles] = useState<ArchitectureProfile[]>([]);
  const [environments, setEnvironments] = useState<ArchitectureEnvironment[]>([]);
  const [selectedArchitectureId, setSelectedArchitectureId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>("");
  const [selectedDetail, setSelectedDetail] = useState<ArchitectureDetail | null>(null);
  const [preview, setPreview] = useState<ArchitecturePreview | null>(null);
  const [detailState, setDetailState] = useState<ArchitectureLoadState>("ready");
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const fixturePreviewEpoch = useRef(0);
  const previewContextRef = useRef("");

  const refresh = useCallback(async () => {
    setLoadState("loading");
    setMessage(null);
    try {
      const [nextPatterns, nextArchitectures] = await Promise.all([
        client.listArchitecturePatterns(),
        client.listArchitectures(),
      ]);
      setPatterns(nextPatterns.length > 0 ? nextPatterns : BUILTIN_PATTERNS);
      setArchitectures(nextArchitectures);
      setSelectedArchitectureId((current) => current && nextArchitectures.some((item) => item.id === current)
        ? current
        : nextArchitectures[0]?.id ?? null);
      setLoadState("ready");
    } catch (error) {
      setMessage(safeArchitectureErrorMessage(error));
      setLoadState(isUnsupportedError(error) ? "unsupported" : "error");
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  useEffect(() => {
    if (!selectedArchitectureId || loadState !== "ready") {
      setSelectedDetail(null);
      setPreview(null);
      setDetailState("ready");
      return;
    }
    let active = true;
    setDetailState("loading");
    setDetailMessage(null);
    client.getArchitecture(selectedArchitectureId)
      .then((detail) => {
        const contexts = architectureContexts(detail);
        const profileId = contexts.profiles.some((item) => item.id === selectedProfileId)
          ? selectedProfileId
          : contexts.profiles[0]?.id ?? "";
        const environmentId = contexts.environments.find((environment) => environment.id === selectedEnvironmentId && environmentBelongsToProfile(environment, profileId))?.id
          ?? boundEnvironmentForProfile(contexts.environments, profileId)?.id
          ?? "";
        if (active) {
          setSelectedDetail(detail);
          setProfiles(contexts.profiles);
          setEnvironments(contexts.environments);
          setSelectedProfileId(profileId);
          setSelectedEnvironmentId(environmentId);
          setPreview(null);
          setDetailState("ready");
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setSelectedDetail(null);
        setPreview(null);
        setDetailMessage(safeArchitectureErrorMessage(error));
        setDetailState(isUnsupportedError(error) ? "unsupported" : "error");
      });
    return () => {
      active = false;
    };
  }, [client, loadState, selectedArchitectureId]);

  useEffect(() => {
    if (!selectedArchitectureId || selectedDetail?.id !== selectedArchitectureId || !selectedDetail?.latestRevision || !selectedProfileId || !selectedEnvironmentId) {
      return;
    }
    let active = true;
    setDetailState("loading");
    setDetailMessage(null);
    client.previewArchitecture(selectedArchitectureId, {
      profileId: selectedProfileId,
      environmentId: selectedEnvironmentId,
      revisionId: selectedDetail.latestRevision.id,
    }).then((nextPreview) => {
      if (!active) return;
      setPreview(nextPreview);
      setDetailState("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setPreview(null);
      setDetailMessage(safeArchitectureErrorMessage(error));
      setDetailState(isUnsupportedError(error) ? "unsupported" : "error");
    });
    return () => {
      active = false;
    };
  }, [client, selectedArchitectureId, selectedDetail, selectedEnvironmentId, selectedProfileId]);

  const selectedArchitecture = useMemo(
    () => architectures.find((item) => item.id === selectedArchitectureId) ?? null,
    [architectures, selectedArchitectureId],
  );
  const previewContextKey = [
    selectedArchitectureId ?? "",
    selectedDetail?.id ?? "",
    selectedDetail?.latestRevision?.id ?? "",
    selectedProfileId,
    selectedEnvironmentId,
  ].join("\u0000");
  // Keep the latest context available to async fixture-preview continuations
  // without introducing an effect solely for derived state.
  previewContextRef.current = previewContextKey;
  useEffect(() => {
    fixturePreviewEpoch.current += 1;
  }, [previewContextKey]);
  const availableProfiles = profiles;
  const availableEnvironments = environments;

  function selectArchitecture(id: string) {
    if (id === selectedArchitectureId) {
      return;
    }
    setSelectedDetail(null);
    setProfiles([]);
    setEnvironments([]);
    setSelectedProfileId("");
    setSelectedEnvironmentId("");
    setSelectedArchitectureId(id);
    setPreview(null);
    setDetailMessage(null);
  }

  return (
    <main className="architecture-workspace" aria-label="Skill architectures">
      <section className="architecture-hero" aria-labelledby="architectures-heading">
        <div>
          <p className="architecture-eyebrow"><Workflow size={15} aria-hidden="true" /> Control plane</p>
          <h1 id="architectures-heading">Skill architectures</h1>
          <p>Choose a server-declared router or leaf pattern, then inspect the exact result for each declared profile and environment.</p>
          <small className="architecture-session-note">Signed in as {session.user.email}. The API decides what is visible and effective.</small>
        </div>
        <Button className="architecture-refresh-button" size="sm" type="button" variant="outline" onClick={() => setRefreshKey((value) => value + 1)}>
          <RefreshCw size={15} aria-hidden="true" /> Refresh
        </Button>
      </section>

      {message && loadState !== "ready" && (
        <ArchitectureState state={loadState} message={message} onRetry={() => setRefreshKey((value) => value + 1)} />
      )}

      {loadState === "ready" && (
        <>
          <PatternGallery patterns={patterns} />
          <section className="architecture-grid" aria-label="Architecture workspace">
            <div className="architecture-sidebar">
              <CreateArchitectureCard
                client={client}
                patterns={patterns}
                onCreated={(created) => {
                  setSelectedDetail(null);
                  setProfiles([]);
                  setEnvironments([]);
                  setSelectedProfileId("");
                  setSelectedEnvironmentId("");
                  setArchitectures((current) => [created, ...current.filter((item) => item.id !== created.id)]);
                  setSelectedArchitectureId(created.id);
                }}
              />
              <ArchitectureList
                architectures={architectures}
                selectedId={selectedArchitectureId}
                onSelect={selectArchitecture}
              />
            </div>
            <ArchitectureDetailPanel
              architecture={selectedArchitecture}
              detail={selectedDetail}
              detailState={detailState}
              message={detailMessage}
              preview={preview}
              profiles={availableProfiles}
              environments={availableEnvironments}
              selectedProfileId={selectedProfileId}
              selectedEnvironmentId={selectedEnvironmentId}
              onProfileChange={(value) => {
                const profile = availableProfiles.find((item) => item.id === value);
                const environment = profile ? boundEnvironmentForProfile(availableEnvironments, profile.id) : undefined;
                if (!profile || !environment) return;
                setSelectedProfileId(profile.id);
                setSelectedEnvironmentId(environment.id);
              }}
              onEnvironmentChange={(value) => {
                const environment = availableEnvironments.find((item) => item.id === value);
                const profileId = environment ? environmentProfileId(environment, availableProfiles) : undefined;
                if (!environment || !profileId) return;
                setSelectedProfileId(profileId);
                setSelectedEnvironmentId(environment.id);
              }}
              onFixturePreview={async (fixture) => {
                if (!selectedArchitectureId || selectedDetail?.id !== selectedArchitectureId || !selectedDetail?.latestRevision || !selectedProfileId || !selectedEnvironmentId) {
                  return;
                }
                const requestEpoch = fixturePreviewEpoch.current + 1;
                fixturePreviewEpoch.current = requestEpoch;
                const requestContextKey = previewContextKey;
                setDetailMessage(null);
                try {
                  const nextPreview = await client.previewArchitecture(selectedArchitectureId, {
                    profileId: selectedProfileId,
                    environmentId: selectedEnvironmentId,
                    revisionId: selectedDetail.latestRevision.id,
                    fixture,
                  });
                  if (requestEpoch !== fixturePreviewEpoch.current || requestContextKey !== previewContextRef.current) {
                    return;
                  }
                  setPreview(nextPreview);
                  setDetailState("ready");
                } catch (error) {
                  if (requestEpoch !== fixturePreviewEpoch.current || requestContextKey !== previewContextRef.current) {
                    return;
                  }
                  setDetailMessage(safeArchitectureErrorMessage(error));
                  setDetailState(isUnsupportedError(error) ? "unsupported" : "error");
                  throw error;
                }
              }}
              client={client}
              onRetry={() => setRefreshKey((value) => value + 1)}
            />
          </section>
        </>
      )}
    </main>
  );
}

function PatternGallery({ patterns }: { patterns: ArchitecturePattern[] }) {
  return (
    <section className="architecture-patterns" aria-labelledby="architecture-patterns-heading">
      <div className="architecture-section-heading">
        <div>
          <p className="architecture-kicker">Choose a pattern</p>
          <h2 id="architecture-patterns-heading">Review the available architecture patterns</h2>
        </div>
        <span className="architecture-section-note">Patterns are versioned by the API.</span>
      </div>
      <div className="architecture-pattern-grid">
        {patterns.map((pattern) => {
          const disabled = pattern.status === "planned" || pattern.status === "unsupported";
          return (
            <article className={disabled ? "architecture-pattern-card disabled" : "architecture-pattern-card"} key={pattern.id}>
              <div className="architecture-pattern-icon"><GitBranch size={18} aria-hidden="true" /></div>
              <div>
                <div className="architecture-pattern-title-row">
                  <h3>{pattern.name}</h3>
                  <Badge variant="outline">{pattern.version ? `v${pattern.version}` : pattern.status === "planned" ? "Planned" : "Available"}</Badge>
                </div>
                <p>{pattern.description}</p>
                <span className="architecture-pattern-meta">
                  {pattern.supportsNestedRouters ? "Server-declared nested routing" : "Server-declared routing shape"}
                  {disabled ? " · Not available" : " · Selectable"}
                </span>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function CreateArchitectureCard({
  client,
  patterns,
  onCreated,
}: {
  client: RegistryClient;
  patterns: ArchitecturePattern[];
  onCreated: (architecture: ArchitectureSummary) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [patternId, setPatternId] = useState<ArchitecturePatternId>(patterns.find((item) => item.id === "multi-level-router")?.id ?? patterns[0]?.id ?? "flat");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!patterns.some((item) => item.id === patternId)) {
      setPatternId(patterns[0]?.id ?? "flat");
    }
  }, [patternId, patterns]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setState("error");
      setMessage("Give the architecture a name before creating it.");
      return;
    }
    setState("saving");
    setMessage(null);
    try {
      const created = await client.createArchitecture({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        patternId,
      });
      setName("");
      setDescription("");
      setState("idle");
      onCreated(created);
    } catch (error) {
      setState("error");
      setMessage(safeArchitectureErrorMessage(error));
    }
  }

  return (
    <Card className="architecture-create-card" aria-label="Create architecture">
      <CardHeader className="architecture-card-heading">
        <div className="architecture-card-heading-icon"><Plus size={17} aria-hidden="true" /></div>
        <div>
          <CardTitle>New architecture</CardTitle>
          <CardDescription>Create an owner-private draft shell. Add its first immutable revision through the API contract.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form className="architecture-create-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>Name</span>
            <Input aria-label="Architecture name" disabled={state === "saving"} onChange={(event) => setName(event.target.value)} placeholder="Personal assistant stack" value={name} />
          </label>
          <label>
            <span>Description <small>(optional)</small></span>
            <textarea aria-label="Architecture description" disabled={state === "saving"} onChange={(event) => setDescription(event.target.value)} placeholder="What this architecture is for" value={description} />
          </label>
          <label>
            <span>Pattern</span>
            <select aria-label="Architecture pattern" disabled={state === "saving"} onChange={(event) => setPatternId(event.target.value)} value={patternId}>
              {patterns.map((pattern) => <option disabled={pattern.status === "planned" || pattern.status === "unsupported"} key={pattern.id} value={pattern.id}>{pattern.name}{pattern.version ? ` · v${pattern.version}` : ""}</option>)}
            </select>
          </label>
          {message && <div className="architecture-inline-message" role="status">{message}</div>}
          <Button className="architecture-create-button" disabled={state === "saving" || !name.trim()} size="sm" type="submit">
            <Plus size={15} aria-hidden="true" /> {state === "saving" ? "Creating…" : "Create architecture"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ArchitectureList({ architectures, selectedId, onSelect }: { architectures: ArchitectureSummary[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <Card className="architecture-list-card" aria-label="Saved architectures">
      <CardHeader className="architecture-card-heading">
        <div className="architecture-card-heading-icon"><Layers3 size={17} aria-hidden="true" /></div>
        <div>
          <CardTitle>Your architectures</CardTitle>
          <CardDescription>{architectures.length} saved {architectures.length === 1 ? "architecture" : "architectures"}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="architecture-list-content">
        {architectures.length === 0 ? (
          <div className="architecture-empty-list">
            <GitBranch size={22} aria-hidden="true" />
            <strong>No architectures yet.</strong>
            <span>Create one to inspect a compiled router and leaf graph.</span>
          </div>
        ) : (
          <div className="architecture-list" role="list">
            {architectures.map((architecture) => {
              const selected = architecture.id === selectedId;
              return (
                <button className={selected ? "architecture-list-row selected" : "architecture-list-row"} key={architecture.id} type="button" onClick={() => onSelect(architecture.id)}>
                  <span className="architecture-list-icon"><GitBranch size={16} aria-hidden="true" /></span>
                  <span className="architecture-list-main">
                    <strong>{architecture.name}</strong>
                    <small>{patternLabel(architecture.patternId)} · {architectureRevisionLabel(architecture)}</small>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ArchitectureDetailPanel({
  architecture,
  detail,
  detailState,
  message,
  preview,
  profiles,
  environments,
  selectedProfileId,
  selectedEnvironmentId,
  onProfileChange,
  onEnvironmentChange,
  onFixturePreview,
  client,
  onRetry,
}: {
  architecture: ArchitectureSummary | null;
  detail: ArchitectureDetail | null;
  detailState: ArchitectureLoadState;
  message: string | null;
  preview: ArchitecturePreview | null;
  profiles: ArchitectureProfile[];
  environments: ArchitectureEnvironment[];
  selectedProfileId: string;
  selectedEnvironmentId: string;
  onProfileChange: (value: string) => void;
  onEnvironmentChange: (value: string) => void;
  onFixturePreview: (fixture: ArchitectureObservedFixture) => Promise<void>;
  client: RegistryClient;
  onRetry: () => void;
}) {
  if (!architecture) {
    return (
      <Card className="architecture-detail-card empty" aria-label="Architecture detail">
        <CardContent className="architecture-detail-empty">
          <Network size={42} aria-hidden="true" />
          <h2>Select an architecture</h2>
          <p>Choose a saved architecture to inspect its topology, effective skills, and dry-run sync plan.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="architecture-detail-card" aria-label={`Architecture detail: ${architecture.name}`}>
      <CardHeader className="architecture-detail-header">
        <div>
          <p className="architecture-kicker">Architecture detail</p>
          <CardTitle>{architecture.name}</CardTitle>
          <CardDescription>{architecture.description || "No description supplied."}</CardDescription>
        </div>
        <div className="architecture-detail-badges">
          <Badge variant="outline">{patternLabel(architecture.patternId)}</Badge>
          <Badge variant="secondary">{architectureRevisionLabel(architecture)}</Badge>
        </div>
      </CardHeader>
      <CardContent className="architecture-detail-content">
        {profiles.length > 0 && environments.length > 0 ? (
          <div className="architecture-context-bar" aria-label="Preview context">
            <label>
              <span>Profile</span>
              <select aria-label="Preview profile" onChange={(event) => onProfileChange(event.target.value)} value={selectedProfileId}>
                {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.scope}</option>)}
              </select>
            </label>
            <label>
              <span>Environment</span>
              <select aria-label="Preview environment" onChange={(event) => onEnvironmentChange(event.target.value)} value={selectedEnvironmentId}>
                {environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}
              </select>
            </label>
            <span className="architecture-context-note"><ShieldCheck size={15} aria-hidden="true" /> Effective result returned by API</span>
          </div>
        ) : (
          <div className="architecture-empty-inline" role="status"><CircleAlert size={17} aria-hidden="true" /> This draft has no revision yet. Add a validated spec through the architecture revision API before previewing it.</div>
        )}

        {detailState === "loading" && <ArchitectureDetailLoading />}
        {detailState !== "loading" && message && (
          <ArchitectureState state={detailState} message={message} onRetry={onRetry} compact />
        )}
        {detailState !== "loading" && !message && preview && <ArchitecturePreviewPanel detail={detail} preview={preview} />}
        {detailState !== "loading" && !message && preview && (
          <ObservedFixturePreviewCard
            key={`${architecture.id}:${selectedProfileId}:${selectedEnvironmentId}`}
            onPreview={onFixturePreview}
          />
        )}
        {detail && (
          <AddArchitectureRevisionCard
            key={`${architecture.id}:${detail.latestRevision?.id ?? "draft"}`}
            architectureId={architecture.id}
            client={client}
            detail={detail}
            onSaved={onRetry}
          />
        )}
      </CardContent>
    </Card>
  );
}

function AddArchitectureRevisionCard({
  architectureId,
  client,
  detail,
  onSaved,
}: {
  architectureId: string;
  client: RegistryClient;
  detail: ArchitectureDetail;
  onSaved: () => void;
}) {
  const [specText, setSpecText] = useState(() => formatArchitectureSpec(detail.latestRevision?.spec));
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setState("idle");
    let spec: unknown;
    try {
      spec = JSON.parse(specText);
    } catch {
      setState("error");
      setErrorMessage("Enter valid JSON before saving the revision.");
      return;
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      setState("error");
      setErrorMessage("The revision spec must be a JSON object.");
      return;
    }
    setState("saving");
    try {
      await client.createArchitectureRevision(architectureId, {
        spec,
        ...(message.trim() ? { message: message.trim() } : {}),
      });
      setState("saved");
      onSaved();
    } catch (error) {
      setState("error");
      setErrorMessage(safeArchitectureErrorMessage(error));
    }
  }

  return (
    <details className="architecture-revision-card">
      <summary>Add immutable revision</summary>
      <div className="architecture-revision-copy">
        <p>Advanced input for a validated ArchitectureSpecV1 JSON document. Saving creates a new immutable revision; it does not apply anything to a runtime.</p>
      </div>
      <form className="architecture-revision-form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>Revision message <small>(optional)</small></span>
          <Input aria-label="Revision message" disabled={state === "saving"} onChange={(event) => setMessage(event.target.value)} placeholder="Describe this architecture change" value={message} />
        </label>
        <label>
          <span>Architecture spec JSON</span>
          <textarea aria-label="Architecture spec JSON" disabled={state === "saving"} onChange={(event) => setSpecText(event.target.value)} placeholder="Paste a validated ArchitectureSpecV1 JSON object" value={specText} />
        </label>
        {errorMessage && <div className="architecture-inline-message" role="alert">{errorMessage}</div>}
        {state === "saved" && <div className="architecture-inline-message success" role="status">Revision saved. The API will return the updated preview after refresh.</div>}
        <Button disabled={state === "saving" || !specText.trim()} size="sm" type="submit">
          {state === "saving" ? "Saving revision…" : "Save immutable revision"}
        </Button>
      </form>
    </details>
  );
}

function ObservedFixturePreviewCard({ onPreview }: { onPreview: (fixture: ArchitectureObservedFixture) => Promise<void> }) {
  const [fixtureText, setFixtureText] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    let fixture: unknown;
    try {
      fixture = JSON.parse(fixtureText);
    } catch {
      setState("error");
      setMessage("Enter valid observed-state fixture JSON before generating a plan.");
      return;
    }
    const parsedFixture = parseObservedFixture(fixture);
    if (!parsedFixture) {
      setState("error");
      setMessage("The observed-state fixture must use targetId and only allowlisted metadata fields.");
      return;
    }
    setState("loading");
    try {
      await onPreview(parsedFixture);
      setState("ready");
      setMessage("Dry-run plan generated from the supplied observed state. No target was changed.");
    } catch {
      setState("error");
      setMessage("The observed-state fixture was rejected. Review its allowlisted metadata fields and try again.");
    }
  }

  return (
    <details className="architecture-revision-card architecture-fixture-card">
      <summary>Compare observed-state fixture</summary>
      <div className="architecture-revision-copy">
        <p>Paste a strict metadata-only target snapshot to generate a dry-run plan. The browser never invents target state, and this action cannot apply changes.</p>
      </div>
      <form className="architecture-revision-form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>Observed-state fixture JSON</span>
          <textarea aria-label="Observed-state fixture JSON" disabled={state === "loading"} onChange={(event) => setFixtureText(event.target.value)} placeholder='{"targetId":"codex-personal","nodes":[]}' value={fixtureText} />
        </label>
        {message && <div className={`architecture-inline-message ${state === "ready" ? "success" : ""}`} role={state === "error" ? "alert" : "status"}>{message}</div>}
        <Button disabled={state === "loading" || !fixtureText.trim()} size="sm" type="submit">
          {state === "loading" ? "Generating dry run…" : "Generate dry-run plan"}
        </Button>
      </form>
    </details>
  );
}

function parseObservedFixture(value: unknown): ArchitectureObservedFixture | null {
  const fixture = plainRecord(value);
  if (!fixture || !hasOnlyKeys(fixture, ["targetId", "environmentId", "skills", "routers", "nodes"])) {
    return null;
  }
  const targetId = fixture.targetId;
  if (!isBoundedString(targetId, 256)) {
    return null;
  }
  const environmentId = fixture.environmentId;
  if (environmentId !== undefined && !isBoundedString(environmentId, 256)) {
    return null;
  }
  const skills = parseObservedFixtureEntries(fixture.skills, "skills");
  const routers = parseObservedFixtureEntries(fixture.routers, "routers");
  const nodes = parseObservedFixtureEntries(fixture.nodes, "nodes");
  if (skills === null || routers === null || nodes === null) {
    return null;
  }
  return {
    targetId,
    ...(environmentId !== undefined ? { environmentId } : {}),
    ...(skills !== undefined ? { skills: skills as unknown as NonNullable<ArchitectureObservedFixture["skills"]> } : {}),
    ...(routers !== undefined ? { routers: routers as unknown as NonNullable<ArchitectureObservedFixture["routers"]> } : {}),
    ...(nodes !== undefined ? { nodes: nodes as unknown as NonNullable<ArchitectureObservedFixture["nodes"]> } : {}),
  };
}

function parseObservedFixtureEntries(value: unknown, field: "skills" | "routers" | "nodes"): Array<Record<string, unknown>> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 500) {
    return null;
  }
  const allowed = field === "skills"
    ? ["nodeId", "skillRefId", "slug", "version", "digest", "enabled", "runtimeExposure", "managed", "supported"]
    : field === "routers"
      ? ["nodeId", "configurationDigest", "configured", "managed", "supported"]
      : ["nodeId", "kind", "skillRefId", "slug", "version", "digest", "enabled", "runtimeExposure", "configurationDigest", "configured", "managed", "supported"];
  const entries: Array<Record<string, unknown>> = [];
  for (const item of value) {
    const entry = plainRecord(item);
    if (!entry || !hasOnlyKeys(entry, allowed)) {
      return null;
    }
    const stringKeys = ["nodeId", "skillRefId", "slug", "version"];
    if (field === "routers") stringKeys.push("configurationDigest");
    if (field === "nodes") stringKeys.push("configurationDigest");
    if (stringKeys.some((key) => entry[key] !== undefined && !isBoundedString(entry[key], 256))) {
      return null;
    }
    const digestKeys = ["digest", "configurationDigest"];
    if (digestKeys.some((key) => entry[key] !== undefined && (typeof entry[key] !== "string" || !/^[a-f0-9]{64}$/.test(entry[key])))) {
      return null;
    }
    const booleanKeys = ["enabled", "managed", "supported", "configured"];
    if (booleanKeys.some((key) => entry[key] !== undefined && typeof entry[key] !== "boolean")) {
      return null;
    }
    if (entry.kind !== undefined && entry.kind !== "router" && entry.kind !== "leaf") {
      return null;
    }
    if (entry.runtimeExposure !== undefined && entry.runtimeExposure !== "disabled" && entry.runtimeExposure !== "router" && entry.runtimeExposure !== "leaf") {
      return null;
    }
    if (entry.version !== undefined && (typeof entry.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.version))) {
      return null;
    }
    if (field === "skills" && (!isBoundedString(entry.slug, 256) || !isBoundedString(entry.version, 256) || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.digest) || typeof entry.enabled !== "boolean")) {
      return null;
    }
    if ((field === "routers" || field === "nodes") && !isBoundedString(entry.nodeId, 256)) {
      return null;
    }
    entries.push(entry);
  }
  return entries;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function ArchitecturePreviewPanel({ detail, preview }: { detail: ArchitectureDetail | null; preview: ArchitecturePreview }) {
  const topology = topologyForPreview(preview);
  const conflict = preview.plan?.items.some((item) => item.action === "conflict") ?? false;
  const unsupported = preview.plan?.items.some((item) => item.action === "unsupported") ?? false;
  return (
    <div className="architecture-preview-stack">
      {(conflict || unsupported) && (
        <div className={conflict ? "architecture-banner conflict" : "architecture-banner unsupported"} role="alert">
          {conflict ? <AlertTriangle size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
          <span>
            <strong>{conflict ? "Conflict needs review" : "Target capability is incomplete"}</strong>
            <small>{conflict ? "The observed target differs from the selected revision. Review the dry-run plan before changing anything." : "The selected target cannot apply every desired operation. No live apply is available from this view."}</small>
          </span>
        </div>
      )}

      <section className="architecture-panel-section" aria-labelledby="architecture-diagram-heading">
        <div className="architecture-panel-section-heading">
          <div>
            <p className="architecture-kicker">Topology</p>
            <h2 id="architecture-diagram-heading">Router and leaf map</h2>
          </div>
          <Badge variant="outline">{topology.nodes.length} nodes · {topology.edges.length} links</Badge>
        </div>
        <ArchitectureDiagram topology={topology} />
        <ArchitectureOutline outline={preview.outline} />
      </section>

      <section className="architecture-panel-section" aria-labelledby="architecture-effective-heading">
        <div className="architecture-panel-section-heading">
          <div>
            <p className="architecture-kicker">Effective result</p>
            <h2 id="architecture-effective-heading">Skills available in this context</h2>
          </div>
          <span className="architecture-section-note">Authorization is resolved server-side.</span>
        </div>
        {preview.compiled.skills.length === 0 ? (
          <div className="architecture-empty-inline"><CircleAlert size={17} aria-hidden="true" /> No skills are effective for this profile and environment.</div>
        ) : (
          <div className="architecture-skill-table-wrap">
            <table className="architecture-skill-table">
              <thead><tr><th scope="col">Skill</th><th scope="col">Version</th><th scope="col">Exposure</th><th scope="col">Reason</th></tr></thead>
              <tbody>
                {preview.compiled.skills.map((skill) => {
                  const node = preview.compiled.nodes.find((candidate) => candidate.skillRefId === skill.skillRefId);
                  return (
                  <tr key={`${skill.skillRefId}:${skill.version}`}>
                    <th scope="row"><strong>{skill.title || skill.slug}</strong><small>{skill.slug}</small></th>
                    <td>{skill.version}</td>
                    <td><span className="architecture-exposure">{runtimeExposureLabel(node?.runtimeExposure)}</span></td>
                    <td>Enabled by profile {preview.compiled.profileId} for {preview.compiled.environmentId}; package access remains {skill.packageVisibility}.</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ArchitectureSyncPlan plan={preview.plan} />

      <section className="architecture-panel-section architecture-compile-section" aria-labelledby="architecture-compile-heading">
        <div className="architecture-panel-section-heading">
          <div>
            <p className="architecture-kicker">Portable output</p>
            <h2 id="architecture-compile-heading">Compiled projection</h2>
          </div>
          <Badge variant="secondary"><TerminalSquare size={13} aria-hidden="true" /> Read-only</Badge>
        </div>
        <div className="architecture-compile-grid">
          <dl className="architecture-compile-facts">
            <div><dt>Revision</dt><dd>{preview.revision.revisionNumber}</dd></div>
            <div><dt>Entrypoint</dt><dd>API projection</dd></div>
            <div><dt>Revision digest</dt><dd>{preview.compiled.revisionDigest || preview.graph.digest}</dd></div>
          </dl>
          <div className="architecture-mermaid-block">
            <div className="architecture-mermaid-heading"><span>Mermaid export</span><CopyMermaidButton value={preview.graph.mermaid} /></div>
            <pre aria-label="Mermaid architecture export">{preview.graph.mermaid || "The API did not return a Mermaid projection for this revision."}</pre>
          </div>
        </div>
      </section>
    </div>
  );
}

function ArchitectureDiagram({ topology }: { topology: { nodes: ArchitectureTopologyNode[]; edges: ArchitectureTopologyEdge[] } }) {
  const nodeWidth = 184;
  const nodeHeight = 60;
  const rowHeight = 102;
  const padding = 32;
  const columns = 3;
  const positions = new Map(topology.nodes.map((node, index) => {
    const serverPosition = node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)
      ? node.position
      : { x: 40 + (index % columns) * 246, y: 22 + Math.floor(index / columns) * rowHeight };
    return [node.id, serverPosition] as const;
  }));
  const coordinates = Array.from(positions.values());
  const minX = Math.min(0, ...coordinates.map((position) => position.x));
  const minY = Math.min(0, ...coordinates.map((position) => position.y));
  const maxX = Math.max(nodeWidth, ...coordinates.map((position) => position.x + nodeWidth));
  const maxY = Math.max(nodeHeight, ...coordinates.map((position) => position.y + nodeHeight));
  const viewBoxX = minX - padding;
  const viewBoxY = minY - padding;
  const width = Math.max(760, maxX - minX + padding * 2);
  const height = Math.max(260, maxY - minY + padding * 2);
  return (
    <div className="architecture-diagram-shell">
      {topology.nodes.length === 0 ? (
        <div className="architecture-empty-inline"><CircleAlert size={17} aria-hidden="true" /> No topology nodes were returned.</div>
      ) : (
        <svg className="architecture-diagram" role="img" aria-labelledby="architecture-diagram-title architecture-diagram-description" viewBox={`${viewBoxX} ${viewBoxY} ${width} ${height}`}>
          <title id="architecture-diagram-title">Skill architecture topology</title>
          <desc id="architecture-diagram-description">A deterministic map of routers, sub-routers, and leaf skills returned by the API.</desc>
          <g className="architecture-diagram-edges" aria-hidden="true">
            {topology.edges.map((edge, index) => {
              const from = positions.get(edge.from);
              const to = positions.get(edge.to);
              if (!from || !to) {
                return null;
              }
              return <line key={edge.id ?? `${edge.from}:${edge.to}:${index}`} markerEnd="url(#architecture-arrow)" x1={from.x + 92} x2={to.x + 92} y1={from.y + 30} y2={to.y + 30} />;
            })}
          </g>
          <defs><marker id="architecture-arrow" markerHeight="8" markerWidth="8" orient="auto" refX="6" refY="3"><path d="M0,0 L0,6 L6,3 z" /></marker></defs>
          <g className="architecture-diagram-nodes">
            {topology.nodes.map((node) => {
              const position = positions.get(node.id)!;
              const leaf = isLeafNodeKind(node.kind);
              return (
                <g key={node.id} transform={`translate(${position.x}, ${position.y})`}>
                  <rect className={leaf ? "architecture-diagram-node skill" : "architecture-diagram-node router"} height="60" rx="9" width="184" />
                  <text className="architecture-diagram-kind" x="14" y="19">{leaf ? "LEAF SKILL" : "ROUTER"}</text>
                  <text className="architecture-diagram-label" x="14" y="41">{truncateSvgLabel(node.label)}</text>
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}

function ArchitectureOutline({ outline }: { outline: ArchitecturePreview["outline"] }) {
  return (
    <div className="architecture-outline">
      <div className="architecture-outline-heading"><h3>Accessible outline</h3><span>Same nodes as the diagram</span></div>
      {outline.tree.length === 0 ? <p className="architecture-muted">No outline is available.</p> : (
        <ol aria-label="Architecture topology outline">
          {outline.tree.map((node) => <ArchitectureOutlineItem key={node.id} node={node} />)}
        </ol>
      )}
    </div>
  );
}

function ArchitectureOutlineItem({ node }: { node: ArchitecturePreview["outline"]["tree"][number] }) {
  return (
    <li>
      <span className={isLeafNodeKind(node.kind) ? "architecture-outline-dot skill" : "architecture-outline-dot router"} aria-hidden="true" />
      <span><strong>{node.label}</strong><small>{isLeafNodeKind(node.kind) ? "Leaf skill" : "Router branch"}</small></span>
      {node.children.length > 0 && <ol>{node.children.map((child) => <ArchitectureOutlineItem key={child.id} node={child} />)}</ol>}
    </li>
  );
}

function topologyForPreview(preview: ArchitecturePreview): { nodes: ArchitectureTopologyNode[]; edges: ArchitectureTopologyEdge[] } {
  return {
    nodes: preview.graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      ...(node.skillRefId ? { slug: node.skillRefId } : {}),
      depth: node.depth,
      position: { x: node.x, y: node.y },
    })),
    edges: preview.graph.edges.map((edge, index) => ({
      id: `edge-${index + 1}`,
      from: edge.from,
      to: edge.to,
      relationship: edge.kind,
    })),
  };
}

function ArchitectureSyncPlan({ plan }: { plan?: ArchitecturePreviewPlan }) {
  if (!plan) {
    return (
      <section className="architecture-panel-section" aria-labelledby="architecture-sync-heading">
        <div className="architecture-panel-section-heading">
          <div>
            <p className="architecture-kicker">Target reconciliation</p>
            <h2 id="architecture-sync-heading">Dry-run sync plan</h2>
          </div>
          <span className="architecture-sync-status">Not generated</span>
        </div>
        <div className="architecture-empty-inline" role="status">
          <CircleAlert size={17} aria-hidden="true" /> No sync plan generated. Provide an observed-state fixture to preview a target dry run.
        </div>
      </section>
    );
  }

  const conflict = plan.items.some((item) => item.action === "conflict");
  const unsupported = plan.items.some((item) => item.action === "unsupported");
  const changes = plan.items.filter((item) => item.action !== "noop");
  const status = conflict ? "Conflict" : unsupported ? "Unsupported" : changes.length === 0 ? "No changes" : `${changes.length} dry-run changes`;
  return (
    <section className="architecture-panel-section" aria-labelledby="architecture-sync-heading">
      <div className="architecture-panel-section-heading">
        <div>
          <p className="architecture-kicker">Target reconciliation</p>
          <h2 id="architecture-sync-heading">Dry-run sync plan</h2>
        </div>
        <span className={`architecture-sync-status ${conflict ? "conflict" : unsupported ? "unsupported" : ""}`}>{status}</span>
      </div>
      <p className="architecture-sync-note"><ShieldCheck size={15} aria-hidden="true" /> No target is changed by this preview. Target: {plan.targetId}.</p>
      {changes.length === 0 ? (
        <div className="architecture-empty-inline"><Check size={17} aria-hidden="true" /> Target already matches the selected desired state.</div>
      ) : (
        <div className="architecture-sync-list" role="list">
          {changes.map((change, index) => <SyncChangeRow change={change} key={`${change.action}:${change.nodeId}:${index}`} />)}
        </div>
      )}
    </section>
  );
}

function SyncChangeRow({ change }: { change: ArchitecturePreviewPlan["items"][number] }) {
  const tone = change.action === "conflict" || change.action === "unsupported" ? "danger" : change.action === "noop" ? "neutral" : "normal";
  return (
    <div className={`architecture-sync-row ${tone}`} role="listitem">
      <span className="architecture-sync-type">{change.action.replace(/-/g, " ")}</span>
      <span><strong>{change.skillRefId ?? change.nodeId}</strong><small>{change.reason}</small></span>
    </div>
  );
}

function CopyMermaidButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!value || !navigator.clipboard?.writeText) {
      return;
    }
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return <Button aria-label="Copy Mermaid export" className="architecture-copy-button" size="xs" type="button" variant="outline" disabled={!value} onClick={() => void copy()}><Clipboard size={13} aria-hidden="true" /> {copied ? "Copied" : "Copy"}</Button>;
}

function ArchitectureDetailLoading() {
  return <div className="architecture-detail-loading" role="status" aria-live="polite"><span className="sr-only">Loading architecture preview…</span><div /><div /><div /></div>;
}

function ArchitectureState({ state, message, onRetry, compact = false }: { state: ArchitectureLoadState; message: string; onRetry: () => void; compact?: boolean }) {
  const unsupported = state === "unsupported";
  return (
    <div className={compact ? "architecture-state compact" : "architecture-state"} role={unsupported ? "status" : "alert"}>
      {unsupported ? <CircleAlert size={24} aria-hidden="true" /> : <AlertTriangle size={24} aria-hidden="true" />}
      <strong>{message}</strong>
      <span>{unsupported ? "This workspace can still use the existing registry while architecture support is enabled." : "Retry the API request or review the workspace access and revision state."}</span>
      {!unsupported && <Button size="sm" type="button" variant="outline" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" /> Retry</Button>}
    </div>
  );
}

function patternLabel(patternId: ArchitecturePatternId): string {
  switch (patternId) {
    case "flat": return "Flat library";
    case "domain-router": return "Domain router";
    case "multi-level-router": return "Multi-level router";
    default: return patternId;
  }
}

function revisionLabel(revision: ArchitectureRevisionSummaryLike | null | undefined): string {
  if (!revision) {
    return "Draft";
  }
  return `Revision ${revision.revision ?? revision.revisionNumber ?? revision.version ?? "—"}`;
}

function architectureRevisionLabel(architecture: ArchitectureSummary): string {
  return revisionLabel(architecture.latestRevision ?? (architecture.revisionCount ? { revisionNumber: architecture.revisionCount } : null));
}

interface ArchitectureRevisionSummaryLike {
  revision?: number;
  revisionNumber?: number;
  version?: string;
}

interface ArchitectureContextProfile {
  id: string;
  name?: string;
  subject?: { type?: string; id?: string };
}

interface ArchitectureContextEnvironment {
  id: string;
  name?: string;
  kind?: string;
  profileId?: string;
}

interface ArchitectureContextSpec {
  profiles: ArchitectureContextProfile[];
  environments: ArchitectureContextEnvironment[];
}

function architectureContexts(detail: ArchitectureDetail): {
  profiles: ArchitectureProfile[];
  environments: ArchitectureEnvironment[];
} {
  const spec = architectureContextSpec(detail.latestRevision?.spec);
  const rawEnvironments = spec.environments;
  const rawProfiles = spec.profiles;
  const declaredProfileIds = new Set(rawProfiles.map((profile) => profile.id));
  const environments = rawEnvironments.map((environment) => ({
    id: environment.id,
    name: environment.name || environment.id,
    key: environment.id,
    kind: environment.kind || undefined,
    profileId: environment.profileId || undefined,
    profileIds: environment.profileId ? [environment.profileId] : [],
  })).filter((environment) => environment.id && environment.profileId && declaredProfileIds.has(environment.profileId));
  const profiles = rawProfiles.map((profile) => {
    const id = profile.id;
    const subject = profile.subject;
    const environmentKinds = rawEnvironments
      .filter((environment) => environment.profileId === id)
      .map((environment) => environment.kind);
    const scope = subject?.type === "team"
      ? "team"
      : environmentKinds.includes("work")
        ? "work"
        : "personal";
    return {
      id,
      name: profile.name || id,
      scope,
      ...(subject?.type === "team" ? { teamId: subject.id || null } : {}),
      environmentIds: environments.filter((environment) => environment.profileIds?.includes(id)).map((environment) => environment.id),
    };
  }).filter((profile) => profile.id && profile.environmentIds.length > 0);
  return { profiles, environments };
}

function architectureContextSpec(value: unknown): ArchitectureContextSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { profiles: [], environments: [] };
  }
  const candidate = value as { profiles?: unknown; environments?: unknown };
  return {
    profiles: Array.isArray(candidate.profiles) ? candidate.profiles.filter(isArchitectureContextProfile) : [],
    environments: Array.isArray(candidate.environments) ? candidate.environments.filter(isArchitectureContextEnvironment) : [],
  };
}

function isArchitectureContextProfile(value: unknown): value is ArchitectureContextProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { id?: unknown; name?: unknown; subject?: unknown };
  if (typeof candidate.id !== "string" || !candidate.id) {
    return false;
  }
  if (candidate.name !== undefined && typeof candidate.name !== "string") {
    return false;
  }
  if (candidate.subject === undefined) {
    return true;
  }
  if (!candidate.subject || typeof candidate.subject !== "object" || Array.isArray(candidate.subject)) {
    return false;
  }
  const subject = candidate.subject as { type?: unknown; id?: unknown };
  return (subject.type === undefined || typeof subject.type === "string")
    && (subject.id === undefined || typeof subject.id === "string");
}

function isArchitectureContextEnvironment(value: unknown): value is ArchitectureContextEnvironment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { id?: unknown; name?: unknown; kind?: unknown; profileId?: unknown };
  return typeof candidate.id === "string"
    && Boolean(candidate.id)
    && (candidate.name === undefined || typeof candidate.name === "string")
    && (candidate.kind === undefined || typeof candidate.kind === "string")
    && (candidate.profileId === undefined || typeof candidate.profileId === "string");
}

function environmentBelongsToProfile(environment: ArchitectureEnvironment, profileId: string): boolean {
  return environment.profileId === profileId || Boolean(environment.profileIds?.includes(profileId));
}

function environmentProfileId(environment: ArchitectureEnvironment, profiles: ArchitectureProfile[]): string | undefined {
  const candidate = environment.profileId ?? environment.profileIds?.find((profileId) => profiles.some((profile) => profile.id === profileId));
  return candidate && profiles.some((profile) => profile.id === candidate) ? candidate : undefined;
}

function boundEnvironmentForProfile(environments: ArchitectureEnvironment[], profileId: string): ArchitectureEnvironment | undefined {
  return environments.find((environment) => environmentBelongsToProfile(environment, profileId));
}

function formatArchitectureSpec(spec: unknown): string {
  if (!spec || typeof spec !== "object") {
    return "";
  }
  try {
    return JSON.stringify(spec, null, 2);
  } catch {
    return "";
  }
}

function truncateSvgLabel(value: string): string {
  return value.length > 25 ? `${value.slice(0, 22)}…` : value;
}

function isLeafNodeKind(kind: string): boolean {
  return kind === "leaf";
}

function runtimeExposureLabel(value: string | undefined): string {
  if (value === "router") return "Router only";
  if (value === "leaf") return "Direct leaf";
  return "Not exposed";
}

function isUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 501 || candidate.code === "ARCHITECTURE_NOT_SUPPORTED";
}
