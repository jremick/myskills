import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const inventoryPath = "docs/ROADMAP_EXECUTION_REQUIREMENTS.json", mappingPath = "docs/roadmap-criterion-bindings.json";
test("criterion gate is read-only and rejects identity, captured-source, group and current binding tampering", t => {
  const directory = mkdtempSync(join(tmpdir(), "myskills-criterion-gate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inventoryText = readFileSync(join(repository, inventoryPath), "utf8"), mappingText = readFileSync(join(repository, mappingPath), "utf8");
  const originalInventory = JSON.parse(inventoryText), originalMapping = JSON.parse(mappingText);
  const paths = new Set([inventoryPath, mappingPath, ...Object.values(originalMapping.bindings).flatMap(binding => [...binding.sources, ...binding.checks].map(ref => ref.path))]);
  for (const file of paths) { mkdirSync(dirname(join(directory, file)), { recursive: true }); copyFileSync(join(repository, file), join(directory, file)); }
  const run = () => spawnSync(process.execPath, [join(repository, "scripts/reconcile-roadmap-criteria.mjs"), "--check"], { cwd: directory, encoding: "utf8", timeout: 10_000 });
  const baseline = run(); assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(readFileSync(join(directory, inventoryPath), "utf8"), inventoryText);
  assert.equal(readFileSync(join(directory, mappingPath), "utf8"), mappingText);
  for (const change of [
    (inventory) => { inventory.criteria[0].text += " tampered"; },
    (inventory, mapping) => { inventory.sources[0].sha256 = "f".repeat(64); mapping.baseline_source_descriptors = inventory.sources; },
    (inventory, mapping) => { const key = Object.keys(inventory.backlog_owners)[0]; inventory.backlog_owners.replaced = inventory.backlog_owners[key]; delete inventory.backlog_owners[key]; mapping.backlog_group_ids = Object.keys(inventory.backlog_owners).sort(); },
    (_inventory, mapping) => { mapping.identity_fields = ["id"]; mapping.preserved_contract_sha256 = "f".repeat(64); },
    (_inventory, mapping) => { Object.values(mapping.bindings)[0].sources[0].sha256 = "f".repeat(64); },
    (inventory) => { inventory.criteria[0].current_binding.remaining_gap = "fabricated complete"; },
  ]) {
    const inventory = structuredClone(originalInventory), mapping = structuredClone(originalMapping); change(inventory, mapping);
    writeFileSync(join(directory, inventoryPath), JSON.stringify(inventory)); writeFileSync(join(directory, mappingPath), JSON.stringify(mapping));
    const rejected = run(); assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /changed|Stale|Unreconciled/);
  }
});
