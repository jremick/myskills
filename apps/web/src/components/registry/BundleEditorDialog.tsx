import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { BundleInput, BundleKind, BundleSourceSelection, BundleSummary, BundleVisibility, PublicSkill } from "@myskills-app/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { BundleClient } from "../../bundle-api.js";
import type { TeamDashboard, TeamRecord } from "../../api.js";
import { BundleModal, Tile } from "./BundleParts.js";
import { VISIBILITY_LABELS, bundleError, errorStatus, plural } from "./BundleUtils.js";

const AUDIENCES: BundleVisibility[] = ["public", "authenticated", "team", "private"];

async function allMembers(api: BundleClient, bundleId: string) {
  const skills: PublicSkill[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 40; page += 1) {
    const result = await api.members(bundleId, { limit: 100, ...(cursor ? { cursor } : {}) });
    skills.push(...result.skills.map((member) => member.skill));
    if (!result.nextCursor) return skills;
    cursor = result.nextCursor;
  }
  throw new Error("This bundle has more members than the editor can load.");
}

interface Draft { name: string; purpose: string; visibility: BundleVisibility; members: PublicSkill[]; revision: number }

/**
 * Basic create/edit form. Curated bundles pick registry skills; source groups
 * review members of one accepted source selection. The reader must confirm the
 * audience and members before any write, and stale revisions are never forced.
 */
