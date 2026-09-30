import type { ArchitectureTargetObservationRecord, ArchitectureTargetRecord } from "../../api.js";
import { targetInventoryLabels } from "./workspace-target.js";

const explanations: Readonly<Record<string, string>> = {
  "skills-location-absent": "The selected skills directory was absent; no skills were found there.",
  "skills-location-linked": "The skills directory is a link and was not followed.",
  "skills-location-unavailable": "The skills directory could not be read.",
  "skill-linked": "Linked skill directories were not followed.",
  "skill-name-invalid": "Entries with invalid skill names were omitted.",
  "skill-definition-missing": "Skill directories without SKILL.md were omitted.",
  "skill-definition-invalid": "Unreadable or invalid skill definitions were omitted.",
  "skill-name-withheld": "Skill names were withheld by the registry privacy filter.",
  "skill-hidden-skipped": "Hidden entries were skipped; hidden directories may contain additional skills.",
  "skill-entry-skipped": "Entries that are not skill directories were skipped.",
  "managed-install-state-ignored": "MySkills installation records were ignored.",
  "inventory-truncated": "The inventory limit was reached; some entries were not listed.",
};


function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown time";
}

export function TargetObservationCard({ target, observations }: { target: ArchitectureTargetRecord; observations: ArchitectureTargetObservationRecord[] }) {
  const inventory = targetInventoryLabels(target);
  const latest = observations.reduce<ArchitectureTargetObservationRecord | null>((current, candidate) => !current || Date.parse(candidate.observedAt) > Date.parse(current.observedAt) ? candidate : current, null);
  return <section className="cp-section" aria-labelledby="target-observations-heading">
    <div className="cp-section-head"><h3 id="target-observations-heading">Observations</h3><span className="cp-muted">{observations.length} recent</span></div>
    <p className="cp-muted">Only bounded counts and status metadata are shown here. Configuration contents, paths, prompts, and credentials are never rendered.</p>
    <dl className="cp-facts"><div><dt>Last observed</dt><dd>{latest ? <time dateTime={latest.observedAt}>{dateLabel(latest.observedAt)}</time> : "Not yet observed"}</dd></div></dl>
    {inventory && <p className="cp-muted">Inventory does not confirm that {inventory.provider} recognizes or loads these skills.</p>}
    {observations.length > 0 ? <div>{observations.map((observation) => {
      const complete = observation.metadata?.inventoryComplete;
      return <section className="cp-section" key={observation.id ?? observation.observedDigest} aria-label={`Observation ${dateLabel(observation.observedAt)}`}>
        <div className="cp-section-head"><strong><time dateTime={observation.observedAt}>{dateLabel(observation.observedAt)}</time></strong><span className="cp-chip">Generation {observation.targetGeneration}</span></div>
        <p>{inventory ? `${observation.skills.length} skills · ${observation.configFindings.length} finding types` : `${observation.skills.length} skills · ${observation.configFindings.length} config findings · prompt detected: ${observation.promptAwareness.detected ? "yes" : "no"}`}</p>
        {inventory ? <><span className="cp-chip" data-tone={complete === false ? "amber" : undefined}>{complete === true ? "Inventory complete" : complete === false ? "Inventory incomplete" : "Completeness not reported"}</span>{complete === false && <p className="cp-muted">This observation was received, but some entries could not be listed. Check the findings and run the local inventory command for details.</p>}</> : null}
        {observation.configFindings.length > 0 && <dl className="cp-facts">{observation.configFindings.map((finding, index) => <div key={`${finding.code}-${index}`}><dt><code>{finding.code}</code></dt><dd><strong>{finding.count}</strong> · {finding.severity}<p className="cp-muted">{explanations[finding.code] ?? "Check the local adapter report for details of this finding."}</p></dd></div>)}</dl>}
      </section>;
    })}</div> : <p className="cp-muted"><strong>No observations yet.</strong> {target.consent.status === "granted" ? "Run the CLI observation command with --upload, then refresh this page." : "Grant consent before an adapter can report state."}</p>}
  </section>;
}
