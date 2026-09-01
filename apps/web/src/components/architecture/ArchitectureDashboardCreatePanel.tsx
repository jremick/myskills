import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  GitBranch,
  Plus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

export function PatternGallery({ patterns }: { patterns: ArchitecturePattern[] }) {
  return (
    <section className="architecture-patterns" aria-labelledby="architecture-patterns-heading">
      <div className="architecture-section-heading">
        <div>
          <p className="architecture-kicker">Pattern reference</p>
          <h2 id="architecture-patterns-heading">Available architecture patterns</h2>
        </div>
        <span className="architecture-section-note">Choose a pattern in New architecture. Existing shells keep their pattern; derive a new shell to change it.</span>
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
                  {patternTopologyLabel(pattern)}
                  {disabled ? " · Not available" : " · Available in New architecture"}
                </span>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function CreateArchitectureCard({
  client,
  session,
  patterns,
  onCreated,
}: {
  client: RegistryClient;
  session: WebSessionLike;
  patterns: ArchitecturePattern[];
  onCreated: (architecture: ArchitectureSummary) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [patternId, setPatternId] = useState<ArchitecturePatternId>(patterns.find((item) => item.id === "multi-level-router")?.id ?? patterns[0]?.id ?? "flat");
  const [ownerSelection, setOwnerSelection] = useState("user");
  const [ownerTeams, setOwnerTeams] = useState<TeamRecord[]>([]);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

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
    <Card className="architecture-create-card" aria-label="Create architecture">
      <CardHeader className="architecture-card-heading">
        <div className="architecture-card-heading-icon"><Plus size={17} aria-hidden="true" /></div>
        <div>
          <CardTitle>New architecture</CardTitle>
          <CardDescription>Create a personal or team-owned draft shell. Add its first immutable revision through the API contract.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
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
            <select aria-label="Architecture pattern" disabled={state === "saving"} onChange={(event) => setPatternId(event.target.value)} value={patternId}>
              {patterns.map((pattern) => <option disabled={pattern.status === "planned" || pattern.status === "unsupported"} key={pattern.id} value={pattern.id}>{pattern.name}{pattern.version ? ` · v${pattern.version}` : ""}</option>)}
            </select>
          </label>
          <label>
            <span>Owner</span>
            <select aria-label="Architecture owner" disabled={state === "saving"} onChange={(event) => setOwnerSelection(event.target.value)} value={ownerSelection}>
              <option value="user">Personal · {session.user.email}</option>
              {ownerTeams.map((team) => <option key={team.id} value={`team:${team.id}`}>Team · {team.name} ({team.slug})</option>)}
            </select>
          </label>
          {message && <div className="architecture-inline-message" id="architecture-create-error" role="alert" aria-live="assertive">{message}</div>}
          <Button className="architecture-create-button" disabled={state === "saving" || !name.trim()} size="sm" type="submit">
            <Plus size={15} aria-hidden="true" /> {state === "saving" ? "Creating…" : "Create architecture"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
