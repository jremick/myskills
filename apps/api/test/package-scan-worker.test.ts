import assert from "node:assert/strict";
import test from "node:test";
import type { PackageScanService } from "../src/package-quality/scan-service.js";
import { PackageScanWorker } from "../src/package-quality/scan-worker.js";

test("scan worker deduplicates a local batch and waits for it before shutdown", async () => {
  let finish!: (count: number) => void;
  let calls = 0;
  const service = { runOnce: () => { calls++; return new Promise<number>(resolve => { finish = resolve; }); } } as PackageScanService;
  const worker = new PackageScanWorker(service);
  const first = worker.runOnce();
  assert.equal(worker.runOnce(), first);
  assert.equal(calls, 1);
  let stopped = false;
  const shutdown = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, "pool shutdown must wait for the held batch");
  finish(1);
  assert.equal(await first, 1);
  await shutdown;
  worker.start();
  assert.equal(calls, 1, "a stopped poller cannot schedule another batch");
});

test("scan poller reports a fixed failure signal and drains before stopping", { timeout: 2000 }, async () => {
  let started!: () => void, reject!: (error: Error) => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const service = { runOnce: () => { started(); return new Promise<number>((_resolve, fail) => { reject = fail; }); } } as PackageScanService;
  let errors = 0;
  const worker = new PackageScanWorker(service, { onError: () => { errors++; } });
  worker.start(); worker.start();
  await entered;
  const stopped = worker.stop();
  reject(new Error("PRIVATE-RAW-STORAGE-ERROR"));
  await stopped;
  assert.equal(errors, 1);
});
