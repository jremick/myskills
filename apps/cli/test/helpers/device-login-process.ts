import { runCli } from "../../src/cli.js";
import { createDeviceLoginStore } from "../../src/device-login-store.js";
let sequence = 0;
const pending = new Map<number, (value: string | null) => void>();
process.on("message", (message: { id: number; value: string | null }) => { pending.get(message.id)?.(message.value); pending.delete(message.id); });
const rpc = (operation: string, key: string, raw?: string): Promise<string | null> => new Promise(resolve => {
  const id = ++sequence; pending.set(id, resolve); process.send!({ type: "keyring", id, operation, key, raw });
});
const apiUrl = process.argv[2];
const code = await runCli(["login", "--method", "browser", "--api-url", apiUrl, "--scopes", "profile:read,skills:read"], {
  env: {}, fetch,
  deviceLoginStore: createDeviceLoginStore(undefined, {
    get: key => rpc("get", key), set: async (key, raw) => { await rpc("set", key, raw); }, delete: async key => { await rpc("delete", key); },
  }, process.argv[3]),
  tokenStore: { get: async () => null, set: async (_api, token) => { process.send!({ type: "saved", token }); }, delete: async () => {} },
  io: { stdout: line => process.send!({ type: "stdout", line }), stderr: line => process.send!({ type: "stderr", line }) },
});
process.send!({ type: "done", code });
process.disconnect();
