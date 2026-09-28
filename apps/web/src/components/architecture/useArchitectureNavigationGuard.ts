import { useCallback, useEffect, useRef } from "react";

/**
 * Returns true when navigation may continue. A destination URL lets the guard
 * skip the prompt when the move keeps the current draft (for example, the same
 * architecture's overview), so only destructive transitions ask once.
 */
export type ArchitectureNavigationGuard = (action: string, destination?: string) => boolean;

export function useArchitectureNavigationGuard(
  hasUnsavedDraft: boolean,
  keepsDraft: (destination: URL) => boolean,
): { confirmDiscardDraft: (action: string) => boolean; guardNavigation: ArchitectureNavigationGuard } {
  const keepsDraftRef = useRef(keepsDraft);
  keepsDraftRef.current = keepsDraft;

  const confirmDiscardDraft = useCallback((action: string): boolean => {
    if (!hasUnsavedDraft) return true;
    try {
      return window.confirm(`You have unsaved architecture changes. Discard them and ${action}?`);
    } catch {
      return true;
    }
  }, [hasUnsavedDraft]);

  const guardNavigation = useCallback<ArchitectureNavigationGuard>((action, destination) => {
    if (!hasUnsavedDraft) return true;
    if (destination !== undefined) {
      const url = new URL(destination, window.location.href);
      if (url.origin === window.location.origin && keepsDraftRef.current(url)) return true;
    }
    return confirmDiscardDraft(action);
  }, [confirmDiscardDraft, hasUnsavedDraft]);

  useEffect(() => {
    if (!hasUnsavedDraft) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedDraft]);

  useEffect(() => {
    if (!hasUnsavedDraft) return;
    const handleNavigationClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof window.Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (keepsDraftRef.current(destination)) return;
      if (!confirmDiscardDraft("navigate away")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("click", handleNavigationClick, true);
    return () => document.removeEventListener("click", handleNavigationClick, true);
  }, [confirmDiscardDraft, hasUnsavedDraft]);

  return { confirmDiscardDraft, guardNavigation };
}
