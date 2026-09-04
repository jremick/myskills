import type { ReviewAction, SubmissionFeedback } from "./types.js";

export const reviewHistoryActions: Record<string, ReviewAction> = {
  "review.approve": "approve",
  "review.request_changes": "request-changes",
  "review.reject": "reject",
  "release.publish": "publish",
};

export function submissionReviewHistory(events: Array<{
  action: string;
  details: unknown;
  createdAt: string;
}>): SubmissionFeedback["reviewHistory"] {
  return events.flatMap((event) => {
    const action = reviewHistoryActions[event.action];
    const details = event.details && typeof event.details === "object" ? event.details as Record<string, unknown> : {};
    return action ? [{
      action,
      reason: typeof details.reason === "string" && details.reason ? details.reason : null,
      createdAt: event.createdAt,
    }] : [];
  });
}
