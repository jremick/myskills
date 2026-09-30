import { AppError, type ArchitectureSyncRun } from "@myskills-app/core";
export function assertExecutableSyncRun(run: ArchitectureSyncRun): void {
  if (run.metadata?.reviewOnly === true || run.metadata?.source === "architecture-plan") {
    throw new AppError("A review-only architecture plan cannot execute.", "ARCHITECTURE_PLAN_REVIEW_ONLY", 409);
  }
}
