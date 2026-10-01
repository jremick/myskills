#!/usr/bin/env node
// Supervisor-prepared, one-shot Ubuntu observer. No provider/auth setup.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { observerCommand, observerTls } from "./lib/host-observer-process.mjs";
import { hostPublicationDirectory as directory, privateHostObservation } from "./lib/host-backup-service.mjs";

const [adapterFile, digest, candidate, runId] = process.argv.slice(2);
let token; let ready = false; let adapterTermination = "not-started";
let cancelled = false;
const cancel = () => { cancelled = true; };
// Cooperative shutdown leaves the active detached command's kill/reap timer alive.
process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
try {
  // Adapter is supervisor-owned public routing code, not credentials. Read once,
  // pin the bytes, execute those bytes: no executable replacement race.
  const adapter = privateHostObservation(adapterFile, 8192);
  if (adapter.backendStopProtocol !== "timeout7-kill025-process-group" || !/^[a-f0-9]{64}$/.test(adapter.terminationProbeSha256 ?? "") || !/^[a-f0-9]{40}$/.test(candidate ?? "") || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId ?? "") || typeof adapter.script !== "string" || createHash("sha256").update(adapter.script).digest("hex") !== digest) throw new Error("adapter");
  const backend = readFileSync(new URL("./host-publication-backend.sh", import.meta.url), "utf8");
  mkdirSync(directory, { mode: 0o700 });
  const nonce = randomBytes(16).toString("hex"); const expiresAtMs = Date.now() + 7200000;
  writeFileSync(join(directory, "ready.json"), JSON.stringify({ schemaVersion: 1, candidate, runId, nonce, expiresAtMs }), { flag: "wx", mode: 0o600 }); ready = true;
  console.log(JSON.stringify({ ready: true, windowMs: 15000, requests: 1, backendTimeoutMs: 8000 }));
  let request;
  while (!cancelled && Date.now() < expiresAtMs) {
    try { request = privateHostObservation(join(directory, "request.json"), 16384); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(done => setTimeout(done, 25));
  }
  if (cancelled) throw new Error("cancelled");
  if (!request || request.candidate !== candidate || request.runId !== runId || request.nonce !== nonce || !/^[a-f0-9]{32}$/.test(request.token) || !/^hc-[a-f0-9]{16}$/.test(request.owner)
    || ![request.containerId, request.networkId, request.endpointId].every(value => /^[a-f0-9]{64}$/.test(value))
    || ![request.gateway, request.address].every(value => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value))
    || !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs <= Date.now()) throw new Error("request");
  token = request.token;
  adapterTermination = "unconfirmed";
  const result = await observerCommand("/bin/sh", ["-c", adapter.script, "host-publication-backend", request.gateway, request.address],
    { input: backend, maximumMs: Math.min(8000, request.deadlineMs - Date.now() - 2000), maximumBytes: 2048 });
  adapterTermination = result.groupTerminationConfirmed ? "confirmed" : "unconfirmed";
  if (cancelled) throw new Error("cancelled");
  let observation = { category: "command-failed", bridgeAddress: "unavailable", forwarding: "unavailable", listener: "unavailable",
    ubuntuTls: "unavailable", backendTls: "unavailable", observedPort: null, adapterTermination: result.groupTerminationConfirmed ? "confirmed" : "unconfirmed" };
  if (result.category === "completed") {
    try {
      const value = JSON.parse(result.stdout);
      if (["observed", "unavailable", "namespace-changed", "output-invalid", "command-failed"].includes(value.category)
        && ["bridgeAddress", "forwarding", "listener"].every(key => ["present", "absent", "unavailable"].includes(value[key]))) {
        Object.assign(observation, Object.fromEntries(["category", "bridgeAddress", "forwarding", "listener"].map(key => [key, value[key]])));
        if (value.category === "observed" && value.forwarding === "present" && /^[1-9][0-9]{0,4}$/.test(value.observedPort ?? "") && Number(value.observedPort) <= 65535) {
          observation.observedPort = value.observedPort;
          observation.ubuntuTls = await observerTls({ gateway: request.gateway, port: value.observedPort, publicCertificate: request.publicCertificate,
            maximumMs: Math.min(2000, request.deadlineMs - Date.now()) });
        }
      }
    } catch { observation.category = "output-invalid"; }
  } else observation.category = result.category === "output-invalid" ? "output-invalid" : "command-failed";
  if (cancelled) throw new Error("cancelled");
  const temporary = join(directory, `${token}.tmp`);
  writeFileSync(temporary, JSON.stringify({ ...observation, candidate, runId, token, nonce, containerId: request.containerId, networkId: request.networkId,
    endpointId: request.endpointId }), { flag: "wx", mode: 0o600 }); renameSync(temporary, join(directory, `${token}.json`));
  const safe = Object.fromEntries(Object.entries(observation).filter(([key]) => key !== "observedPort"));
  console.log(JSON.stringify({ completed: true, ...safe, acceptanceRecovered: false }));
} catch { console.error(JSON.stringify({ ready: false, category: cancelled ? "observer-cancelled" : "observer-failed", ...(cancelled ? { adapterTermination } : {}) })); process.exitCode = cancelled && adapterTermination !== "unconfirmed" ? 0 : 1; }
finally {
  process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel);
  if (ready) { try { unlinkSync(join(directory, "ready.json")); } catch { /* no arbitrary cleanup */ } }
}
