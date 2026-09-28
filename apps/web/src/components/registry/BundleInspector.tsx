import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bookmark, PencilLine, RotateCw } from "lucide-react";
import type { BundleMember, BundleMembership, BundleSummary } from "@myskills-app/core";
import { Button } from "@/components/ui/button";
import type { BundleClient } from "../../bundle-api.js";
import { MEMBER_PAGE_SIZE, uniqueMembers, validMembers } from "./BundleData.js";
import { Attribution, BundleCluster, KindBadge, SkillLink } from "./BundleParts.js";
import { PARTIAL_NOTICE, VISIBILITY_LABELS, bundleError, countLabel, domId, failureKind, inAppClick } from "./BundleUtils.js";

type DetailState =
  | { status: "loading" }
  | { status: "ready"; bundle: BundleSummary }
  | { status: "unavailable" }
  | { status: "error"; message: string };

interface MembersState { status: "loading" | "ready" | "error"; skills: BundleMember[]; total: number; nextCursor: string | null; loadingMore: boolean; error: string | null; changed: boolean }
const LOADING_MEMBERS: MembersState = { status: "loading", skills: [], total: 0, nextCursor: null, loadingMore: false, error: null, changed: false };

export interface BundleDetailProps {
  /** Member pages reported lost access; the catalog should re-check what is visible. */
  onAccessLost: () => void;
  api: BundleClient;
  bundleId: string;
  reloadKey: number;
  back: ReactNode;
  canSave: boolean;
  savedMessage: string | null;
  saveRef: (element: HTMLButtonElement | null) => void;
  editRef: (element: HTMLButtonElement | null) => void;
  onSave: (bundle: BundleSummary) => void;
  onEdit: (bundle: BundleSummary) => void;
  skillHref: (slug: string) => string;
  bundleHref: (id: string) => string;
  onOpenSkill: (slug: string, from: HTMLElement) => void;
  onOpenBundle: (id: string, from: HTMLElement) => void;
}

