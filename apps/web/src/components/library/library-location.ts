import type { LibraryClient } from "../../library-api.js";

// Libraries URL state: /libraries?library=&entry=&candidate=&filter=
// `filter` is not `q`, which App.tsx reads as the Skills search.
export interface LibraryLocation {
  library: string | null;
  entry: string | null;
  candidate: string | null;
  filter: string;
  view?: "entries" | "collections" | "groups";
  collection?: string | null;
  group?: string | null;
}

/** Upper bound for deliberate cursor walks. A repeated cursor also stops a walk. */
export const MAX_PAGES = 40;

export function librariesUrl(location: Partial<LibraryLocation>): string {
  const params = new URLSearchParams();
  if (location.library) params.set("library", location.library);
  if (location.library && location.view && location.view !== "entries") params.set("view", location.view);
  if (location.library && location.view === "collections" && location.collection) params.set("collection", location.collection);
  if (location.library && location.view === "groups" && location.group) params.set("group", location.group);
  if (location.library && location.entry) params.set("entry", location.entry);
  if (location.library && location.entry && location.candidate) params.set("candidate", location.candidate);
  if (location.filter?.trim()) params.set("filter", location.filter);
  const query = params.toString();
  return query ? `/libraries?${query}` : "/libraries";
}

export function readLibraryLocation(): LibraryLocation {
  const params = new URLSearchParams(window.location.search);
  const library = params.get("library") || null;
  const entry = library ? params.get("entry") || null : null;
  const section = params.get("view");
  const view = library && !entry && (section === "collections" || section === "groups") ? section : "entries";
  return { library, entry, candidate: entry ? params.get("candidate") || null : null, filter: params.get("filter") ?? "", view, collection: view === "collections" ? params.get("collection") || null : null, group: view === "groups" ? params.get("group") || null : null };
}

export type LibraryNavigate = (url: string, mode: "push" | "replace") => void;

/**
 * Records a Libraries selection in browser history. App.tsx passes its own
 * history writers through `onNavigate`; the fallback keeps the existing
 * history state, including the app's history index.
 */
export function writeLibraryLocation(location: LibraryLocation, mode: "push" | "replace", onNavigate?: LibraryNavigate) {
  if (window.location.pathname !== "/libraries") return;
  const url = librariesUrl(location);
  if (url === `${window.location.pathname}${window.location.search}`) return;
  if (onNavigate) onNavigate(url, mode);
  else if (mode === "push") window.history.pushState(window.history.state, "", url);
  else window.history.replaceState(window.history.state, "", url);
}

/** Pages a library's authorised entries until a skill entry with this slug is found. */
export async function findSkillEntry(api: LibraryClient, libraryId: string, slug: string): Promise<string | null> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await api.entries(libraryId, cursor);
      const match = result.entries.find((entry) => entry.kind === "skill" && entry.skill?.slug === slug);
      if (match) return match.id;
      if (!result.nextCursor || seen.has(result.nextCursor)) return null;
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
  } catch {
    return null;
  }
  return null;
}
