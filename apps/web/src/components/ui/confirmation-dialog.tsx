import { useEffect, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
import { Button } from "./button";
import { Textarea } from "./textarea";

export interface ConfirmationRequest {
  key: string;
  title: string;
  description: string;
  confirmLabel: string;
  details?: Array<{ label: string; value: string }>;
  destructive?: boolean;
  initialReason?: string;
  requireReason?: boolean;
  onConfirm: (reason: string) => Promise<void>;
}

export function ConfirmationDialog({ onClose, request }: { onClose: () => void; request: ConfirmationRequest }) {
  const [reason, setReason] = useState(request.initialReason ?? "");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const loadingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  const previouslyFocusedRef = useRef<HTMLElement | null>(
    document.activeElement instanceof window.HTMLElement ? document.activeElement : null,
  );
  const showReason = request.requireReason || request.initialReason !== undefined;
  const reasonIsValid = !request.requireReason || reason.trim().length >= 4;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    headingRef.current?.focus();
    function handleDialogKeydown(event: KeyboardEvent) {
      if (event.key === "Escape" && !loadingRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ) ?? []);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !focusable.includes(active as HTMLElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !focusable.includes(active as HTMLElement))) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleDialogKeydown);
    return () => {
      window.removeEventListener("keydown", handleDialogKeydown);
      document.body.style.overflow = previousOverflow;
      restoreInteractionFocus(previouslyFocusedRef.current);
    };
  }, []);

  async function confirm() {
    if (loadingRef.current) return;
    if (!reasonIsValid) {
      setError("Enter a specific reason of at least 4 characters.");
      return;
    }
    loadingRef.current = true;
    setStatus("loading");
    setError(null);
    try {
      await request.onConfirm(reason.trim());
      onClose();
    } catch (nextError) {
      loadingRef.current = false;
      setStatus("error");
      setError(nextError instanceof Error ? nextError.message : "The action could not be completed. Try again.");
    }
  }

  return (
    <div className="confirmation-backdrop" role="presentation">
      <section className="confirmation-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${request.key}-title`} aria-describedby={`${request.key}-description${request.details?.length ? ` ${request.key}-details` : ""}`}>
        <div className="confirmation-heading">
          <CircleAlert size={22} aria-hidden="true" />
          <div>
            <h2 id={`${request.key}-title`} ref={headingRef} tabIndex={-1}>{request.title}</h2>
            <p id={`${request.key}-description`}>{request.description}</p>
          </div>
        </div>
        {request.details?.length ? <dl className="confirmation-details" id={`${request.key}-details`}>
          {request.details.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl> : null}
        {showReason && (
          <div className="confirmation-reason">
            <label htmlFor={`${request.key}-reason`}>Reason {request.requireReason ? "(required)" : "(optional)"}</label>
            <Textarea
              aria-describedby={`${request.key}-reason-help`}
              aria-invalid={!reasonIsValid}
              disabled={status === "loading"}
              id={`${request.key}-reason`}
              name={`${request.key}-reason`}
              autoComplete="off"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Explain the decision…"
            />
            <small id={`${request.key}-reason-help`}>{request.requireReason ? "Record at least 4 characters so the decision is meaningful." : "This note is included with the decision when supported."}</small>
          </div>
        )}
        {error && <div className="safe-message compact" role="alert">{error}</div>}
        <div className="confirmation-actions">
          <Button disabled={status === "loading"} size="sm" type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={status === "loading" || !reasonIsValid} size="sm" type="button" variant={request.destructive ? "destructive" : "default"} onClick={() => void confirm()}>
            {status === "loading" ? "Working…" : request.confirmLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}

function restoreInteractionFocus(previous: HTMLElement | null): void {
  if (!previous) {
    return;
  }
  if (previous.isConnected) {
    previous.focus();
    return;
  }
  const ariaLabel = previous.getAttribute("aria-label");
  const text = previous.textContent?.trim();
  const replacement = Array.from(document.querySelectorAll<HTMLElement>(
    "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
  )).find((candidate) => (
    candidate.tagName === previous.tagName
    && (ariaLabel ? candidate.getAttribute("aria-label") === ariaLabel : candidate.textContent?.trim() === text)
  ));
  replacement?.focus();
}
