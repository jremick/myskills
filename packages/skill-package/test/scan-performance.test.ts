import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const name of [
  "benign",
  "curl-space",
  "wget-space",
  "decode-options",
  "decoder-repeat",
  "curl-url",
  "url-without-command",
  "download-positive",
  "decode-positive",
  "url-positive",
]) {
  test(`bounds scanner work for ${name} through the package text limit`, (t) => {
    // A test-runner timeout cannot interrupt a synchronous regex. Kill a child
    // process so a regression cannot stall this suite indefinitely.
    const result = spawnSync(process.execPath, [
      "--import", "tsx",
      fileURLToPath(new URL("./fixtures/scan-performance.ts", import.meta.url)),
      name,
    ], {
      encoding: "utf8",
      timeout: 3_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });

    assert.ifError(result.error);
    assert.equal(result.signal, null, `${name}: ${result.signal}`);
    assert.equal(result.status, 0, result.stderr);
    const timings = JSON.parse(result.stdout) as Array<{ length: number; elapsedMs: number }>;
    assert.deepEqual(timings.map((timing) => timing.length), [8_192, 131_072, 1_048_576]);
    t.diagnostic(`${name}: ${JSON.stringify(timings)}`);
  });
}
