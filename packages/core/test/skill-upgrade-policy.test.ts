import assert from "node:assert/strict";
import test from "node:test";
import {
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
