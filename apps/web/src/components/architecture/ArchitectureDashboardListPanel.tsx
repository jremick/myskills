import { patternLabel, architectureRevisionLabel } from "./architecture-dashboard-helpers.js";
import type { ArchitectureSummary } from "../../api.js";

export function ArchitectureList({ architectures, selectedId, onSelect, hidden = false }: { architectures: ArchitectureSummary[]; selectedId: string | null; onSelect: (id: string) => void; hidden?: boolean }) {
  return (
    <section className="cp-list" aria-labelledby="architecture-list-heading" hidden={hidden}>
      <div className="cp-list-label">
        <h2 id="architecture-list-heading">Saved architectures</h2>
        <span aria-live="polite">{architectures.length}</span>
      </div>
      {architectures.length === 0 ? (
        <div className="cp-list-state">
          <strong>No architectures yet.</strong>
          <p>Use New architecture to create a draft, then inspect its compiled router and leaf graph.</p>
        </div>
      ) : (
        <div className="cp-rows" role="list" aria-label="Saved architectures">
          {architectures.map((architecture) => {
            const selected = architecture.id === selectedId;
            return (
              <div key={architecture.id} role="listitem">
                <button aria-current={selected ? "true" : undefined} aria-pressed={selected} className="cp-row" data-architecture-id={architecture.id} type="button" onClick={() => onSelect(architecture.id)}>
                  <span className="cp-row-text">
                    <span className="cp-row-title">{architecture.name}</span>
                    <span className="cp-row-meta">{patternLabel(architecture.patternId)} · {architectureRevisionLabel(architecture)}</span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
