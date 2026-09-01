import {
  ChevronRight,
  GitBranch,
  Layers3,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { patternLabel, architectureRevisionLabel } from "./architecture-dashboard-helpers.js";
import type { ArchitectureSummary } from "../../api.js";

export function ArchitectureList({ architectures, selectedId, onSelect }: { architectures: ArchitectureSummary[]; selectedId: string | null; onSelect: (id: string) => void }) {
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
          <div className="architecture-list" role="list" aria-label="Saved architectures">
            {architectures.map((architecture) => {
              const selected = architecture.id === selectedId;
              return (
                <div key={architecture.id} role="listitem">
                  <button aria-current={selected ? "true" : undefined} aria-pressed={selected} className={selected ? "architecture-list-row selected" : "architecture-list-row"} type="button" onClick={() => onSelect(architecture.id)}>
                    <span className="architecture-list-icon"><GitBranch size={16} aria-hidden="true" /></span>
                    <span className="architecture-list-main">
                      <strong>{architecture.name}</strong>
                      <small>{patternLabel(architecture.patternId)} · {architectureRevisionLabel(architecture)}</small>
                    </span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
