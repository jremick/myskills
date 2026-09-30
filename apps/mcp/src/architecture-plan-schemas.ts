import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Plan review is an API journal write; none of these inputs requests apply. */
export const architecturePlanBodies = {
  "architecture_artifacts.prepare": z.object({reviewRunId:id,baselineRunId:id.nullable(),idempotencyKey:id}).strict(),
  "architecture_plans.create": z.object({
    revisionId: id,
    expectedTargetGeneration: z.number().int().min(1).max(1_000_000_000),
    expectedObservationId: id,
    expectedObservationDigest: digest,
    idempotencyKey: id,
  }).strict(),
  "architecture_plans.approve": z.object({ expectedReviewDigest: digest }).strict(),
};

export const architecturePlanQueries = {
  "architecture_plans.list": z.object({ limit: z.number().int().min(1).max(500).optional() }).strict(),
};