export function BundleEditorDialog({ api, listTeams, editing, onCancel, onSaved }: { api: BundleClient; listTeams?: () => Promise<TeamDashboard>; editing: BundleSummary | null; onCancel: () => void; onSaved: (bundle: BundleSummary) => void }) {
  const [kind, setKind] = useState<BundleKind>(editing?.kind ?? "curated");
  const [owner, setOwner] = useState(editing?.owner.type === "team" ? editing.owner.id : "user");
  const [draft, setDraft] = useState<Draft>({ name: editing?.name ?? "", purpose: editing?.purpose ?? "", visibility: editing?.visibility ?? "private", members: [], revision: editing?.revision ?? 0 });
  const [loadingCurrent, setLoadingCurrent] = useState(Boolean(editing));
  const [sourceEntryId, setSourceEntryId] = useState(editing?.source?.entryId ?? "");
  const [sources, setSources] = useState<{ status: "idle" | "loading" | "ready" | "error"; items: BundleSourceSelection[] }>({ status: "idle", items: [] });
  const [teams, setTeams] = useState<TeamRecord[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<{ query: string; status: "idle" | "loading" | "ready" | "error"; skills: PublicSkill[] }>({ query: "", status: "idle", skills: [] });
  const searchEpoch = useRef(0);

  // Any change to what readers will see, or who owns it, needs a fresh review.
  const change = useCallback(<T,>(apply: (value: T) => void) => (value: T) => { apply(value); setReviewed(false); setError(null); }, []);

  const loadCurrent = useCallback(async (fresh: boolean) => {
    if (!editing) return;
    setLoadingCurrent(true);
    setError(null);
    try {
      const bundle = fresh ? (await api.get(editing.id)).bundle : editing;
      const members = await allMembers(api, editing.id);
      setDraft({ name: bundle.name, purpose: bundle.purpose, visibility: bundle.visibility, members, revision: bundle.revision });
      setReviewed(false);
    } catch (caught) {
      setError({ message: errorStatus(caught) === 404 || errorStatus(caught) === 403 ? "This bundle is no longer available to you." : bundleError(caught, "The current bundle couldn’t load. Try again."), conflict: false });
    } finally {
      setLoadingCurrent(false);
    }
  }, [api, editing]);

  useEffect(() => { void loadCurrent(false); }, [loadCurrent]);

  // Teams you currently own, read once when the dialog opens.
  const teamsLoader = useRef(listTeams);
  useEffect(() => {
    const load = teamsLoader.current;
    if (editing || !load) return;
    let active = true;
    load().then((result) => { if (active) setTeams(result.teams.filter((team) => team.role === "owner")); }, () => { if (active) setTeams([]); });
    return () => { active = false; };
  }, [editing]);

  useEffect(() => {
    if (kind !== "source" || sources.status !== "idle") return;
    setSources({ status: "loading", items: [] });
    api.sources().then((result) => setSources({ status: "ready", items: result.sources }), () => setSources({ status: "error", items: [] }));
  }, [api, kind, sources.status]);

  useEffect(() => {
    const query = search.trim();
    const ticket = ++searchEpoch.current;
    if (kind !== "curated" || !query) { setResults({ query, status: "idle", skills: [] }); return; }
    setResults((current) => ({ ...current, query, status: "loading" }));
    const timer = window.setTimeout(() => {
      api.catalog({ query, view: "list", limit: 10 }).then((page) => {
        if (ticket !== searchEpoch.current) return;
        setResults({ query, status: "ready", skills: page.rows.flatMap((row) => row.kind === "skill" ? [row.skill] : []) });
      }, () => { if (ticket === searchEpoch.current) setResults({ query, status: "error", skills: [] }); });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [api, kind, search]);

  const source = sources.items.find((item) => item.entryId === sourceEntryId) ?? null;
  const selected = new Set(draft.members.map((skill) => skill.slug));
  const notPublic = draft.visibility === "public" ? draft.members.filter((skill) => skill.visibility !== "public") : [];
  const sourceMissing = kind === "source" && sources.status === "ready" && Boolean(sourceEntryId) && !source;
  const teamOwned = editing ? editing.owner.type === "team" : owner !== "user";
  const teamAudienceNeedsTeam = draft.visibility === "team" && !teamOwned;
  const ready = draft.name.trim() && draft.purpose.trim() && draft.members.length > 0 && notPublic.length === 0 && !teamAudienceNeedsTeam && !sourceMissing && (kind === "curated" || source) && !loadingCurrent;
  const ownerName = editing ? editing.owner.name : owner === "user" ? "you" : teams.find((team) => team.id === owner)?.name ?? "a team";

  const toggleMember = change((skill: PublicSkill) => setDraft((current) => ({
    ...current,
    members: current.members.some((item) => item.slug === skill.slug) ? current.members.filter((item) => item.slug !== skill.slug) : [...current.members, skill],
  })));

  async function submit() {
    if (!ready || !reviewed || busy) return;
    // Source groups keep the source's own order and only its accepted skills.
    const members = kind === "source" && source ? source.skills.filter((skill) => selected.has(skill.slug)) : draft.members;
    const input: BundleInput = {
      kind,
      name: draft.name.trim(),
      purpose: draft.purpose.trim(),
      owner: editing ? (editing.owner.type === "team" ? { type: "team", id: editing.owner.id } : { type: "user" }) : owner === "user" ? { type: "user" } : { type: "team", id: owner },
      visibility: draft.visibility,
      memberSlugs: members.map((skill) => skill.slug),
      ...(kind === "source" && sourceEntryId ? { sourceEntryId } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const result = editing ? await api.update(editing.id, { ...input, expectedRevision: draft.revision }) : await api.create(input);
      onSaved(result.bundle);
    } catch (caught) {
      const conflict = Boolean(editing) && errorStatus(caught) === 409;
      setError({ conflict, message: conflict ? "This bundle changed since you opened it. Load the current version, review it, and try again." : bundleError(caught, editing ? "Your changes couldn’t be saved. Try again." : "The bundle couldn’t be created. Try again.") });
      setBusy(false);
    }
  }

  const titleId = "bundle-editor-title";
  return (
    <BundleModal className="is-wide" labelledBy={titleId} onCancel={onCancel}>
      <form className="bundle-dialog-body" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <h2 id={titleId}>{editing ? `Edit ${editing.name}` : "New bundle"}</h2>
        <p className="bundle-muted">A bundle names a set of related skills and explains why they belong together. It doesn’t install anything or grant access to its skills.</p>

        {!editing && (
          <fieldset className="bundle-fieldset is-inline">
            <legend>Bundle type</legend>
            <label className="bundle-option"><input checked={kind === "curated"} name="bundle-kind" type="radio" onChange={() => change(setKind)("curated")} />Curated collection</label>
            <label className="bundle-option"><input checked={kind === "source"} name="bundle-kind" type="radio" onChange={() => { change(setKind)("source"); setDraft((current) => ({ ...current, members: [] })); }} />Source group</label>
          </fieldset>
        )}

        <div className="bundle-field">
          <label htmlFor="bundle-name">Name</label>
          <Input id="bundle-name" maxLength={120} required value={draft.name} onChange={(event) => change((name: string) => setDraft((current) => ({ ...current, name })))(event.target.value)} />
        </div>
        <div className="bundle-field">
          <label htmlFor="bundle-purpose">Purpose</label>
          <Textarea aria-describedby="bundle-purpose-help" id="bundle-purpose" maxLength={500} required rows={2} value={draft.purpose} onChange={(event) => change((purpose: string) => setDraft((current) => ({ ...current, purpose })))(event.target.value)} />
          <p className="bundle-help" id="bundle-purpose-help">One line on what this set is for.</p>
        </div>
        <div className="bundle-field-row">
          <div className="bundle-field">
            <label htmlFor="bundle-owner">Owner</label>
            {editing ? <p className="bundle-static" id="bundle-owner">{editing.owner.name}</p> : (
              <select id="bundle-owner" value={owner} onChange={(event) => change((next: string) => {
                setOwner(next);
                // A team audience only makes sense for a team-owned bundle.
                if (next === "user") setDraft((current) => current.visibility === "team" ? { ...current, visibility: "private" } : current);
              })(event.target.value)}>
                <option value="user">You</option>
                {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select>
            )}
          </div>
          <div className="bundle-field">
            <label htmlFor="bundle-audience">Audience</label>
            <select aria-describedby="bundle-audience-help" id="bundle-audience" value={draft.visibility} onChange={(event) => change((value: BundleVisibility) => setDraft((current) => ({ ...current, visibility: value })))(event.target.value as BundleVisibility)}>
              {AUDIENCES.map((value) => <option disabled={value === "team" && !teamOwned && draft.visibility !== "team"} key={value} value={value}>{VISIBILITY_LABELS[value]}{value === "team" && !teamOwned ? " (needs a team owner)" : ""}</option>)}
            </select>
            <p className="bundle-help" id="bundle-audience-help">Who can see the bundle. Readers still only see skills they can already access.</p>
            {teamAudienceNeedsTeam && <p className="bundle-warning">A team audience needs a team owner. Choose a team you own under Owner, or pick another audience.</p>}
          </div>
        </div>

        {kind === "curated" ? (
          <div className="bundle-field">
            <label htmlFor="bundle-member-search">Find skills to add</label>
            <Input autoComplete="off" id="bundle-member-search" placeholder="Search by name, slug or summary" value={search} onChange={(event) => setSearch(event.target.value)} />
            {results.status === "loading" && <p className="bundle-help" role="status">Searching…</p>}
            {results.status === "error" && <p className="bundle-help" role="status">Search is unavailable. Try again.</p>}
            {results.status === "ready" && results.skills.length === 0 && <p className="bundle-help" role="status">No skills match “{results.query}”.</p>}
            {results.skills.length > 0 && (
              <ul aria-label="Search results" className="bundle-pick-list">
                {results.skills.map((skill) => (
                  <li key={skill.slug}>
                    <input checked={selected.has(skill.slug)} id={`bundle-pick-${skill.slug}`} type="checkbox" onChange={() => toggleMember(skill)} />
                    <label htmlFor={`bundle-pick-${skill.slug}`}>{skill.title}</label>
                    <span className="bundle-mono bundle-pick-meta">{skill.slug} · {VISIBILITY_LABELS[skill.visibility as BundleVisibility] ?? skill.visibility}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="bundle-field">
            <label htmlFor="bundle-source">Reviewed source</label>
            {editing ? <p className="bundle-static" id="bundle-source">{editing.source ? `${editing.source.fullName} · ${editing.source.path}` : "Source unavailable"}</p> : (
              <select disabled={sources.status !== "ready"} id="bundle-source" value={sourceEntryId} onChange={(event) => { change(setSourceEntryId)(event.target.value); setDraft((current) => ({ ...current, members: [] })); }}>
                <option value="">Choose a reviewed source</option>
                {sources.items.map((item) => <option key={item.entryId} value={item.entryId}>{item.title} · {item.path || "Repository root"}</option>)}
              </select>
            )}
            {sources.status === "loading" && <p className="bundle-help" role="status">Loading reviewed sources…</p>}
            {sources.status === "error" && <p className="bundle-help">Reviewed sources couldn’t load.</p>}
            {sources.status === "ready" && sources.items.length === 0 && <p className="bundle-help">No reviewed source selections yet. Import skills from a source in Libraries first.</p>}
            {sourceMissing && <p className="bundle-help">This source selection is no longer available for review.</p>}
            {source && (
              <fieldset className="bundle-fieldset">
                <legend>{editing ? "Membership review" : "Skills from this source"}</legend>
                <p className="bundle-help">Only skills from this accepted source selection can join the group.</p>
                <ul className="bundle-pick-list">
                  {source.skills.map((skill) => (
                    <li key={skill.slug}>
                      <input checked={selected.has(skill.slug)} id={`bundle-source-${skill.slug}`} type="checkbox" onChange={() => toggleMember(skill)} />
                      <label htmlFor={`bundle-source-${skill.slug}`}>{skill.title}</label>
                      <span className="bundle-mono bundle-pick-meta">{skill.slug}</span>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}
          </div>
        )}

        <section aria-labelledby="bundle-selected-title" className="bundle-selected">
          <h3 id="bundle-selected-title">Selected skills ({draft.members.length})</h3>
          {loadingCurrent ? <p className="bundle-help" role="status">Loading current members…</p> : draft.members.length === 0 ? <p className="bundle-help">No skills selected yet.</p> : (
            <ol aria-label="Selected skills">
              {draft.members.map((skill) => (
                <li key={skill.slug}>
                  <Tile slug={skill.slug} />
                  <span className="bundle-selected-name">{skill.title}<span className="bundle-mono bundle-pick-meta">{skill.slug} · {VISIBILITY_LABELS[skill.visibility as BundleVisibility] ?? skill.visibility}</span></span>
                  <Button aria-label={`Remove ${skill.title}`} size="icon-sm" type="button" variant="ghost" onClick={() => toggleMember(skill)}><X aria-hidden="true" size={14} /></Button>
                </li>
              ))}
            </ol>
          )}
          {notPublic.length > 0 && <p className="bundle-warning">Public bundles can only include public skills. {notPublic.map((skill) => skill.title).join(", ")} {notPublic.length === 1 ? "isn’t" : "aren’t"} public.</p>}
        </section>

        <div className="bundle-review">
          <input aria-describedby="bundle-review-summary" checked={reviewed} disabled={loadingCurrent} id="bundle-review" type="checkbox" onChange={(event) => setReviewed(event.target.checked)} />
          <label htmlFor="bundle-review">I reviewed the audience and selected skills</label>
          <small id="bundle-review-summary">{VISIBILITY_LABELS[draft.visibility]} · {plural(draft.members.length, "skill")} · owned by {ownerName}</small>
        </div>

        {error && (
          <div className="bundle-inline-error" role="alert">
            <p>{error.message}</p>
            {error.conflict && <Button disabled={loadingCurrent} size="sm" type="button" variant="outline" onClick={() => void loadCurrent(true)}>Load current version</Button>}
          </div>
        )}
        <div className="bundle-dialog-actions">
          <Button disabled={busy} type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button disabled={busy || !ready || !reviewed} type="submit">{busy ? "Saving…" : editing ? "Save changes" : "Create bundle"}</Button>
        </div>
      </form>
    </BundleModal>
  );
}