/** Current authorized bundle detail. Every failure clears what was shown before. */
export function BundleDetail(props: BundleDetailProps) {
  const { api, bundleId, reloadKey } = props;
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [members, setMembers] = useState<MembersState>(LOADING_MEMBERS);
  const epoch = useRef(0);
  const accessLost = useRef(props.onAccessLost);
  accessLost.current = props.onAccessLost;

  /**
   * Lost access clears the bundle's metadata as well as its members. A changed
   * snapshot drops loaded members and asks for a refresh. Only a transient
   * failure on a later page keeps what already loaded.
   */
  const failMembers = useCallback((error: unknown, laterPage: boolean) => {
    const kind = failureKind(error);
    if (kind === "access") {
      setMembers(LOADING_MEMBERS);
      setState({ status: "unavailable" });
      accessLost.current();
      return;
    }
    if (kind === "changed") {
      setMembers({ ...LOADING_MEMBERS, status: "error", changed: true, error: "This bundle changed while you were browsing. Refresh it to see its current skills." });
      return;
    }
    setMembers((current) => laterPage && current.status === "ready"
      ? { ...current, loadingMore: false, error: bundleError(error, "More skills couldn’t load. Try again.") }
      : { ...LOADING_MEMBERS, status: "error", error: bundleError(error, "Skills in this bundle couldn’t load.") });
  }, []);

  // Keyed by bundle id, so a refresh keeps the current view until the server
  // answers; any failure then replaces it rather than leaving stale detail.
  useEffect(() => {
    const ticket = ++epoch.current;
    api.get(bundleId).then(({ bundle }) => {
      if (ticket !== epoch.current) return;
      if (!bundle || bundle.id !== bundleId) { setMembers(LOADING_MEMBERS); setState({ status: "unavailable" }); return; }
      setMembers((current) => current.status === "ready" ? current : LOADING_MEMBERS);
      setState({ status: "ready", bundle });
      return api.members(bundleId, { limit: MEMBER_PAGE_SIZE }).then(validMembers).then((page) => {
        if (ticket !== epoch.current) return;
        setMembers({ status: "ready", skills: page.skills, total: page.total, nextCursor: page.nextCursor, loadingMore: false, error: null, changed: false });
      }, (error: unknown) => {
        if (ticket === epoch.current) failMembers(error, false);
      });
    }, (error: unknown) => {
      if (ticket !== epoch.current) return;
      setMembers(LOADING_MEMBERS);
      setState(failureKind(error) === "access" ? { status: "unavailable" } : { status: "error", message: bundleError(error, "Check your connection and try again.") });
    });
    return () => { epoch.current++; };
  }, [api, bundleId, failMembers, reloadKey, retry]);

  const moreMembers = useCallback(() => {
    const cursor = members.nextCursor;
    if (!cursor || members.loadingMore) return;
    const ticket = epoch.current;
    setMembers((current) => ({ ...current, loadingMore: true, error: null }));
    api.members(bundleId, { limit: MEMBER_PAGE_SIZE, cursor }).then(validMembers).then((page) => {
      if (ticket !== epoch.current) return;
      setMembers((current) => ({ ...current, skills: uniqueMembers([...current.skills, ...page.skills]), total: page.total, nextCursor: page.nextCursor, loadingMore: false }));
    }, (error: unknown) => {
      if (ticket === epoch.current) failMembers(error, true);
    });
  }, [api, bundleId, failMembers, members.loadingMore, members.nextCursor]);

  const titleId = domId("bundle-detail-title", bundleId);
  if (state.status !== "ready") {
    return (
      <aside aria-label={state.status === "unavailable" ? undefined : "Bundle detail"} aria-labelledby={state.status === "unavailable" ? titleId : undefined} className="bundle-inspector-panel" aria-busy={state.status === "loading"}>
        {props.back}
        {state.status === "loading" && <><p className="bundle-sr" role="status">Loading bundle…</p><div aria-hidden="true" className="bundle-skeleton is-detail"><span /><span /><span /></div></>}
        {state.status === "unavailable" && (
          <div className="bundle-detail-state">
            <h2 data-detail-heading="" id={titleId} tabIndex={-1}>Bundle unavailable</h2>
            <p>This bundle doesn’t exist or you no longer have access to it.</p>
          </div>
        )}
        {state.status === "error" && (
          <div className="bundle-detail-state">
            <h2 data-detail-heading="" tabIndex={-1}>This bundle couldn’t load.</h2>
            <p>{state.message}</p>
            <Button size="sm" type="button" variant="outline" onClick={() => setRetry((value) => value + 1)}><RotateCw aria-hidden="true" size={14} />Retry bundle</Button>
          </div>
        )}
      </aside>
    );
  }

  const { bundle } = state;
  return (
    <aside aria-labelledby={titleId} className="bundle-inspector-panel">
      {props.back}
      <header className="bundle-detail-head">
        <BundleCluster bundle={bundle} large memberSlugs={members.skills.map((member) => member.skill.slug)} />
        <div className="bundle-detail-heading">
          <KindBadge kind={bundle.kind} />
          <h2 data-detail-heading="" id={titleId} tabIndex={-1}>{bundle.name}</h2>
          <p className="bundle-meta"><Attribution bundle={bundle} /></p>
        </div>
      </header>
      <p className="bundle-detail-purpose">{bundle.purpose}</p>
      <dl className="bundle-facts">
        <div><dt>Audience</dt><dd>{VISIBILITY_LABELS[bundle.visibility] ?? bundle.visibility}</dd></div>
        {bundle.kind === "source" && bundle.source ? (
          <>
            <div><dt>Source</dt><dd><span className="bundle-mono">{bundle.source.fullName}</span>{bundle.source.path ? <> · <span className="bundle-mono">{bundle.source.path}</span></> : null}</dd></div>
            <div><dt>Membership</dt><dd>Members come from reviewed imports in this selected source. Membership changes require curator review.</dd></div>
          </>
        ) : (
          <div><dt>Membership</dt><dd>Chosen by {bundle.owner.name} across sources. Each skill keeps its own source, version and review history.</dd></div>
        )}
        <div><dt>Updated</dt><dd>{formatDate(bundle.updatedAt)} · revision {bundle.revision}</dd></div>
      </dl>
      {(props.canSave || bundle.canEdit) && (
        <div className="bundle-detail-actions">
          {props.canSave && <Button ref={props.saveRef} size="sm" type="button" onClick={() => props.onSave(bundle)}><Bookmark aria-hidden="true" size={14} />Save bundle to library</Button>}
          {bundle.canEdit && <Button ref={props.editRef} size="sm" type="button" variant="outline" onClick={() => props.onEdit(bundle)}><PencilLine aria-hidden="true" size={14} />Edit bundle</Button>}
        </div>
      )}
      {props.savedMessage && <p className="bundle-saved" role="status">{props.savedMessage}</p>}
      <section className="bundle-detail-section" aria-labelledby={`${titleId}-members`}>
        <h3 id={`${titleId}-members`}>Skills in this bundle <span className="bundle-count">{countLabel(bundle)}</span></h3>
        {bundle.partial && <p className="bundle-notice">{PARTIAL_NOTICE}</p>}
        {members.status === "loading" && <p className="bundle-rail-state" role="status">Loading skills…</p>}
        {members.status === "error" && (
          <div className="bundle-inline-error" role="alert">
            <p>{members.error}</p>
            <Button size="sm" type="button" variant="outline" onClick={() => setRetry((value) => value + 1)}>{members.changed ? "Refresh bundle" : "Retry skills"}</Button>
          </div>
        )}
        {members.status === "ready" && (
          <ul className="bundle-detail-members">
            {members.skills.map((member) => (
              <li key={member.skill.slug}>
                <SkillLink current={false} href={props.skillHref(member.skill.slug)} id={domId("detail-skill", bundle.id, member.skill.slug)} onOpen={(from) => props.onOpenSkill(member.skill.slug, from)} skill={member.skill} />
                <span className="bundle-version">{member.skill.latestVersion ?? "No release"}</span>
                <OtherBundles bundleHref={props.bundleHref} exclude={bundle.id} memberships={member.memberships} onOpenBundle={props.onOpenBundle} />
              </li>
            ))}
          </ul>
        )}
        {members.status === "ready" && members.nextCursor && (
          <div className="bundle-rail-more">
            <span>Showing {members.skills.length} of {members.total}</span>
            <Button disabled={members.loadingMore} size="sm" type="button" variant="outline" onClick={moreMembers}>{members.loadingMore ? "Loading…" : "Show more members"}<span className="bundle-sr"> in {bundle.name}</span></Button>
          </div>
        )}
        {members.status === "ready" && members.error && <p className="bundle-inline-error" role="alert">{members.error}</p>}
      </section>
      <p className="bundle-fine">A bundle describes purpose and membership. It doesn’t pin versions, grant access or install anything.</p>
    </aside>
  );
}

