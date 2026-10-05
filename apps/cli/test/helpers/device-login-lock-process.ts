import { createDeviceLoginStore, deviceLoginLockDirectory } from "../../src/device-login-store.js";
if (process.argv[2] === "--directory") {
  process.send!({ directory: deviceLoginLockDirectory() });
  process.disconnect();
  process.exit(0);
}
const store = createDeviceLoginStore(undefined, { get: async () => null, set: async () => {}, delete: async () => {} }, process.argv[2]);
await store.withLock("https://registry.example.test", async () => {
  process.send!("acquired");
  await new Promise<void>(resolve => process.once("message", () => resolve()));
});
process.disconnect();
