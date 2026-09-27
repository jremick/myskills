import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// A button that shows an anchored panel. The panel mounts on first open and is
// then only hidden, so drafts, errors and in-flight saves survive a close.
export function LibraryDisclosure({ label, ariaLabel, icon, badge, variant = "outline", iconOnly = false, focusPanel = false, className, children }: {
  label: string;
  ariaLabel?: string;
  icon?: ReactNode;
  badge?: ReactNode;
  variant?: "default" | "outline" | "ghost";
  iconOnly?: boolean;
  focusPanel?: boolean;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = useCallback(() => { setOpen(false); triggerRef.current?.focus(); }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    // Keep the panel inside the viewport when its trigger sits near an edge.
    const fit = () => {
      panel.style.removeProperty("translate");
      const { left, right } = panel.getBoundingClientRect();
      const limit = document.documentElement.clientWidth - 16;
      const shift = left < 16 ? 16 - left : right > limit ? limit - right : 0;
      if (shift) panel.style.setProperty("translate", `${Math.round(shift)}px 0`);
    };
    fit();
    const first = focusPanel ? null : panel.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href]");
    (first ?? panel).focus();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open, focusPanel]);
  return <div
    ref={rootRef}
    className={cn("library-disclosure", className)}
    onKeyDown={(event) => { if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); } }}
    onBlur={(event) => { if (open && event.relatedTarget && !rootRef.current?.contains(event.relatedTarget as Node)) setOpen(false); }}
  >
    <Button ref={triggerRef} type="button" size={iconOnly ? "icon-sm" : "sm"} variant={variant} aria-label={ariaLabel} aria-expanded={open} aria-controls={mounted ? panelId : undefined} onClick={() => { if (open) setOpen(false); else { setMounted(true); setOpen(true); } }}>
      {icon}
      <span className={iconOnly ? "sr-only" : "library-action-text"}>{label}</span>
      {badge}
    </Button>
    {mounted && <div ref={panelRef} id={panelId} className="library-popover" hidden={!open} tabIndex={-1}>{children(close)}</div>}
  </div>;
}
