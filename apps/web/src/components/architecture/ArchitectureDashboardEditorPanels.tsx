import { useCallback, useState, type FormEvent } from "react";
import type { ArchitectureSpecV1 } from "@myskills-app/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArchitectureEditor,
  type ArchitectureEditorPreviewRequest,
  type ArchitectureEditorSaveRequest,
  type ArchitectureEditorStatus,
  type ArchitectureRegistryReleaseOption,
  type ArchitectureRegistrySkillOption,
} from "./editor/index.js";
import {
  safeArchitectureErrorMessage,
  type ArchitectureDetail,
  type ArchitectureObservedFixture,
  type RegistryClient,
} from "../../api.js";
import { formatArchitectureSpec } from "./architecture-dashboard-helpers.js";

export function ArchitectureEditorCard({
  detail,
  initialSpec,
  expectedRevisionId,
  seededFromRevision,
  readOnly,
  onPreview,
  onSave,
  onDraftChange,
  onSearchRegistrySkills,
  onLoadRegistryReleases,
}: {
  detail: ArchitectureDetail;
  initialSpec?: ArchitectureSpecV1;
  expectedRevisionId?: string | null;
  seededFromRevision?: string | null;
  readOnly: boolean;
  onPreview?: (request: ArchitectureEditorPreviewRequest) => Promise<void>;
  onSave?: (request: ArchitectureEditorSaveRequest) => Promise<void>;
  onDraftChange?: (status: ArchitectureEditorStatus) => void;
  onSearchRegistrySkills?: (query: string) => Promise<ArchitectureRegistrySkillOption[]>;
  onLoadRegistryReleases?: (skill: ArchitectureRegistrySkillOption) => Promise<ArchitectureRegistryReleaseOption[]>;
}) {
  const [revisionMessage, setRevisionMessage] = useState("");
  const handleEditorDraftChange = useCallback((_spec: unknown, status: ArchitectureEditorStatus) => {
    onDraftChange?.(status);
  }, [onDraftChange]);

  const effectiveSpec = initialSpec ?? detail.latestRevision?.spec;
  if (!effectiveSpec) {
    return null;
  }
  const bootstrap = !detail.latestRevision;

  return (
    <section className="architecture-editor-card" aria-label={readOnly ? "Read-only architecture editor" : "Edit architecture draft"}>
      <div className="architecture-editor-card-heading">
        <div>
          <p className="architecture-kicker">{readOnly ? "Read-only workbench" : bootstrap ? "Bootstrap workbench" : "Draft workbench"}</p>
          <h2>{readOnly ? "Inspect this architecture" : bootstrap ? "Build the first revision" : seededFromRevision ? `Draft from revision ${seededFromRevision}` : "Edit the current revision"}</h2>
        </div>
        <Badge variant="outline">{readOnly ? "Member view" : bootstrap ? "First revision" : "Local draft"}</Badge>
      </div>
      <p className="architecture-editor-card-copy">
        {readOnly
          ? "This team architecture is available for inspection. Only the owner can append an immutable revision."
          : bootstrap
            ? "Start from this local bootstrap shell, choose exact registry releases, then save one immutable first revision. Canvas positions are visual only and are not persisted."
            : seededFromRevision
              ? `This draft starts from immutable revision ${seededFromRevision}; saving appends a new revision against the latest concurrency token. Canvas positions are visual only and are not persisted.`
              : "Changes stay in this browser until you preview or save them. Canvas positions are visual only and are not persisted."}
      </p>
      {!readOnly && (
        <label className="architecture-editor-message-field">
          <span>Revision message <small>(optional)</small></span>
          <Input aria-label="Draft revision message" onChange={(event) => setRevisionMessage(event.target.value)} placeholder="Describe this architecture change" value={revisionMessage} />
        </label>
      )}
      <ArchitectureEditor
        expectedRevisionId={expectedRevisionId ?? detail.latestRevision?.id ?? null}
        initialSpec={effectiveSpec}
        onDraftChange={handleEditorDraftChange}
        onPreview={onPreview}
        onSave={onSave}
        onSearchRegistrySkills={onSearchRegistrySkills}
        onLoadRegistryReleases={onLoadRegistryReleases}
        readOnly={readOnly}
        revisionMessage={revisionMessage}
      />
    </section>
  );
}

export function AddArchitectureRevisionCard({
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
        expectedCurrentRevisionId: detail.latestRevision?.id ?? null,
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
        <p>Advanced/bootstrap input for a validated ArchitectureSpecV1 JSON document. Use it for a first revision or recovery. Saving creates a new immutable revision; it does not apply anything to a runtime.</p>
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

export function ObservedFixturePreviewCard({ onPreview }: { onPreview: (fixture: ArchitectureObservedFixture) => Promise<void> }) {
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
