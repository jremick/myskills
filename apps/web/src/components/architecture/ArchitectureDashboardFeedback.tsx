import {
  AlertTriangle,
  CircleAlert,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ArchitectureLoadState } from "./architecture-dashboard-types.js";

export function ArchitectureDetailLoading() {
  return <div className="architecture-detail-loading" role="status" aria-live="polite"><span className="sr-only">Loading architecture preview…</span><div /><div /><div /></div>;
}

export function ArchitectureState({ state, message, onRetry, compact = false }: { state: ArchitectureLoadState; message: string; onRetry: () => void; compact?: boolean }) {
  const unsupported = state === "unsupported";
  return (
    <div className={compact ? "architecture-state compact" : "architecture-state"} role={unsupported ? "status" : "alert"}>
      {unsupported ? <CircleAlert size={24} aria-hidden="true" /> : <AlertTriangle size={24} aria-hidden="true" />}
      <strong>{message}</strong>
      <span>{unsupported ? "This workspace can still use the existing registry while architecture support is enabled." : "Retry the API request or review the workspace access and revision state."}</span>
      {!unsupported && <Button size="sm" type="button" variant="outline" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" /> Retry</Button>}
    </div>
  );
}
