import type { ArchitectureSyncRun } from "@myskills-app/core";

export interface ArchitecturePlanCreateInput {
  revisionId: string;
  expectedTargetGeneration: number;
  expectedObservationId: string;
  expectedObservationDigest: string;
  idempotencyKey: string;
}

export interface ArchitecturePlanClient {
  createArchitecturePlan(targetId: string, input: ArchitecturePlanCreateInput, token?: string): Promise<{ run: ArchitectureSyncRun; replayed?: boolean }>;
  listArchitecturePlans(targetId: string, limit?: number, token?: string): Promise<ArchitectureSyncRun[]>;
  getArchitecturePlan(runId: string, token?: string): Promise<ArchitectureSyncRun>;
  approveArchitecturePlan(runId: string, expectedReviewDigest: string, token?: string): Promise<{ run: ArchitectureSyncRun; replayed?: boolean }>;
}

/** Uses the registry client's established credential and request boundary. */
export function createArchitecturePlanClient(request: (method: "GET" | "POST", path: string, body?: unknown, token?: string) => Promise<unknown>): ArchitecturePlanClient {
  return {
    async createArchitecturePlan(targetId, input, token) {
      return await request("POST", `/v1/architecture-targets/${encodeURIComponent(targetId)}/plans`, input, token) as { run: ArchitectureSyncRun; replayed?: boolean };
    },
    async listArchitecturePlans(targetId, limit = 50, token) {
      const result = await request("GET", `/v1/architecture-targets/${encodeURIComponent(targetId)}/plans?limit=${limit}`, undefined, token) as { runs: ArchitectureSyncRun[] };
      return result.runs;
    },
    async getArchitecturePlan(runId, token) {
      const result = await request("GET", `/v1/architecture-plans/${encodeURIComponent(runId)}`, undefined, token) as { run: ArchitectureSyncRun };
      return result.run;
    },
    async approveArchitecturePlan(runId, expectedReviewDigest, token) {
      return await request("POST", `/v1/architecture-plans/${encodeURIComponent(runId)}/approve`, { expectedReviewDigest }, token) as { run: ArchitectureSyncRun; replayed?: boolean };
    },
  };
}
