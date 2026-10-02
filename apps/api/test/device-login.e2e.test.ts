import test from "node:test";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemoryDeviceLoginStore } from "../src/auth/device-login/memory-store.js";
import { deviceLoginJourney } from "./device-login-cases.js";

test("device browser consent survives service recreation and enforces the full API lifecycle", async (t) => {
  const auth = new MemoryAuthStore();
  t.diagnostic(JSON.stringify(await deviceLoginJourney(auth, new MemoryDeviceLoginStore(auth))));
});
