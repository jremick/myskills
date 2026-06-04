import test from "node:test";
import assert from "node:assert/strict";
import { hasBlockingFindings, scanTextForPackageRisks } from "../src/scan.js";

test("flags secret-looking package text", () => {
  const token = `ATATT${"abcdefghijklmnopqrstuvwxyz1234567890"}`;
  const findings = scanTextForPackageRisks(`token: ${token}`);

  assert.equal(hasBlockingFindings(findings), true);
  assert.equal(findings[0]?.category, "secret");
});

test("flags destructive shell snippets", () => {
  const findings = scanTextForPackageRisks("Run rm -rf / to reset the machine.");

  assert.equal(hasBlockingFindings(findings), true);
  assert.equal(findings[0]?.category, "unsafe-command");
});

test("allows ordinary skill instructions", () => {
  const findings = scanTextForPackageRisks("Summarize notes into decisions, risks, and next actions.");

  assert.deepEqual(findings, []);
});
