import { useCallback, useEffect, useRef, useState } from "react";
import type { BundleMember, BundleMembersPage, RegistryCatalog, RegistryCatalogRow, RegistryView } from "@myskills-app/core";
import type { BundleClient } from "../../bundle-api.js";
import { bundleError, errorStatus, failureKind } from "./BundleUtils.js";

export const CATALOG_PAGE_SIZE = 25;
export const MEMBER_PAGE_SIZE = 25;

export interface CatalogState {
  /** "changed": the authorized snapshot moved mid-paging; rows were cleared until refresh. */
  status: "loading" | "ready" | "error" | "changed";
  /** The query and view the rows belong to, which can lag the typed query. */
  query: string;
  view: RegistryView;
  rows: RegistryCatalogRow[];
  totalSkills: number;
  totalBundles: number;
  nextCursor: string | null;
  error: string | null;
  loadingMore: boolean;
  moreError: { changed: boolean; message: string } | null;
}

const emptyCatalog = (query: string, view: RegistryView): CatalogState => ({ status: "loading", query, view, rows: [], totalSkills: 0, totalBundles: 0, nextCursor: null, error: null, loadingMore: false, moreError: null });

/** Totals shown to readers must come from a well-formed server response. */
function validCatalog(page: RegistryCatalog): RegistryCatalog {
  if (!page || !Array.isArray(page.rows) || !Number.isFinite(page.totalSkills) || !Number.isFinite(page.totalBundles)) throw new Error("Invalid catalog response.");
  return page;
}

export function validMembers(page: BundleMembersPage): BundleMembersPage {
  if (!page || !Array.isArray(page.skills) || !Number.isFinite(page.total)) throw new Error("Invalid bundle members response.");
  return page;
}

/** Top-level rows for one authorized query and view. Late responses are ignored. */
export function useCatalog(api: BundleClient, rawQuery: string, view: RegistryView, onUnavailable: () => void) {
  const query = rawQuery.trim();
  const [state, setState] = useState<CatalogState>(() => emptyCatalog(query, view));
  const [reloadKey, setReloadKey] = useState(0);
  // Member pages are cached per generation. Refreshes, lost access and snapshot
  // changes start a new generation, so cached member names are never revived.
  const [memberScope, setMemberScope] = useState(0);
  const epoch = useRef(0);
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;

  useEffect(() => {
    const ticket = ++epoch.current;
    setState((current) => ({ ...current, status: "loading", error: null, loadingMore: false, moreError: null }));
    api.catalog({ ...(query ? { query } : {}), view, limit: CATALOG_PAGE_SIZE }).then(validCatalog).then((page) => {
      if (ticket !== epoch.current) return;
      setState({ status: "ready", query, view, rows: page.rows, totalSkills: page.totalSkills, totalBundles: page.totalBundles, nextCursor: page.nextCursor, error: null, loadingMore: false, moreError: null });
    }, (error: unknown) => {
      if (ticket !== epoch.current) return;
      if (errorStatus(error) === 404) { unavailable.current(); return; }
      if (failureKind(error) !== "failed") setMemberScope((value) => value + 1);
      // Never keep rows from an earlier query after a failure.
      setState({ ...emptyCatalog(query, view), status: "error", error: bundleError(error, "The registry may be offline. Try again shortly.") });
    });
    return () => { epoch.current++; };
  }, [api, query, view, reloadKey]);

  const loadMore = useCallback(async () => {
    const cursor = state.nextCursor;
    if (!cursor || state.loadingMore || state.status !== "ready") return;
    const ticket = epoch.current;
    setState((current) => ({ ...current, loadingMore: true, moreError: null }));
    try {
      const page = validCatalog(await api.catalog({ ...(state.query ? { query: state.query } : {}), view: state.view, cursor, limit: CATALOG_PAGE_SIZE }));
      if (ticket !== epoch.current) return;
      setState((current) => ({ ...current, rows: dedupeRows([...current.rows, ...page.rows]), nextCursor: page.nextCursor, totalSkills: page.totalSkills, totalBundles: page.totalBundles, loadingMore: false }));
    } catch (error) {
      if (ticket !== epoch.current) return;
      const kind = failureKind(error);
      if (kind !== "failed") {
        // Lost access and snapshot changes (which include revocations) can make
        // loaded rows, totals and member names unauthorized: drop them all.
        setMemberScope((value) => value + 1);
        setState((current) => kind === "access"
          ? { ...emptyCatalog(current.query, current.view), status: "error", error: "Your access changed, so the loaded results were cleared. Retry to see what you can access now." }
          : { ...emptyCatalog(current.query, current.view), status: "changed", moreError: { changed: true, message: "The catalog changed while you were browsing. Refresh to see current results." } });
        return;
      }
      setState((current) => ({ ...current, loadingMore: false, moreError: { changed: false, message: bundleError(error, "More results couldn’t load. Try again.") } }));
    }
  }, [api, state.nextCursor, state.loadingMore, state.query, state.status, state.view]);

  const reload = useCallback(() => {
    setMemberScope((value) => value + 1);
    setReloadKey((value) => value + 1);
  }, []);
  return { state, loadMore, reload, memberScope };
}

