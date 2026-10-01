// One internal observer command, bounded output and forced owned-group cleanup.
import { spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export async function observerCommand(command, args, { input = "", maximumMs = 8000, maximumBytes = 2048 } = {}) {
  const until = Date.now() + Math.min(8000, maximumMs); const chunks = []; let size = 0; let category = "completed";
  const child = spawn(command, args, { detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* probe below */ } } };
  let finish;
  const ended = new Promise(resolve => { finish = resolve; });
  child.once("error", () => { category = "command-failed"; finish(); });
  child.once("exit", code => { if (code !== 0 && category === "completed") category = "command-failed"; kill(); });
  child.once("close", () => finish());
  child.stdout.on("data", bytes => { size += bytes.length; if (size > maximumBytes) { category = "output-invalid"; kill(); finish(); } else chunks.push(bytes); });
  child.stdin.on("error", () => {}); child.stdin.end(input);
  const timer = setTimeout(() => { category = "deadline"; kill(); finish(); }, Math.max(1, until - Date.now() - 250));
  try { await ended; } finally { clearTimeout(timer); kill(); }
  // A leader exiting is insufficient. Kill and probe its group even on success.
  let absent = !child.pid;
  while (!absent && Date.now() < until) {
    try { process.kill(-child.pid, 0); } catch (error) { absent = error.code === "ESRCH"; }
    if (!absent) await pause(10);
  }
  if (!absent) category = "termination-unconfirmed";
  child.stdout.destroy(); child.stdin.destroy();
  return { category, groupTerminationConfirmed: absent, ...(category === "completed" ? { stdout: Buffer.concat(chunks).toString() } : {}) };
}

// Native HTTPS ignores proxy environment variables. Only the fixture public CA
// is used. No redirects/retries/response body, and this result never accepts HOST.
export function observerTls({ gateway, port, publicCertificate, maximumMs = 2000 }) {
  if (isIP(gateway) !== 4 || !/^[1-9][0-9]{0,4}$/.test(port ?? "") || Number(port) > 65535
    || typeof publicCertificate !== "string" || Buffer.byteLength(publicCertificate) > 8192
    || !/^-----BEGIN CERTIFICATE-----\r?\n[\s\S]+\r?\n-----END CERTIFICATE-----\r?\n?$/.test(publicCertificate)) return Promise.resolve("unavailable");
  return new Promise(resolve => {
    let settled = false; let client;
    const done = category => { if (settled) return; settled = true; clearTimeout(timer); client?.destroy(); resolve(category); };
    const timer = setTimeout(() => done("deadline"), Math.max(1, Math.min(2000, maximumMs)));
    try {
      client = request({ hostname: gateway, port: Number(port), path: "/minio/health/ready", method: "GET", ca: publicCertificate,
        rejectUnauthorized: true, agent: false }, response => { const category = response.statusCode === 200 ? "ready" : "not-ready"; response.destroy(); done(category); });
      client.once("error", error => done(["ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED"].includes(error.code) ? "tls-rejected" : "unreachable"));
      client.end();
    } catch { done("unreachable"); }
  });
}
