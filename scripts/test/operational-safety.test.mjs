import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { acceptanceConfiguration, acceptanceCliFailure, capturedProcess, runOperationalAcceptance } from "../operational-acceptance.mjs";
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

test("operational CLI failure exposes only the fixed composed operation and allowlisted category", async () => {
  const result = await capturedProcess(process.execPath, ["-e", `process.stderr.write(JSON.stringify({ error: { code: "API_RATE_LIMITED", status: 429, message: "PRIVATE-RAW-ERROR", details: { token: "PRIVATE-TOKEN" } } })); process.exitCode=1;`]);
  assert.equal(result.code, 1);
  assert.equal(result.failureCategory, "API_RATE_LIMITED");
  assert.equal("stderr" in result, false);
  assert.equal(acceptanceCliFailure(["architecture-artifacts", "apply", "PRIVATE-RUN", "--workspace", "PRIVATE-PATH"], result, { phase: "initial", workspaceIndex: 0 }), "CLI architecture-artifacts/apply failed with exit code 1; category=API_RATE_LIMITED; status=429; phase=initial; workspace=0.");
  const denied = await capturedProcess(process.execPath, ["-e", `process.stderr.write(JSON.stringify({ error: { code: "PRIVATE-CODE", message: "PRIVATE-ERROR" } })); process.exitCode=1;`]);
  assert.equal(denied.failureCategory, "unclassified");
  const malformed = await capturedProcess(process.execPath, ["-e", `process.stderr.write('PRIVATE-NON-JSON'); process.exitCode=1;`]);
  assert.equal(malformed.failureCategory, "unclassified");
  const local = await capturedProcess(process.execPath, ["-e", `process.stderr.write(JSON.stringify({ error: { code: "UNEXPECTED_CLI_FAILURE", message: "EACCES: PRIVATE-PATH PRIVATE-TOKEN" } })); process.exitCode=1;`]);
  assert.equal(acceptanceCliFailure(["architecture-artifacts", "prepare"], local, { phase: "update", workspaceIndex: 1 }), "CLI architecture-artifacts/prepare failed with exit code 1; category=filesystem; filesystemCode=EACCES; phase=update; workspace=1.");
  for (const [code, message, category] of [["ARCHITECTURE_ARTIFACT_STATE_CONFLICT", "PRIVATE-API-MESSAGE", "ARCHITECTURE_ARTIFACT_STATE_CONFLICT"], ["UNEXPECTED_CLI_FAILURE", "Whole-artifact staging drifted.", "local_staging"], ["UNEXPECTED_CLI_FAILURE", "Aggregate architecture readback failed.", "local_readback"], ["UNEXPECTED_CLI_FAILURE", "Whole-artifact staging drifted. PRIVATE-SUFFIX", "UNEXPECTED_CLI_FAILURE"]]) {
    const captured = await capturedProcess(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(JSON.stringify({ error: { code, message } }))}); process.exitCode=1;`]);
    assert.equal(captured.failureCategory, category);
    assert.doesNotMatch(acceptanceCliFailure(["architecture-artifacts", "verify"], captured), /PRIVATE|drifted|readback failed/);
  }
  assert.equal(acceptanceCliFailure(["PRIVATE-COMMAND", "PRIVATE-ACTION"], { code: "PRIVATE-EXIT", failureCategory: "PRIVATE-CATEGORY", failureStatus: "PRIVATE-STATUS", filesystemCode: "PRIVATE-CODE" }, { phase: "PRIVATE-PHASE", workspaceIndex: "PRIVATE-INDEX" }), "CLI unknown failed with exit code unavailable; category=unclassified.");
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