function OtherBundles({ memberships, exclude, bundleHref, onOpenBundle }: { memberships: BundleMembership[]; exclude: string; bundleHref: (id: string) => string; onOpenBundle: (id: string, from: HTMLElement) => void }) {
  const others = memberships.filter((item) => item.id !== exclude);
  if (others.length === 0) return null;
  return (
    <span className="bundle-also">
      Also in{" "}
      {others.map((item, index) => (
        <span key={item.id}>
          {index > 0 && ", "}
          <a href={bundleHref(item.id)} id={domId("also", exclude, item.id)} onClick={(event) => inAppClick(event, () => onOpenBundle(item.id, event.currentTarget))}>{item.name}</a>
        </span>
      ))}
    </span>
  );
}

/**
 * Backlinks from a skill to every visible bundle that contains it. An empty
 * answer covers visible bundles only, so it never says the skill stands alone.
 */
export function BundleMemberships({ api, slug, bundleHref, onOpenBundle }: { api: BundleClient; slug: string; bundleHref: (id: string) => string; onOpenBundle: (id: string, from: HTMLElement) => void }) {
  const [state, setState] = useState<{ slug: string; status: "loading" | "ready" | "error"; bundles: BundleMembership[] }>({ slug, status: "loading", bundles: [] });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ slug, status: "loading", bundles: [] });
    api.memberships(slug).then(({ bundles }) => {
      if (active) setState(Array.isArray(bundles) ? { slug, status: "ready", bundles } : { slug, status: "error", bundles: [] });
    }, () => { if (active) setState({ slug, status: "error", bundles: [] }); });
    return () => { active = false; };
  }, [api, slug, retry]);
  const current = state.slug === slug ? state : { status: "loading" as const, bundles: [] };
  return (
    <section aria-label="Bundles containing this skill" className="bundle-memberships">
      <h3>Bundles</h3>
      {current.status === "loading" && <p className="bundle-muted" role="status">Checking bundles…</p>}
      {current.status === "error" && <p className="bundle-muted">Bundles couldn’t load. <button className="bundle-text-button" type="button" onClick={() => setRetry((value) => value + 1)}>Retry bundles</button></p>}
      {current.status === "ready" && current.bundles.length === 0 && <p className="bundle-muted">None visible to you</p>}
      {current.status === "ready" && current.bundles.length > 0 && (
        <ul>
          {current.bundles.map((bundle) => (
            <li key={bundle.id}>
              <a href={bundleHref(bundle.id)} id={domId("member-of", slug, bundle.id)} onClick={(event) => inAppClick(event, () => onOpenBundle(bundle.id, event.currentTarget))}>{bundle.name}</a>
              <KindBadge kind={bundle.kind} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function BundleLegend() {
  return (
    <aside aria-labelledby="bundle-legend-title" className="bundle-inspector-panel is-legend">
      <h2 id="bundle-legend-title">Inspect before you save</h2>
      <p className="bundle-detail-purpose">Select a bundle or skill to see what it holds, where it comes from and which bundles include it.</p>
      <dl className="bundle-legend">
        <div><dt><KindBadge kind="source" /></dt><dd>Built from reviewed imports in one selected source. Membership changes require curator review.</dd></div>
        <div><dt><KindBadge kind="curated" /></dt><dd>Chosen by a named person or team across sources, with numbered revisions.</dd></div>
      </dl>
      <p className="bundle-fine">Saving a bundle stores a reference in a library. It never adopts, installs or follows updates.</p>
    </aside>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
