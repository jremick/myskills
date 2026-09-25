import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { MAX_SCAN_TEXT_LENGTH, hasBlockingFindings, scanTextForPackageRisks } from "../../src/scan.js";

const cases: Record<string, { prefix?: string; repeat: string; suffix?: string; category?: string }> = {
  benign: { repeat: "Summarize notes into decisions, risks, and next actions. " },
  "curl-space": { repeat: "curl " },
  "wget-space": { repeat: "wget " },
  "decode-options": { prefix: "base64 ", repeat: "-d " },
  "decoder-repeat": { repeat: "openssl enc -d " },
  "curl-url": { repeat: "curl-http://" },
  "url-without-command": { repeat: "http://" },
  "download-positive": { prefix: "curl ", repeat: "x", suffix: " |bash", category: "unsafe-command" },
  "decode-positive": { prefix: "base64 ", repeat: "-d ", suffix: " |zsh", category: "unsafe-command" },
  "url-positive": { repeat: "curl-http://", suffix: "/token", category: "exfiltration" },
};
const testCase = cases[process.argv[2]];
assert.ok(testCase, "Unknown performance case.");

const timings = [];
for (const length of [8_192, 131_072, MAX_SCAN_TEXT_LENGTH]) {
  const prefix = testCase.prefix ?? "";
  const suffix = testCase.suffix ?? "";
  const middleLength = length - prefix.length - suffix.length;
  const text = prefix + testCase.repeat.repeat(Math.ceil(middleLength / testCase.repeat.length)).slice(0, middleLength) + suffix;
  assert.equal(text.length, length);
  const started = performance.now();
  const findings = scanTextForPackageRisks(text);
  timings.push({ length, elapsedMs: performance.now() - started });
  if (testCase.category) {
    assert.equal(hasBlockingFindings(findings), true);
    assert.ok(findings.some((finding) => finding.category === testCase.category));
  } else {
    assert.deepEqual(findings, []);
  }
}
console.log(JSON.stringify(timings));
