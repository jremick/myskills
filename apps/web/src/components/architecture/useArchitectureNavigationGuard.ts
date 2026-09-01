import { useCallback, useEffect } from "react";

export type ArchitectureNavigationGuard = (action: string) => boolean;

export function useArchitectureNavigationGuard(hasUnsavedDraft: boolean): ArchitectureNavigationGuard {
  const confirmDiscardDraft = useCallback((action: string): boolean => {
    if (!hasUnsavedDraft) return true;
    try {
      return window.confirm(`You have unsaved architecture changes. Discard them and ${action}?`);
    } catch {
      return true;
    }
  }, [hasUnsavedDraft]);

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
      if (!confirmDiscardDraft("navigate away")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("click", handleNavigationClick, true);
    return () => document.removeEventListener("click", handleNavigationClick, true);
  }, [confirmDiscardDraft, hasUnsavedDraft]);

  return confirmDiscardDraft;
}
