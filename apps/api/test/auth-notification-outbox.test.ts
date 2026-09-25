import test from "node:test";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { authNotificationOutboxCases, type OutboxFixture } from "./auth-notification-outbox-cases.js";

test("memory auth notification outbox", { timeout: 60_000 }, async (t) => {
  await authNotificationOutboxCases(t, async () => {
    const store = new MemoryAuthStore();
    // Inspect persisted fixture fields, without exposing production inspection methods.
    const state = store as unknown as { authNotifications: Map<string, { payloadCiphertext: string | null; status: string; attempts: number }>; authActionTokens: Map<string, { expiresAt: Date }> };
    return {
      store,
      expireToken: async (tokenHash) => {
        const token = state.authActionTokens.get(tokenHash);
        if (!token) throw new Error("Missing fixture token");
        token.expiresAt = new Date(Date.now() - 1000);
      },
      // This exercises normalization of a mixed-case lookup projection. Only the
      // Postgres fixture represents a historical mixed-case persisted email row.
      setDisplayEmail: async (userId, email) => {
        const find = store.findUserByEmailWithPassword.bind(store);
        store.findUserByEmailWithPassword = async (value) => {
          const user = await find(value);
          return user?.id === userId ? { ...user, email } : user;
        };
      },
      rows: async () => [...state.authNotifications.values()].map((row) => ({ ...row })),
      counts: async () => ({ tokens: state.authActionTokens.size, intents: state.authNotifications.size }),
    } satisfies OutboxFixture;
  });
});
