import test from "node:test";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { authActionLifecycleCases, authActionRollbackCases } from "./auth-action-lifecycle-cases.js";

test("memory auth action lifecycle", { timeout: 60_000 }, async (t) => {
  await authActionLifecycleCases(t, new MemoryAuthStore());
});

test("memory auth action rollback", async (t) => {
  const store = new FailingRevocationStore();
  await authActionRollbackCases(t, store, () => { store.fail = true; }, () => { store.fail = false; });
});

class FailingRevocationStore extends MemoryAuthStore {
  fail = false;

  override async revokeUserCredentials(userId: string): Promise<void> {
    await super.revokeUserCredentials(userId);
    if (this.fail) throw new Error("Injected credential revocation failure");
  }
}
