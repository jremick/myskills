import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface ArchitectureTab<T extends string> {
  id: T;
  label: ReactNode;
}

/**
 * WAI-ARIA tabs with automatic activation. Panels are rendered by
 * ArchitectureTabPanel and stay mounted while hidden, so drafts, disclosure
 * state and in-flight request keys inside a panel survive tab changes.
 */
export function ArchitectureTabList<T extends string>({ label, idPrefix, tabs, selected, onSelect, className }: {
  label: string;
  idPrefix: string;
  tabs: ReadonlyArray<ArchitectureTab<T>>;
  selected: T;
  onSelect: (id: T) => void;
  className?: string;
}) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = tabs.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : null;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    onSelect(tab.id);
    buttons.current.get(tab.id)?.focus();
  }
  return (
    <div className={className ? `architecture-tabs ${className}` : "architecture-tabs"} role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          aria-selected={tab.id === selected}
          className="architecture-tab"
          id={`${idPrefix}-tab-${tab.id}`}
          key={tab.id}
          ref={(element) => {
            if (element) buttons.current.set(tab.id, element); else buttons.current.delete(tab.id);
          }}
          role="tab"
          tabIndex={tab.id === selected ? 0 : -1}
          type="button"
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function ArchitectureTabPanel({ idPrefix, id, selected, className, children }: {
  idPrefix: string;
  id: string;
  selected: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div aria-labelledby={`${idPrefix}-tab-${id}`} className={className} hidden={id !== selected} id={`${idPrefix}-panel-${id}`} role="tabpanel" tabIndex={0}>
      {children}
    </div>
  );
}
