import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  safeArchitectureErrorMessage,
  type ArchitecturePattern,
  type ArchitecturePatternId,
  type ArchitectureSummary,
  type RegistryClient,
  type TeamRecord,
} from "../../api.js";
import { patternTopologyLabel } from "./architecture-dashboard-helpers.js";
import type { WebSessionLike } from "./architecture-dashboard-types.js";

function patternUnavailable(pattern: ArchitecturePattern): boolean {
  return pattern.status === "planned" || pattern.status === "unsupported";
}

/** Every gallery field, kept inside New architecture instead of on the page. */
export function PatternComparison({ patterns }: { patterns: ArchitecturePattern[] }) {
  return (
    <details className="cp-details architecture-pattern-comparison">
      <summary>Compare patterns</summary>
      <div className="cp-details-body">
        <p className="cp-muted">Existing shells keep their pattern. Derive a new shell to change it.</p>
        <div className="cp-pattern-list">
          {patterns.map((pattern) => (
            <article key={pattern.id}>
              <div className="cp-pattern-title"><h3>{pattern.name}</h3><span className="cp-chip">{pattern.version ? `v${pattern.version}` : pattern.status === "planned" ? "Planned" : "Available"}</span></div>
              <p>{pattern.description}</p>
              <p className="cp-muted">{patternTopologyLabel(pattern)}{patternUnavailable(pattern) ? " · Not available" : " · Available in New architecture"}</p>
            </article>
          ))}
        </div>
      </div>
    </details>
  );
}

export function CreateArchitectureCard({
  client,
  patterns,
  onCreated,
  onCancel,
  nameInputRef: externalNameInputRef,
}: {
  client: RegistryClient;
  session: WebSessionLike;
  patterns: ArchitecturePattern[];
  onCreated: (architecture: ArchitectureSummary) => void;
  onCancel?: () => void;
  nameInputRef?: RefObject<HTMLInputElement | null>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [patternId, setPatternId] = useState<ArchitecturePatternId>(patterns.find((item) => item.id === "multi-level-router")?.id ?? patterns[0]?.id ?? "flat");
  const [ownerSelection, setOwnerSelection] = useState("user");
  const [ownerTeams, setOwnerTeams] = useState<TeamRecord[]>([]);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const internalNameInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = externalNameInputRef ?? internalNameInputRef;
  const selectedPattern = patterns.find((item) => item.id === patternId);

  useEffect(() => {
    let active = true;
    void client.listTeams().then((dashboard) => {
      if (!active) return;
      setOwnerTeams(dashboard.teams.filter((team) => team.role === "owner"));
    }).catch(() => {
      if (!active) return;
      setOwnerTeams([]);
    });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    if (ownerSelection === "user" || ownerTeams.some((team) => `team:${team.id}` === ownerSelection)) return;
    setOwnerSelection("user");
  }, [ownerSelection, ownerTeams]);

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
      nameInputRef.current?.focus();
      return;
    }
    setState("saving");
    setMessage(null);
    try {
      const selectedTeam = ownerTeams.find((team) => `team:${team.id}` === ownerSelection);
      const created = await client.createArchitecture({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        patternId,
        owner: selectedTeam ? { type: "team", id: selectedTeam.id } : { type: "user" },
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
    <section className="architecture-create-panel" aria-labelledby="architecture-create-heading">
      <div className="cp-title-block">
        <h2 id="architecture-create-heading">New architecture</h2>
        <p className="cp-meta">Create a personal or team-owned draft shell. After it is created, build and save its first revision in the editor.</p>
      </div>
      <form className="architecture-create-form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>Name</span>
          <Input ref={nameInputRef} aria-describedby={message && !name.trim() ? "architecture-create-error" : undefined} aria-invalid={Boolean(message && !name.trim())} aria-label="Architecture name" disabled={state === "saving"} onChange={(event) => setName(event.target.value)} placeholder="Personal assistant stack" value={name} />
        </label>
        <label>
          <span>Description <small>(optional)</small></span>
          <textarea aria-label="Architecture description" disabled={state === "saving"} onChange={(event) => setDescription(event.target.value)} placeholder="What this architecture is for" value={description} />
        </label>
        <label>
          <span>Pattern</span>
          <select aria-describedby={selectedPattern ? "architecture-pattern-summary" : undefined} aria-label="Architecture pattern" disabled={state === "saving"} onChange={(event) => setPatternId(event.target.value)} value={patternId}>
            {patterns.map((pattern) => <option disabled={patternUnavailable(pattern)} key={pattern.id} value={pattern.id}>{pattern.name}{pattern.version ? ` · v${pattern.version}` : ""}</option>)}
          </select>
        </label>
        {selectedPattern && <p className="cp-muted" id="architecture-pattern-summary">{selectedPattern.description} {patternTopologyLabel(selectedPattern)}.</p>}
        <PatternComparison patterns={patterns} />
        <label>
          <span>Owner</span>
          <select aria-label="Architecture owner" disabled={state === "saving"} onChange={(event) => setOwnerSelection(event.target.value)} value={ownerSelection}>
            <option value="user">Personal (you)</option>
            {ownerTeams.map((team) => <option key={team.id} value={`team:${team.id}`}>Team · {team.name} ({team.slug})</option>)}
          </select>
        </label>
        {message && <div className="architecture-inline-message" id="architecture-create-error" role="alert" aria-live="assertive">{message}</div>}
        <div className="cp-actions">
          <Button className="architecture-create-button" disabled={state === "saving" || !name.trim()} size="sm" type="submit">
            <Plus size={15} aria-hidden="true" /> {state === "saving" ? "Creating…" : "Create architecture"}
          </Button>
          {onCancel && <Button disabled={state === "saving"} size="sm" type="button" variant="outline" onClick={onCancel}>Cancel</Button>}
        </div>
      </form>
    </section>
  );
}
