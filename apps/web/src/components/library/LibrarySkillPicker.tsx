import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { PublicSkill } from "@myskills-app/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RegistryClient } from "../../api.js";

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 200;

interface Results {
  status: "loading" | "ready" | "error";
  /** The query these results answer. */
  query: string;
  skills: PublicSkill[];
  nextCursor: string | null;
  loadingMore: boolean;
  moreError: string | null;
}

const unique = (skills: PublicSkill[]) => [...new Map(skills.map((skill) => [skill.slug, skill])).values()];

/**
 * Chooses one authorised skill from paginated search results. Saving creates a
 * library reference only; it never adopts or installs.
 */
export function LibrarySkillPicker({ client, busy, primary, error, onChoose, onSave }: {
  client: RegistryClient;
  busy: boolean;
  primary: boolean;
  error: string | null;
  onChoose: () => void;
  onSave: (slug: string) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results>({ status: "loading", query: "", skills: [], nextCursor: null, loadingMore: false, moreError: null });
  const [selected, setSelected] = useState<PublicSkill | null>(null);
  const epoch = useRef(0);
  const seenCursors = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const first = useRef(true);
  const baseId = useId();

  // Every search starts a new epoch. Older searches and their "load more"
  // pages then fail the epoch check and are dropped.
  const run = useCallback(async (text: string) => {
    const ticket = ++epoch.current;
    seenCursors.current = new Set();
    setResults((current) => ({ ...current, status: "loading", loadingMore: false, moreError: null }));
    try {
      const page = client.searchSkillPage
        ? await client.searchSkillPage({ query: text, limit: PAGE_SIZE })
        : { skills: await client.searchSkills(text), nextCursor: null };
      if (ticket !== epoch.current) return;
      if (page.nextCursor) seenCursors.current.add(page.nextCursor);
      setResults({ status: "ready", query: text, skills: unique(page.skills), nextCursor: page.nextCursor, loadingMore: false, moreError: null });
    } catch {
      if (ticket === epoch.current) setResults({ status: "error", query: text, skills: [], nextCursor: null, loadingMore: false, moreError: null });
    }
  }, [client]);

  useEffect(() => {
    const delay = first.current ? 0 : DEBOUNCE_MS;
    first.current = false;
    timer.current = setTimeout(() => { timer.current = null; void run(query); }, delay);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query, run]);
  useEffect(() => () => { epoch.current++; }, []);

  async function more() {
    const cursor = results.nextCursor;
    if (!cursor || results.status !== "ready" || results.loadingMore || !client.searchSkillPage) return;
    const ticket = epoch.current;
    setResults((current) => ({ ...current, loadingMore: true, moreError: null }));
    try {
      const page = await client.searchSkillPage({ query: results.query, cursor, limit: PAGE_SIZE });
      if (ticket !== epoch.current) return;
      const repeated = Boolean(page.nextCursor && seenCursors.current.has(page.nextCursor));
      if (page.nextCursor) seenCursors.current.add(page.nextCursor);
      setResults((current) => ({
        ...current,
        skills: unique([...current.skills, ...page.skills]),
        nextCursor: repeated ? null : page.nextCursor,
        loadingMore: false,
        moreError: repeated ? "The skill list repeated a page, so loading stopped. Search again to refresh it." : null,
      }));
    } catch {
      if (ticket === epoch.current) setResults((current) => ({ ...current, loadingMore: false, moreError: "More skills couldn’t load." }));
    }
  }

  function searchNow() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    void run(query);
  }

  async function submit() {
    if (!selected || busy) return;
    if (await onSave(selected.slug)) { setSelected(null); setQuery(""); }
  }

  const trimmed = results.query.trim();
  return <form className="library-skill-picker" aria-label="Save a skill" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <label className="library-field">
      <span>Search skills</span>
      <span className="library-picker-search">
        <Search size={16} aria-hidden="true" />
        <Input
          type="search"
          value={query}
          placeholder="Title or slug"
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          // Enter searches immediately and never submits the save.
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); searchNow(); } }}
        />
      </span>
    </label>
    {results.status === "loading" && <p role="status" className="library-muted">Searching skills…</p>}
    {results.status === "error" && <div role="alert" className="library-alert library-actions">
      <span>Skills couldn’t load.</span>
      <Button type="button" size="sm" variant="outline" onClick={searchNow}>Retry search</Button>
    </div>}
    {results.status === "ready" && results.skills.length === 0 && <p role="status" className="library-muted">{trimmed ? `No skills match “${trimmed}”.` : "No skills are available to you yet."}</p>}
    {results.status === "ready" && results.skills.length > 0 && <fieldset className="library-picker-results" disabled={busy}>
      <legend>{trimmed ? `Skills matching “${trimmed}”` : "Skills you can use"}</legend>
      {results.skills.map((skill) => <label key={skill.slug} className="library-picker-option">
        <input type="radio" name={`${baseId}-skill`} value={skill.slug} checked={selected?.slug === skill.slug} onChange={() => { setSelected(skill); onChoose(); }} />
        <span className="library-picker-option-text"><span className="library-picker-option-title">{skill.title}</span>{" "}<code>{skill.slug}</code></span>
      </label>)}
    </fieldset>}
    {results.status === "ready" && results.nextCursor && <div className="library-actions">
      <Button type="button" size="sm" variant="ghost" disabled={results.loadingMore} onClick={() => void more()}>{results.loadingMore ? "Loading more skills…" : "Load more skills"}</Button>
    </div>}
    {results.moreError && <div role="alert" className="library-alert library-actions">
      <span>{results.moreError}</span>
      {results.nextCursor && <Button type="button" size="sm" variant="outline" onClick={() => void more()}>Retry</Button>}
    </div>}
    {error && <p role="alert" className="library-alert">{error}</p>}
    <div className="library-picker-foot">
      <span className="library-picker-selected">{selected ? <>Selected <strong>{selected.title}</strong> <code>{selected.slug}</code></> : "Choose a skill to save it as a reference."}</span>
      <Button type="submit" size="sm" variant={primary ? "default" : "outline"} disabled={busy || !selected}>Save skill</Button>
    </div>
  </form>;
}
