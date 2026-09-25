import assert from "node:assert/strict";
import test from "node:test";
import {
  composeSkillUpgradePolicies,
  skillUpgradePoliciesAllowExecution,
  isWithinSkillUpgradeMaintenanceWindow,
  normalizeSkillUpgradePolicyV1,
  skillUpgradePolicyDigest,
} from "../src/index.js";

test("upgrade policies normalize stable pins and produce deterministic digests", () => {
  const first = normalizeSkillUpgradePolicyV1({
    pins: { "z-skill": "2.0.0", "a-skill": "1.0.0" },
    allowedChangeKinds: ["security", "fix", "security"],
  });
  const second = normalizeSkillUpgradePolicyV1({
    allowedChangeKinds: ["fix", "security"],
    pins: { "a-skill": "1.0.0", "z-skill": "2.0.0" },
  });
  assert.deepEqual(first, second);
  assert.equal(skillUpgradePolicyDigest(first), skillUpgradePolicyDigest(second));
});

test("maintenance windows use the declared timezone and remain fail closed", () => {
  const policy = normalizeSkillUpgradePolicyV1({
    mode: "maintenance-window",
    maintenanceWindow: {
      timeZone: "Australia/Melbourne",
      daysOfWeek: [3],
      startMinute: 120,
      durationMinutes: 60,
    },
  });
  assert.equal(isWithinSkillUpgradeMaintenanceWindow(policy, new Date("2026-09-01T16:30:00.000Z")), true);
  assert.equal(isWithinSkillUpgradeMaintenanceWindow(policy, new Date("2026-09-01T18:30:00.000Z")), false);
  assert.throws(() => normalizeSkillUpgradePolicyV1({ mode: "maintenance-window" }), /maintenance window is required/i);
});

test("policy composition retains each source and never flattens conflicting constraints", () => {
  const organization = normalizeSkillUpgradePolicyV1({ allowedChangeKinds: ["fix"], pins: { helper: "1.0.0" } });
  const target = normalizeSkillUpgradePolicyV1({ allowedChangeKinds: ["feature"], includePrerelease: true, pins: { helper: "2.0.0" } });
  const constraints = composeSkillUpgradePolicies({ organization, target });
  assert.deepEqual(constraints.map(({ source }) => source), ["organization", "target"]);
  assert.deepEqual(constraints.map(({ policy }) => policy.allowedChangeKinds), [["fix"], ["feature"]]);
  assert.deepEqual(constraints.map(({ policy }) => policy.pins.helper), ["1.0.0", "2.0.0"]);
  assert.equal(composeSkillUpgradePolicies({})[0]?.source, "default");
  assert.equal(composeSkillUpgradePolicies({ target })[0]?.policy.includePrerelease, true);
});

test("manual work must satisfy every maintenance window at the same instant across time zones", () => {
  const organization = normalizeSkillUpgradePolicyV1({ mode: "maintenance-window", maintenanceWindow: {
    timeZone: "Australia/Melbourne", daysOfWeek: [3], startMinute: 600, durationMinutes: 60,
  } });
  const target = normalizeSkillUpgradePolicyV1({ mode: "maintenance-window", maintenanceWindow: {
    timeZone: "America/New_York", daysOfWeek: [2], startMinute: 1200, durationMinutes: 60,
  } });
  const overlap = new Date("2026-09-02T00:30:00.000Z");
  assert.equal(skillUpgradePoliciesAllowExecution(composeSkillUpgradePolicies({ organization, target }), overlap), true);
  assert.equal(skillUpgradePoliciesAllowExecution(composeSkillUpgradePolicies({ organization, target }), new Date("2026-09-02T01:00:00.000Z")), false);
  const manual = normalizeSkillUpgradePolicyV1({ mode: "manual" });
  assert.equal(skillUpgradePoliciesAllowExecution(composeSkillUpgradePolicies({ organization, target: manual }), overlap), true);
  assert.equal(skillUpgradePoliciesAllowExecution(composeSkillUpgradePolicies({ organization, target: manual }), new Date("2026-09-02T01:00:00.000Z")), false);
  const disjoint = normalizeSkillUpgradePolicyV1({ mode: "maintenance-window", maintenanceWindow: {
    timeZone: "UTC", daysOfWeek: [3], startMinute: 60, durationMinutes: 60,
  } });
  for (const instant of ["2026-09-02T00:30:00.000Z", "2026-09-02T01:30:00.000Z"]) {
    assert.equal(skillUpgradePoliciesAllowExecution(composeSkillUpgradePolicies({ organization, target: disjoint }), new Date(instant)), false);
  }
  assert.equal(skillUpgradePoliciesAllowExecution(composeSkillUpgradePolicies({}), overlap), true);
  assert.equal(skillUpgradePoliciesAllowExecution([], overlap), false);
});