function dedupeRows(rows: RegistryCatalogRow[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.kind === "bundle" ? `b:${row.bundle.id}` : `s:${row.skill.slug}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface MemberPage {
  status: "loading" | "ready" | "error";
  skills: BundleMember[];
  total: number;
  nextCursor: string | null;
  match: BundleMembersPage["match"];
  loadingMore: boolean;
  error: string | null;
  /** Set on "error": access and changed failures have already dropped loaded names. */
  problem: ReturnType<typeof failureKind> | null;
}

const loadingPage: MemberPage = { status: "loading", skills: [], total: 0, nextCursor: null, match: "all", loadingMore: false, error: null, problem: null };

const MEMBER_FAILURES = {
  access: "You no longer have access to this bundle’s skills.",
  changed: "This bundle changed while you were browsing.",
};

/**
 * Member pages per bundle for one query scope. A new scope drops every page, and
 * responses for an older scope are discarded.
 */
export function useMemberPages(api: BundleClient, query: string, scopeKey: number) {
  const scope = `${scopeKey}\u0000${query}`;
  const [store, setStore] = useState<{ scope: string; pages: Record<string, MemberPage> }>({ scope, pages: {} });
  const requested = useRef({ scope, keys: new Set<string>() });
  if (requested.current.scope !== scope) requested.current = { scope, keys: new Set() };
  const pages = store.scope === scope ? store.pages : {};

  const load = useCallback((bundleId: string, cursor?: string) => {
    const requestKey = `${bundleId}\u0000${cursor ?? ""}`;
    const keys = requested.current.keys;
    if (requested.current.scope !== scope || keys.has(requestKey)) return;
    keys.add(requestKey);
    const write = (update: (page: MemberPage | undefined) => MemberPage) => setStore((current) => {
      const base = current.scope === scope ? current.pages : {};
      return { scope, pages: { ...base, [bundleId]: update(base[bundleId]) } };
    });
    write((page) => cursor && page ? { ...page, loadingMore: true, error: null } : loadingPage);
    api.members(bundleId, { ...(query ? { query } : {}), limit: MEMBER_PAGE_SIZE, ...(cursor ? { cursor } : {}) }).then(validMembers).then((result) => {
      setStore((current) => {
        if (current.scope !== scope) return current;
        const previous = current.pages[bundleId];
        const skills = cursor && previous ? uniqueMembers([...previous.skills, ...result.skills]) : result.skills;
        return { scope, pages: { ...current.pages, [bundleId]: { status: "ready", skills, total: result.total, nextCursor: result.nextCursor, match: result.match, loadingMore: false, error: null, problem: null } } };
      });
    }, (error: unknown) => {
      keys.delete(requestKey);
      const problem = failureKind(error);
      setStore((current) => {
        if (current.scope !== scope) return current;
        const previous = current.pages[bundleId];
        // A transient failure on a later page keeps what loaded. Lost access or a
        // changed snapshot drops every loaded name, which may no longer be visible.
        const page: MemberPage = problem === "failed" && cursor && previous
          ? { ...previous, loadingMore: false, error: bundleError(error, "More skills couldn’t load. Try again.") }
          : { ...loadingPage, status: "error", problem, error: problem === "failed" ? bundleError(error, "Skills in this bundle couldn’t load.") : MEMBER_FAILURES[problem] };
        return { scope, pages: { ...current.pages, [bundleId]: page } };
      });
    });
  }, [api, query, scope]);

  const retry = useCallback((bundleId: string) => {
    const keys = requested.current.keys;
    for (const key of keys) if (key.startsWith(`${bundleId}\u0000`)) keys.delete(key);
    load(bundleId);
  }, [load]);

  return { pages, load, retry };
}

export function uniqueMembers(members: BundleMember[]) {
  return [...new Map(members.map((member) => [member.skill.slug, member])).values()];
}

const EXPANSION_KEY = "myskills-app:registry-bundle-expansion";

function readExpansion(): { seeded: boolean; open: Record<string, boolean> } {
  try {
    const value = JSON.parse(window.localStorage.getItem(EXPANSION_KEY) ?? "null") as unknown;
    if (value && typeof value === "object" && "open" in value && value.open && typeof value.open === "object") {
      return { seeded: true, open: Object.fromEntries(Object.entries(value.open).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")) };
    }
  } catch { /* Preferences are optional. */ }
  return { seeded: false, open: {} };
}

/**
 * The reader's own expansion choices, shared by Grouped and Outline, plus
 * search-time overrides that belong to one query and vanish when it changes.
 */
export function useExpansion() {
  const [user, setUser] = useState(readExpansion);
  const [search, setSearch] = useState<{ query: string; open: Record<string, boolean> }>({ query: "", open: {} });

  useEffect(() => {
    if (!user.seeded) return;
    try { window.localStorage.setItem(EXPANSION_KEY, JSON.stringify({ open: user.open })); } catch { /* Storage can be unavailable. */ }
  }, [user]);

  const isOpen = useCallback((key: string, query: string, reveal: boolean, fallback: boolean) => {
    if (query) {
      const override = search.query === query ? search.open[key] : undefined;
      if (override !== undefined) return override;
      if (reveal) return true;
    }
    return user.open[key] ?? fallback;
  }, [search, user]);

  const toggle = useCallback((key: string, query: string, current: boolean) => {
    if (query) setSearch((value) => ({ query, open: { ...(value.query === query ? value.open : {}), [key]: !current } }));
    else setUser((value) => ({ seeded: true, open: { ...value.open, [key]: !current } }));
  }, []);

  /** First visit: open the first bundle so the grouped view shows what a bundle holds. */
  const seed = useCallback((key: string) => {
    setUser((value) => value.seeded ? value : { seeded: true, open: { [key]: true } });
  }, []);

  return { isOpen, toggle, seed };
}
