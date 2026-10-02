import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import test, { type TestContext } from "node:test";
import { bounded, childExit, processFixture, until } from "./fixtures/package-worker-process.js";

// A local wire peer deliberately withholds startup/query replies. This is not
// PostgreSQL recovery proof: it tests terminal disposal against real sockets,
// the installed pg driver and real children without needing a database.
async function peer(t: TestContext, mode: "startup" | "hang" | "reject") {
  const sockets = new Set<Socket>();
  const querySeen = new Set<string>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    let startup = true; let bytes = Buffer.alloc(0);
    socket.on("data", data => {
      bytes = Buffer.concat([bytes, data]);
      while (bytes.length >= (startup ? 4 : 5)) {
        const length = bytes.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (bytes.length < length) return;
        const frame = bytes.subarray(0, length); bytes = bytes.subarray(length);
        if (startup) {
          startup = false;
          if (mode !== "startup") socket.write(Buffer.concat([message("R", Buffer.alloc(4)), message("Z", Buffer.from("I"))]));
        } else if (frame[0] === 81) {
          const sql = frame.subarray(5, -1).toString(); querySeen.add(sql);
          if (mode === "reject" && sql.includes("pg_advisory_unlock_all")) {
            socket.write(Buffer.concat([message("E", Buffer.from("SERROR\0CXX000\0Msynthetic gate rejection\0\0")), message("Z", Buffer.from("I"))]));
          }
        }
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(done => server.close(() => done()));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { sockets, querySeen, url: `postgres://fixture:fixture@127.0.0.1:${port}/process_test` };
}
function message(type: string, body: Buffer) {
  const header = Buffer.alloc(5); header.write(type); header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}
async function ownedChild(t: TestContext) {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready')"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await bounded(active => once(child.stdout!, "data", { signal: active }), 2_000);
  return child;
}
async function terminal(fixture: ReturnType<typeof processFixture>, sockets: Set<Socket>) {
  await until(new AbortController().signal, async () => sockets.size === 0, async () => assert.fail("Observer transport remains open"), 1_000);
  assert.equal(fixture.pool.totalCount, 0);
  assert.equal(fixture.pool.waitingCount, 0);
  await assert.rejects(fixture.pool.connect(), /end/);
}

test("stalled connection is bounded and disposes its transport without acquiring a client", { timeout: 4_000 }, async t => {
  const wire = await peer(t, "startup");
  const fixture = processFixture(wire.url, t.signal, 100, 150);
  t.after(() => fixture.close());
  await assert.rejects(fixture.pool.connect(), /timeout/);
  await fixture.close();
  await terminal(fixture, wire.sockets);
});

test("stalled query reaches its native read bound and leaves no owned transport", { timeout: 4_000 }, async t => {
  const wire = await peer(t, "hang");
  const fixture = processFixture(wire.url, t.signal, 100, 150);
  t.after(() => fixture.close());
  await assert.rejects(fixture.pool.query("SELECT stalled_query"), /Query read timeout/);
  assert.ok(wire.querySeen.has("SELECT stalled_query"));
  await fixture.close();
  await terminal(fixture, wire.sockets);
});

for (const mode of ["hang", "reject"] as const) test(`gate unlock ${mode} cannot strand an active query, client or child`, { timeout: 4_000 }, async t => {
  const wire = await peer(t, mode);
  const fixture = processFixture(wire.url, t.signal, 1_000, 100);
  t.after(() => fixture.close().catch(() => undefined));
  const gate = await fixture.pool.connect(); fixture.setGate(gate);
  const observer = await fixture.pool.connect();
  const query = observer.query("SELECT stalled_observation");
  const rejected = assert.rejects(query, /terminated|closed/);
  const child = fixture.own(await ownedChild(t));
  await assert.rejects(fixture.close(), /cleanup failed/);
  await rejected;
  assert.ok(wire.querySeen.has("SELECT pg_advisory_unlock_all()"));
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(child.listenerCount("exit"), 0);
  await terminal(fixture, wire.sockets);
});

test("cancellation interrupts stalled polling and child waits and completes teardown", { timeout: 4_000 }, async t => {
  const wire = await peer(t, "hang");
  const controller = new AbortController();
  const fixture = processFixture(wire.url, controller.signal, 1_000, 100);
  t.after(() => fixture.close().catch(() => undefined));
  const gate = await fixture.pool.connect(); fixture.setGate(gate);
  const child = fixture.own(await ownedChild(t));
  const reason = new Error("synthetic test cancellation");
  let checks = 0; let diagnostics = 0;
  const polling = until(fixture.signal, async () => { checks++; await fixture.pool.query("SELECT stalled_poll"); return false; }, async () => { diagnostics++; assert.fail("Cancelled poll reached diagnostics"); });
  const waiting = childExit(child, fixture.signal);
  const outcomes = Promise.all([assert.rejects(polling, reason), assert.rejects(waiting, reason)]);
  controller.abort(reason);
  await outcomes;
  await assert.rejects(fixture.close(), /cleanup failed/);
  assert.equal(checks, 1); assert.equal(diagnostics, 0);
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(child.listenerCount("exit"), 0);
  await terminal(fixture, wire.sockets);
});

test("poll deadline covers a stalled operation and child deadline removes its listener", { timeout: 4_000 }, async t => {
  let diagnostics = 0;
  await assert.rejects(until(t.signal, () => new Promise(() => undefined), async () => { diagnostics++; assert.fail("bounded poll failure"); }, 40), /bounded poll failure/);
  assert.equal(diagnostics, 1);
  const child = await ownedChild(t);
  await assert.rejects(childExit(child, t.signal, 40), /timed out/);
  assert.equal(child.listenerCount("exit"), 0);
  const exit = childExit(child); child.kill("SIGKILL"); await exit;
});
