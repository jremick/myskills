import { once } from "node:events";
import { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import pg, { type PoolClient } from "pg";

// Only this test's observer/migration connections use these bounds. The actual
// production child keeps its normal pool and worker configuration.
export async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Process fixture operation timed out")), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let onAbort: () => void = () => undefined;
  try {
    combined.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(combined.reason);
      combined.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([operation(combined), aborted]);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", onAbort);
    deadline.abort(); // Dispose event waits even when the operation rejects.
  }
}

export async function until(signal: AbortSignal, check: () => Promise<boolean>, fail: () => Promise<never>, timeoutMs = 30_000) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const combined = AbortSignal.any([signal, deadline.signal]);
  try {
    await bounded(async active => {
      while (!await check()) await delay(40, undefined, { signal: active });
    }, timeoutMs, combined);
  } catch (error) {
    signal.throwIfAborted();
    if (!deadline.signal.aborted) throw error;
    await bounded(fail, 5_000, signal);
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}

export async function childExit(child: ChildProcess, signal?: AbortSignal, timeoutMs = 30_000): Promise<[number | null, NodeJS.Signals | null]> {
  return bounded(async active => {
    if (child.exitCode !== null || child.signalCode !== null) return [child.exitCode, child.signalCode];
    return await once(child, "exit", { signal: active }) as [number | null, NodeJS.Signals | null];
  }, timeoutMs, signal);
}

export function processFixture(databaseUrl: string, signal: AbortSignal, operationMs = 5_000, cleanupMs = 2_000) {
  const controller = new AbortController();
  const active = AbortSignal.any([signal, controller.signal]);
  const sockets = new Set<Socket>();
  const clients = new Set<PoolClient>();
  const children: ChildProcess[] = [];
  let closing = false;
  let gate: PoolClient | undefined;
  let teardown: Promise<void> | undefined;
  const pool = new pg.Pool({
    connectionString: databaseUrl, connectionTimeoutMillis: operationMs,
    query_timeout: operationMs, statement_timeout: operationMs,
    stream: () => {
      active.throwIfAborted();
      const socket = new Socket();
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      return socket;
    },
  });
  // Socket disposal can report errors to idle or checked-out clients.
  pool.on("error", () => undefined);
  pool.on("connect", client => client.on("error", () => undefined));
  pool.on("acquire", client => clients.add(client));
  pool.on("release", (_error, client) => clients.delete(client));
  const run = <T>(operation: () => Promise<T>, timeoutMs = operationMs) => bounded(operation, timeoutMs, active);
  const close = () => teardown ??= dispose();
  const onAbort = () => { void close().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });

  async function dispose() {
    closing = true;
    controller.abort(new Error("Process fixture closed"));
    const failures: Error[] = [];
    // Reap owned processes regardless of an unlock failure. Never signal a PG backend.
    const exits = children.map(async child => {
      if (!child.pid) return;
      try {
        const exit = childExit(child, undefined, cleanupMs);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exit;
      } catch { failures.push(new Error("Owned child cleanup failed")); }
      finally { child.stdout?.destroy(); child.stderr?.destroy(); }
    });
    try {
      if (gate) await bounded(() => gate!.query("SELECT pg_advisory_unlock_all()"), cleanupMs);
    } catch { failures.push(new Error("Test gate unlock failed")); }
    finally {
      // Destroy all owned transports, including a connect still in progress or a
      // query whose read timeout did not cancel its server-side statement.
      const closed = [...sockets].map(async socket => {
        const ended = once(socket, "close"); socket.destroy(); await ended;
      });
      try { await bounded(() => Promise.all(closed), cleanupMs); }
      catch { failures.push(new Error("Observer transport shutdown failed")); }
      // Let pg's pool.query callbacks release their own failed acquisitions
      // before disposing the still checked-out migration/gate clients.
      for (const client of [...clients]) {
        try { client.release(true); }
        catch { failures.push(new Error("Owned client release failed")); }
      }
      try { await bounded(() => pool.end(), cleanupMs); }
      catch { failures.push(new Error("Observer pool shutdown failed")); }
      await Promise.all(exits);
      signal.removeEventListener("abort", onAbort);
    }
    if (failures.length) throw new AggregateError(failures, "Process fixture cleanup failed");
  }

  return { pool, signal: active, run, close,
    setGate: (client: PoolClient) => { gate = client; },
    own: (child: ChildProcess) => {
      if (closing) { child.kill("SIGKILL"); throw new Error("Process fixture closed"); }
      children.push(child);
      return child;
    },
  };
}
