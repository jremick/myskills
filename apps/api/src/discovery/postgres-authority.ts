import type { Database } from "../db/client.js";
import { assertRegistryReadCredential } from "../artifacts/postgres-read-authority.js";
import { PostgresSkillRepository } from "../repositories/postgres-skill-repository.js";
import { PostgresSubmissionStore } from "../submissions/postgres-submission-store.js";
import type { DiscoveryFinalAuthority } from "./service.js";

/** First credential SELECT is the final decision's serialization point. */
export function createPostgresDiscoveryFinalAuthority(db: Database): DiscoveryFinalAuthority {
  return (input, read) => db.transaction(async tx => {
    await assertRegistryReadCredential(tx, input);
    const scoped = tx as unknown as Database;
    const releases = new PostgresSubmissionStore(scoped);
    return read({ repository: new PostgresSkillRepository(scoped), readRelease: value => releases.getPublicRelease(value), readActor: async () => input.actorId });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
