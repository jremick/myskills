import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const inventoryPath = "docs/ROADMAP_EXECUTION_REQUIREMENTS.json";
const mappingPath = "docs/roadmap-criterion-bindings.json";
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
const digest = value => createHash("sha256").update(value).digest("hex");
const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
const mapping = JSON.parse(await readFile(mappingPath, "utf8"));
const identityFields = ["id", "source", "start_line", "end_line", "section", "source_kind", "text"];
const preservedFingerprint = "8a21b4dfc6e1b5645f3c1c5da824509204b9532180acb753cfed2c28d8adcc15";
const preservedGroups = ["ACCEPT-01", "ARCH-01", "ARCH-02", "ARCH-03", "ARCH-04", "ARCH-05", "AUTHOR-01", "AUTHOR-02", "BASE-01", "DISC-01", "HIST-01", "HOST-01", "HOST-02", "ID-01", "ID-02", "ID-03", "MCP-01", "MCP-02", "QUALITY-01", "QUALITY-02", "RELEASE-01", "SITE-01", "TRUST-01", "TRUST-02"];
const preservedSources = [{"path": "docs/ROADMAP.md", "sha256": "894692715d5a4b40c66c020420a818134799ba4c15ecaf3a4f358762eb2dbf42"}, {"path": "docs/BUSINESS_SAFE_RELEASE_GOAL.md", "sha256": "60f37ce3e41387f093fd2d13e36a404d6578c6dd3c9c72f3b72d43a7d2c601ea"}, {"path": "docs/SKILL_ARCHITECTURE_CONTROL_PLANE.md", "sha256": "a0e6107f28b60e43ce98dcfa37b02113b5951432b95d502a5bc297b6543e7044"}, {"path": "docs/ARCHITECTURE_WORKBENCH.md", "sha256": "a355d43e294ece3eeb4e0523dea3ac088440d4db3a6af484b0d55dc752d58c7c"}];
const original = inventory.criteria.map(row => Object.fromEntries(identityFields.map(key => [key, row[key]]))).sort((a, b) => a.id.localeCompare(b.id));
if (original.length !== 426 || new Set(original.map(row => row.id)).size !== 426 || digest(canonical(original)) !== preservedFingerprint) throw new Error("Original criterion identity changed.");
if (canonical(inventory.sources) !== canonical(preservedSources)) throw new Error("Captured source descriptors changed.");
if (canonical(Object.keys(inventory.backlog_owners).sort()) !== canonical(preservedGroups) || preservedGroups.length !== 24) throw new Error("Backlog groups changed.");
if (canonical(mapping.identity_fields) !== canonical(identityFields) || mapping.preserved_contract_sha256 !== preservedFingerprint || canonical(mapping.baseline_source_descriptors) !== canonical(preservedSources) || canonical(mapping.backlog_group_ids) !== canonical(preservedGroups)) throw new Error("Binding baseline constants changed.");
if (canonical(Object.keys(mapping.bindings).sort()) !== canonical(original.map(row => row.id))) throw new Error("Exact-ID binding coverage changed.");
const refresh = process.argv.includes("--refresh-source-hashes");
const checkOnly = process.argv.includes("--check") || new URL(import.meta.url).searchParams.has("check");
if (refresh && checkOnly) throw new Error("Read-only checks cannot refresh source bindings.");
const sourceCache = new Map();
for (const row of inventory.criteria) {
  const binding = mapping.bindings[row.id];
  if (binding.original_section_posture !== row.section || binding.source_contract !== row.text || binding.complete !== false || !binding.remaining_gap || !binding.sources.length || !binding.checks.length) throw new Error(`Invalid binding: ${row.id}`);
  for (const ref of [...binding.sources, ...binding.checks]) {
    if (!sourceCache.has(ref.path)) sourceCache.set(ref.path, await readFile(ref.path, "utf8"));
    const body = sourceCache.get(ref.path);
    if (body.split("\n")[ref.line - 1]?.trim().slice(0, 220) !== ref.anchor) throw new Error(`Stale anchor: ${row.id} ${ref.path}:${ref.line}`);
    if (refresh) ref.sha256 = digest(body);
    else if (ref.sha256 !== digest(body)) throw new Error(`Stale source hash: ${row.id} ${ref.path}`);
  }
  const current = { mapping: `${mappingPath}#/bindings/${row.id}`, current_state: binding.current_state, complete: false,
    sources: binding.sources.map(({ path, line }) => ({ path, line })),
    checks: binding.checks.map(({ path, line, execution, receipt, command }) => ({ path, line, execution, command, ...(receipt ? { receipt } : {}) })), remaining_gap: binding.remaining_gap };
  const evidence = { level: "source_inspection", binding: current.mapping, criterion_id: row.id, acceptance: "not_complete" };
  const retained = row.evidence.filter(item => item.binding !== current.mapping);
  if (checkOnly) {
    if (canonical(row.current_binding) !== canonical(current) || row.state !== binding.current_state || !row.evidence.some(item => canonical(item) === canonical(evidence))) throw new Error(`Unreconciled criterion: ${row.id}`);
  } else {
    row.current_binding = current;
    row.state = binding.current_state;
    row.evidence = [...retained, evidence];
    row.acceptance_plan = { ...row.acceptance_plan, checks: undefined, state: "criterion_bound_acceptance_pending", criterion_binding: current.mapping, checks_reference: `${current.mapping}/checks`, remaining_gap: binding.remaining_gap };
  }
}
if (!checkOnly) {
  if (refresh) await writeFile(mappingPath, JSON.stringify(mapping, null, 2) + "\n");
  await writeFile(inventoryPath, JSON.stringify(inventory, null, 2) + "\n");
}
const states = {};
for (const binding of Object.values(mapping.bindings)) states[binding.current_state] = (states[binding.current_state] ?? 0) + 1;
console.log(JSON.stringify({ criteria: original.length, bound: Object.keys(mapping.bindings).length, original_contract_sha256: digest(canonical(original)), backlog_groups: mapping.backlog_group_ids.length, complete: 0, states }, null, 2));
