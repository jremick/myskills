import { useCallback, useRef, useState } from "react";

export type SplitLayout = "split" | "stack";

// Same threshold as Skills: split when the surface itself is this wide.
const SPLIT_WIDTH = 880;

/**
 * Measures a workspace surface through a callback ref. A surface without
 * layout (width 0, as in DOM tests) keeps the split default.
 */
export function useSplitLayout() {
  const [layout, setLayout] = useState<SplitLayout>("split");
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    const apply = (width: number) => setLayout(width === 0 || width >= SPLIT_WIDTH ? "split" : "stack");
    apply(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(([entry]) => { if (entry) apply(entry.contentRect.width); });
    observer.current.observe(node);
  }, []);
  return { layout, ref };
}
