import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { acceptanceConfiguration, runOperationalAcceptance } from "../operational-acceptance.mjs";
import { recoveryConfiguration, rehearseRegistryRecovery } from "../rehearse-registry-recovery.mjs";

test("acceptance defaults to loopback and rejects a remote endpoint before any fixture writes", () => {
  assert.equal(acceptanceConfiguration({ MYSKILLS_E2E_BASE_URL: "http://127.0.0.1:43100" }).environment, "local");
  assert.throws(() => acceptanceConfiguration({ MYSKILLS_ACCEPTANCE_API_URL: "https://skills.example.test/api" }), /loopback/);
});

test("staging acceptance requires an independently supplied instance identity", () => {
  const env = { MYSKILLS_ACCEPTANCE_API_URL: "https://staging.example.test/api", MYSKILLS_ACCEPTANCE_ENVIRONMENT: "staging" };
  assert.throws(() => acceptanceConfiguration(env), /INSTANCE_ID/);
  assert.equal(acceptanceConfiguration({ ...env, MYSKILLS_ACCEPTANCE_INSTANCE_ID: "fixture-instance" }).expectedInstanceId, "fixture-instance");
  assert.throws(() => acceptanceConfiguration({ ...env, MYSKILLS_ACCEPTANCE_ENVIRONMENT: "production" }), /local or staging/);
});

test("endpoint validation does not print a credential embedded in an invalid URL", () => {
  const marker = "private-value-not-for-output";
  for (const value of [`https://user:${marker}@staging.example.test/api`, `https://staging.example.test/api?token=${marker}`]) {
    assert.throws(() => acceptanceConfiguration({ MYSKILLS_ACCEPTANCE_API_URL: value }), (error) => {
      assert.equal(error.message.includes(marker), false);
      return true;
    });
  }
});

test("a different live instance is rejected before onboarding or fixture mutations", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ instanceId: "another-instance", version: "fixture" }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(runOperationalAcceptance({ env: {
    MYSKILLS_ACCEPTANCE_API_URL: `http://127.0.0.1:${server.address().port}`,
    MYSKILLS_ACCEPTANCE_ENVIRONMENT: "staging",
    MYSKILLS_ACCEPTANCE_INSTANCE_ID: "expected-instance",
    MYSKILLS_ACCEPTANCE_CLI_PATH: process.execPath,
  } }), /identity does not match/);
  assert.deepEqual(requests, [{ method: "GET", path: "/v1/capabilities" }]);
});

test("recovery rejects remote restore database and object storage destinations", () => {
  assert.throws(() => recoveryConfiguration({ ...recoveryEnv(), MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL: "postgres://fixture:fixture@production.example.test/postgres" }), /loopback/);
  assert.throws(() => recoveryConfiguration({ ...recoveryEnv(), MYSKILLS_RECOVERY_DESTINATION_S3_ENDPOINT: "https://storage.example.test" }), /loopback/);
  assert.equal(recoveryConfiguration(recoveryEnv()).maximumBytes, 512 * 1024 * 1024);
});

test("recovery rejects unsupported connection options and unsafe byte budgets", () => {
  assert.throws(() => recoveryConfiguration({ ...recoveryEnv(), MYSKILLS_RECOVERY_SOURCE_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1/source?options=unsafe" }), /unsupported/);
  for (const budget of ["-1", "NaN", "9999999999999", "1.2"]) {
    assert.throws(() => recoveryConfiguration({ ...recoveryEnv(), MYSKILLS_RECOVERY_MAXIMUM_BYTES: budget }), /byte budget/);
  }
});

test("recovery cannot put credential-bearing backups inside the checkout", async () => {
  await assert.rejects(rehearseRegistryRecovery({ ...recoveryEnv(), MYSKILLS_RECOVERY_OUTPUT_PARENT: process.cwd() }), /outside the source repository/);
});

function recoveryEnv() {
  return {
    MYSKILLS_RECOVERY_SOURCE_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1/source",
    MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL: "postgres://fixture:fixture@127.0.0.1/postgres",
    MYSKILLS_RECOVERY_SOURCE_S3_ENDPOINT: "http://127.0.0.1:9000",
    MYSKILLS_RECOVERY_SOURCE_S3_BUCKET: "fixture-source",
    MYSKILLS_RECOVERY_SOURCE_S3_ACCESS_KEY_ID: "fixture-access",
    MYSKILLS_RECOVERY_SOURCE_S3_SECRET_ACCESS_KEY: "fixture-secret",
    MYSKILLS_RECOVERY_DESTINATION_S3_ENDPOINT: "http://127.0.0.1:9000",
    MYSKILLS_RECOVERY_DESTINATION_S3_ACCESS_KEY_ID: "fixture-access",
    MYSKILLS_RECOVERY_DESTINATION_S3_SECRET_ACCESS_KEY: "fixture-secret",
  };
}
