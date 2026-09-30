import test from "node:test";
import assert from "node:assert/strict";
import { Client, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import {
  APPLICATION_HANDOFF_ACTIONS,
  createApplicationHandoff,
  registerApplicationHandoffTools,
} from "../src/application-handoffs.js";

// Failure inventory, written before implementation:
// - Advice must not claim an account change, queued execution or completed readback.
// - Missing configuration, forged Host/URL input and unsafe configured origins must
//   never create a guessed or attacker-directed credential collection link.
// - Passwords, MFA/recovery codes and token material must not be tool inputs/outputs.
// - Producer reports and executor receipts must remain local evidence, not writes
//   performed by a general MCP credential.
// - Wrong context IDs, route injection, unknown actions and unknown fields fail closed.
// - Readback is corroborating metadata only; it cannot prove password replacement,
//   filesystem execution, host recognition or real model evaluation by itself.
// Local workflow extension failure inventory (before the helper change):
// - Existing local author/install/bootstrap/improve/detach outcomes must be discoverable.
// - Advice must require user-chosen source/output/install/workspace paths, not infer
//   the MCP server's cwd/home or introduce a remote filesystem mutation endpoint.
// - Local readback commands remain suggestions; detach preserves installed files,
//   bootstrap remains dry-run and improvement still needs explicit plan/cloud consent.

test("handoff inventory covers the exact account, producer and executor boundaries", () => {
  assert.equal(APPLICATION_HANDOFF_ACTIONS.length, 27);
  assert.equal(new Set(APPLICATION_HANDOFF_ACTIONS.map((item) => item.actionId)).size, 27);
  assert.equal(APPLICATION_HANDOFF_ACTIONS.filter((item) => item.kind === "trusted_browser").length, 15);
  assert.equal(APPLICATION_HANDOFF_ACTIONS.filter((item) => item.kind === "local_executor").length, 12);
  for (const item of APPLICATION_HANDOFF_ACTIONS) {
    assert.ok(item.capabilityIds.length > 0, item.actionId);
    const result = createApplicationHandoff({ actionId: item.actionId });
    assert.equal(result.actionId, item.actionId);
    assert.equal(result.status, "action_required");
    assert.equal(result.performed, false);
    assert.equal(result.completion.confirmed, false);
    assert.ok(result.instructions.length > 0);
    assert.ok(result.completion.requiredEvidence.length > 0);
    assert.equal(result.destination.url, undefined);
    for (const readback of result.readback) {
      assert.equal(readback.method, "GET");
      assert.equal(readback.toolName, readback.actionId.replaceAll(".", "_"));
      assert.equal(readback.performed, false);
    }
  }
});

test("trusted browser links use only the configured origin and existing app routes", () => {
  const options = { appBaseUrl: "https://skills.example.test/" };
  for (const [actionId, path] of [
    ["account.register", "/auth/register"],
    ["account.login", "/login"],
    ["account.password_reset.confirm", "/auth/reset-password"],
    ["account.email_verification.confirm", "/auth/verify-email"],
    ["account.email_change.confirm", "/auth/change-email"],
    ["account.password.change", "/settings"],
    ["account.tokens.create", "/settings"],
  ]) {
    const result = createApplicationHandoff({ actionId }, options);
    assert.equal(result.destination.url, `https://skills.example.test${path}`);
    assert.equal(result.destination.path, path);
    assert.match(result.instructions.join(" "), /trusted|directly/i);
  }
  assert.equal(createApplicationHandoff({ actionId: "account.mfa.enroll" }, { appBaseUrl: "http://127.0.0.1:5173" }).destination.url, "http://127.0.0.1:5173/settings");
  assert.equal(createApplicationHandoff({ actionId: "account.login" }, { appBaseUrl: "http://[::1]:5173" }).destination.url, "http://[::1]:5173/login");
  assert.match(createApplicationHandoff({ actionId: "account.login" }).destination.navigation, /MySkills/);
});

test("unsafe configured destinations fail without echoing their contents", () => {
  for (const appBaseUrl of [
    "", "skills.example.test", "//skills.example.test", "http://skills.example.test",
    "javascript:alert(1)", "https://user:synthetic-secret@skills.example.test",
    "https://skills.example.test/path", "https://skills.example.test//attacker.test",
    "https://skills.example.test?token=synthetic-secret", "https://skills.example.test#synthetic-secret",
    " https://skills.example.test", "https://skills.example.test\n", "https://skills.example.test\\@attacker.test",
  ]) {
    assert.throws(() => createApplicationHandoff({ actionId: "account.login" }, { appBaseUrl }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Configure a trusted MySkills app origin using HTTPS or loopback HTTP.");
      assert.equal(error.message.includes("synthetic-secret"), false);
      return true;
    }, appBaseUrl);
  }
});

test("secret-bearing, unknown and route-injection input is rejected without reflection", () => {
  for (const input of [
    { actionId: "admin.users.delete" },
    { actionId: "account.login", password: "synthetic-secret" },
    { actionId: "account.mfa.verify", recoveryCode: "synthetic-secret" },
    { actionId: "account.tokens.create", token: "synthetic-secret" },
    { actionId: "account.login", appBaseUrl: "https://attacker.test" },
    { actionId: "account.login", host: "attacker.test" },
    { actionId: "account.login", targetId: "irrelevant-id" },
    { actionId: "targets.health.report", targetId: "../another-user" },
    { actionId: "targets.health.report", targetId: "target?token=synthetic-secret" },
    { actionId: "targets.health.report", targetId: "x".repeat(129) },
    { actionId: "targets.health.report", targetId: "" },
  ]) {
    assert.throws(() => createApplicationHandoff(input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Choose a supported handoff action and only its bounded resource identifiers.");
      return true;
    });
  }
});

test("local producers return real-run instructions and concrete optional readback only", () => {
  const observed = createApplicationHandoff({ actionId: "targets.observations.report", targetId: "target-1" });
  assert.equal(observed.kind, "local_executor");
  assert.match(observed.instructions.join(" "), /myskills architectures observe/);
  assert.equal(observed.readback.find((item) => item.actionId === "targets.observations.list")?.endpoint, "/v1/architecture-targets/target-1/observations");
  assert.equal(observed.destination.url, undefined);
  const run = createApplicationHandoff({ actionId: "improvements.runs.create", planId: "plan-1" });
  assert.match(run.instructions.join(" "), /accept-plan/);
  assert.match(run.instructions.join(" "), /allow-cloud/);
  assert.equal(run.readback.find((item) => item.actionId === "improvements.plans.get")?.endpoint, "/v1/improvements/plans/plan-1");
  const executor = createApplicationHandoff({ actionId: "target_executor.receipt.report", operationId: "operation-1", targetId: "target-1" });
  assert.match(executor.instructions.join(" "), /targets:execute/);
  assert.match(executor.instructions.join(" "), /lease|fenc/i);
  assert.equal(executor.readback.find((item) => item.actionId === "target_operations.get")?.endpoint, "/v1/target-operations/operation-1");
  assert.match(executor.completion.requiredEvidence.join(" "), /receipt|filesystem|host/i);
});

test("sensitive account guidance distinguishes corroboration from completion", () => {
  const password = createApplicationHandoff({ actionId: "account.password.change" });
  assert.match(password.instructions.join(" "), /password.*chat|chat.*password/i);
  assert.match(password.completion.requiredEvidence.join(" "), /does not prove|cannot prove/i);
  const enrollment = createApplicationHandoff({ actionId: "account.mfa.confirm" });
  assert.match(enrollment.instructions.join(" "), /recovery codes/i);
  assert.equal(enrollment.readback[0]?.actionId, "account.mfa.status");
  assert.match(createApplicationHandoff({ actionId: "account.logout" }).instructions.join(" "), /connections_revoke|connection.*revok/i);
});

test("all existing local workflows expose explicit CLI steps and local readback without an invented API", () => {
  for (const [actionId, capabilityId, commands] of [
    ["local.skills.author", "LOC-01", ["myskills init", "myskills validate", "myskills scan", "myskills package"]],
    ["local.skills.manage", "LOC-02", ["myskills export", "myskills install", "myskills list", "myskills updates", "myskills update", "myskills rollback"]],
    ["local.workspace.bootstrap", "LOC-03", ["myskills architectures observe", "myskills architectures health", "myskills bootstrap codex --dry-run"]],
    ["local.improvements.artifacts", "LOC-04", ["myskills improve plan", "myskills improve run", "myskills improve report", "myskills improve export"]],
    ["local.library.detach", "LOC-05", ["myskills libraries unbind-local", "myskills list"]],
  ] as const) {
    const result = createApplicationHandoff({ actionId }, { appBaseUrl: "https://skills.example.test" });
    assert.deepEqual(result.capabilityIds, [capabilityId]);
    assert.equal(result.kind, "local_executor");
    assert.equal(result.performed, false);
    assert.equal(result.completion.confirmed, false);
    assert.equal(result.destination.url, undefined);
    assert.deepEqual(result.readback, [], "local files are not assigned invented API routes");
    const guidance = [...result.instructions, ...result.cliReadback.map((item) => item.command)].join(" ");
    for (const command of commands) assert.ok(guidance.includes(command), `${actionId}: ${command}`);
    assert.match(guidance, /user.chosen/);
    assert.ok(result.cliReadback.length > 0);
    for (const readback of result.cliReadback) {
      assert.equal(readback.performed, false);
      assert.match(readback.command, /^myskills /);
      assert.match(readback.note, /suggested|not executed/);
    }
    assert.doesNotMatch(JSON.stringify(result), /\/Users\/|process\.cwd|localhost:3001/);
    assert.throws(() => createApplicationHandoff({ actionId, path: "/untrusted-or-secret-path" }));
  }
  assert.match(createApplicationHandoff({ actionId: "local.library.detach" }).instructions.join(" "), /preserv.*installed files|installed files.*unchanged/i);
  assert.match(createApplicationHandoff({ actionId: "local.workspace.bootstrap" }).instructions.join(" "), /does not apply|no.*appl/i);
  const improvement = createApplicationHandoff({ actionId: "local.improvements.artifacts" }).instructions.join(" ");
  assert.match(improvement, /accept-plan/);
  assert.match(improvement, /allow-cloud/);
});

test("MCP handoff tool exposes bounded read-only advice and rejects secret arguments", async () => {
  const clientTransport = new MemoryTransport();
  const serverTransport = new MemoryTransport();
  clientTransport.peer = serverTransport;
  serverTransport.peer = clientTransport;
  const server = new McpServer({ name: "handoff-test", version: "1" });
  registerApplicationHandoffTools(server, { appBaseUrl: "https://skills.example.test" });
  const client = new Client({ name: "handoff-client", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 1);
    assert.equal(tools.tools[0]?.name, "application_handoff");
    assert.equal(tools.tools[0]?.annotations?.readOnlyHint, true);
    assert.equal(tools.tools[0]?.annotations?.destructiveHint, false);
    const response = await client.callTool({ name: "application_handoff", arguments: { actionId: "account.tokens.create" } });
    assert.notEqual(response.isError, true);
    assert.equal(response.structuredContent?.performed, false);
    assert.equal(response.structuredContent?.status, "action_required");
    const local = await client.callTool({ name: "application_handoff", arguments: { actionId: "local.library.detach" } });
    assert.notEqual(local.isError, true);
    assert.equal(local.structuredContent?.performed, false);
    assert.deepEqual(local.structuredContent?.readback, []);
    assert.ok(Array.isArray(local.structuredContent?.cliReadback));
    const denied = await client.callTool({ name: "application_handoff", arguments: { actionId: "account.login", password: "synthetic-secret" } });
    assert.equal(denied.isError, true);
    assert.equal(JSON.stringify(denied).includes("synthetic-secret"), false);
  } finally {
    await client.close();
    await server.close();
  }
});

class MemoryTransport implements Transport {
  peer?: MemoryTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }
  async close(): Promise<void> { this.onclose?.(); }
}
