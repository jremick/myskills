import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { safeReviewErrorMessage, type RegistryClient, type SkillManagementSummary } from "../../api.js";
import { chipTone, lifecycleLabel, tileTone, visibilityLabel } from "./status-display.js";

/**
 * The Can manage scope list. It reads the authorised management inventory
 * (archived skills and unpublished releases included), never a browser filter
 * over the readable catalog. Rows are links to the shared skill detail.
 */
export function ManagedSkillsInventory({
  client,
  hidden,
  onOpenSkill,
  query,
  reloadKey,
  selectedSlug,
  skillHref,
  stacked,
}: {
  client: RegistryClient;
  hidden: boolean;
  onOpenSkill: (slug: string) => void;
  query: string;
  reloadKey: number;
  selectedSlug: string | null;
  skillHref: (slug: string) => string;
  stacked: boolean;
}) {
  const [skills, setSkills] = useState<SkillManagementSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0);

  useEffect(() => {
    const current = ++epoch.current;
    setState("loading");
    setLoadingMore(false);
    setMessage(null);
    setCursor(null);
    if (!client.listManagedSkills) {
      setSkills([]);
      setMessage("Skill management is unavailable.");
      setState("error");
      return;
    }
    client.listManagedSkills({ query }).then((page) => {
      if (current !== epoch.current) return;
      setSkills(page.skills);
      setCursor(page.nextCursor ?? null);
      setState("ready");
    }).catch((error: unknown) => {
      if (current !== epoch.current) return;
      setSkills([]);
      setMessage(safeReviewErrorMessage(error));
      setState("error");
    });
    return () => { epoch.current += 1; };
  }, [client, query, reloadKey, retry]);

  const more = useCallback(async () => {
    if (!cursor || !client.listManagedSkills || loadingMore) return;
    const current = epoch.current;
    setLoadingMore(true);
    setMessage(null);
    try {
      const page = await client.listManagedSkills({ query, cursor });
      if (current !== epoch.current) return;
      setSkills((rows) => [...new Map([...rows, ...page.skills].map((skill) => [skill.slug, skill])).values()]);
      setCursor(page.nextCursor ?? null);
    } catch (error) {
      if (current === epoch.current) setMessage(safeReviewErrorMessage(error));
    } finally {
      if (current === epoch.current) setLoadingMore(false);
    }
  }, [client, cursor, loadingMore, query]);

  function open(event: MouseEvent<HTMLAnchorElement>, slug: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpenSkill(slug);
  }

  return (
    <section aria-busy={state === "loading"} aria-label="Managed skills" className="registry-results-panel registry-list" hidden={hidden}>
      <div className="registry-list-label">
        <h2>Can manage</h2>
        <span aria-live="polite">{state === "ready" ? (cursor ? `${skills.length} loaded` : String(skills.length)) : ""}</span>
      </div>
      {state === "loading" && skills.length === 0 && (
        <div className="registry-skeleton" role="status" aria-live="polite">
          <span className="sr-only">Loading managed skills…</span>
          {[0, 1, 2].map((item) => <div className="registry-skeleton-row" key={item}><span /><span /></div>)}
        </div>
      )}
      {state === "error" && (
        <div className="registry-list-state">
          <p role="alert"><strong>{message ?? "Managed skills could not load."}</strong></p>
          <Button size="sm" type="button" variant="outline" onClick={() => setRetry((value) => value + 1)}>
            <RotateCw size={15} aria-hidden="true" />
            Retry
          </Button>
        </div>
      )}
      {state !== "error" && skills.length > 0 && (
        <div className="registry-rows">
          {skills.map((skill) => {
            const status = lifecycleLabel(skill.lifecycleStatus);
            return (
              <a
                aria-current={!stacked && skill.slug === selectedSlug ? "true" : undefined}
                className="registry-row managed-skill-row"
                data-slug={skill.slug}
                href={skillHref(skill.slug)}
                key={skill.slug}
                onClick={(event) => open(event, skill.slug)}
              >
                <span className="registry-tile" data-tone={tileTone(skill.slug)} aria-hidden="true" />
                <span className="registry-row-text">
                  <span className="registry-row-title">{skill.title}</span>
                  {" "}
                  <span className="registry-row-meta"><code>{skill.slug}</code> <span>{visibilityLabel(skill.visibility)}</span></span>
                  {skill.lifecycleStatus !== "approved" && <>{" "}<span className="author-chips"><span className="registry-chip" data-tone={chipTone(status.tone)}>{status.label}</span></span></>}
                </span>
              </a>
            );
          })}
        </div>
      )}
      {state === "ready" && cursor && (
        <div className="registry-list-foot">
          <Button type="button" size="sm" variant="outline" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? "Loading…" : "Load more managed skills"}</Button>
        </div>
      )}
      {state === "ready" && message && <p className="registry-alert" role="alert">{message}</p>}
      {state === "ready" && skills.length === 0 && (
        <div className="registry-list-state">
          <strong>{query.trim() ? "No manageable skills match this search." : "You don't manage any skills yet."}</strong>
          <p>{query.trim() ? "The inventory includes archived skills and unpublished releases you can manage." : "Skills you submit or maintain appear here, including archived skills and unpublished releases."}</p>
        </div>
      )}
    </section>
  );
}
