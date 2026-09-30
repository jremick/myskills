import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiSource = `import type { FastifyInstance } from "fastify";
export function routes(router: FastifyInstance) {
  router.get("/v1/widgets", async () => ({}));
  for (const collection of ["blue", "green"] as const) {
    router.post(\`/v1/\${collection}\`, async () => ({}));
  }
  const unrelated = "router.delete('/v1/fake')";
}
`;
const mcpSource = `export function register(server) {
  server.registerTool("widgets", {inputSchema: z.object({action: z.enum(["list", "create"])})}, () => {});
  server.server.setRequestHandler("resources/list", () => []);
}
`;
const cliSource = `export function dispatchCli(parsed) { switch (parsed.command) {
  case "widgets": return 0;
} }
`;

function run(name, root, ...args) {
  return spawnSync(process.execPath, [path.join(scripts, name), "--root", root, ...args], { encoding: "utf8" });
}
function successful(result) { assert.equal(result.status, 0, result.stdout + result.stderr); }
function rejected(result, message) {
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, message);
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {"apps/api/src/routes.ts": apiSource, "apps/mcp/src/server.ts": mcpSource, "apps/cli/src/cli.ts": cliSource};
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  await mkdir(path.join(root, "docs"));
  const status = { status: "A", detail: "Source operation is reachable", evidence: [{ level: "source", detail: "Fixture route/adapter inspection" }] };
  const inventory = {
    schema_version: 2, audit_date: "2026-09-29", evidence_level: "source",
    baseline_surface: "ui", priority_order: ["api", "cli", "mcp"],
    statuses: {A: "Available", P: "Partial", M: "Missing", B: "Handoff", N: "Mechanism-specific"},
    capabilities: [{ id: "WID-01", domain: "Widgets", capability: "Manage widgets", category: "product", authorization: "Active user", gap: "G01",
      api_operations: [
        {method: "GET", path: "/v1/widgets", source: "apps/api/src/routes.ts", line: 3},
        {method: "POST", path: "/v1/blue", source: "apps/api/src/routes.ts", line: 5},
        {method: "POST", path: "/v1/green", source: "apps/api/src/routes.ts", line: 5},
      ], api: {...status}, cli: {...status}, ui: {...status}, mcp_api_token: {...status}, mcp_oauth: {...status},
    }],
    gaps: [{id: "G01", title: "Widget workflow", detail: "Runtime acceptance remains open"}],
    mcp_tool_inventory: [{name: "widgets", capability_ids: ["WID-01"], actions: [
      {name: "list", capability_ids: ["WID-01"]}, {name: "create", capability_ids: ["WID-01"]}
    ]}],
    native_mcp_handlers: [{name: "resources/list", capability_ids: ["WID-01"]}],
    cli_command_inventory: [{name: "widgets", capability_ids: ["WID-01"]}],
  };
  const save = () => writeFile(path.join(root, "docs/capability-parity.json"), JSON.stringify(inventory, null, 2) + "\n");
  await save();
  successful(run("render-capability-parity.mjs", root));
  return { root, inventory, save };
}

test("classifies real syntax including static route families and ignores source strings", async (t) => {
  const {root} = await fixture(t);
  successful(run("check-capability-parity.mjs", root));
});

test("fails closed for unclassified, removed and unresolved dynamic API routes", async (t) => {
  const {root} = await fixture(t);
  const source = path.join(root, "apps/api/src/routes.ts");
  await writeFile(source, apiSource.replace('router.get("/v1/widgets"', 'router.get("/v1/unclassified"'));
  rejected(run("check-capability-parity.mjs", root), /unclassified API operation GET \/v1\/unclassified/);
  rejected(run("check-capability-parity.mjs", root), /removed API operation GET \/v1\/widgets/);
  await writeFile(source, apiSource.replace('"/v1/widgets"', 'chooseRoute()'));
  rejected(run("check-capability-parity.mjs", root), /cannot resolve API registration/);
});

test("new tool actions, missing handlers and unclassified CLI commands cannot disappear", async (t) => {
  const {root} = await fixture(t);
  await writeFile(path.join(root, "apps/mcp/src/server.ts"), mcpSource.replace('"list", "create"', '"list", "create", "destroy"').replace('server.server.setRequestHandler("resources/list", () => []);', 'server.registerTool("extra", {}, () => {});'));
  await writeFile(path.join(root, "apps/cli/src/cli.ts"), cliSource.replace('case "widgets":', 'case "new-command":'));
  const result = run("check-capability-parity.mjs", root);
  rejected(result, /unclassified MCP tool extra/);
  rejected(result, /unclassified MCP action widgets:destroy/);
  rejected(result, /removed MCP handler resources\/list/);
  rejected(result, /unclassified CLI command new-command/);
});

test("rejects invalid references, duplicate IDs, statuses and unexplained exceptions", async (t) => {
  const {root, inventory, save} = await fixture(t);
  inventory.mcp_tool_inventory[0].capability_ids = ["GONE-01"];
  inventory.capabilities.push({...inventory.capabilities[0], cli: {status: "M", detail: ""}, ui: {status: "green", detail: "Unsupported status"}});
  await save();
  const result = run("check-capability-parity.mjs", root);
  rejected(result, /unknown capability GONE-01/);
  rejected(result, /duplicate capability WID-01/);
  rejected(result, /invalid status green/);
  rejected(result, /requires a reason/);
});

test("changed inventory requires regenerated Markdown and refresh never promotes status", async (t) => {
  const {root, inventory, save} = await fixture(t);
  inventory.capabilities[0].cli = {status: "P", detail: "Create is not yet supported", evidence: [{level: "source", detail: "Inspected CLI"}]};
  await save();
  rejected(run("check-capability-parity.mjs", root), /stale generated matrix/);
  await writeFile(path.join(root, "apps/api/src/routes.ts"), "// unrelated line\n" + apiSource);
  successful(run("render-capability-parity.mjs", root, "--refresh-sources"));
  successful(run("check-capability-parity.mjs", root));
  const updated = JSON.parse(await readFile(path.join(root, "docs/capability-parity.json"), "utf8"));
  assert.equal(updated.capabilities[0].cli.status, "P");
  assert.equal(updated.capabilities[0].api_operations[0].line, 4);
});

test("branch-based command modules are classified as well as the primary switch", async (t) => {
  const {root} = await fixture(t);
  await writeFile(path.join(root, "apps/cli/src/extra-commands.ts"), `export function run(input) {
    if (input.command !== "organizations") return false;
    return true;
  }`);
  rejected(run("check-capability-parity.mjs", root), /unclassified CLI command organizations/);
});

test("tool action schemas referenced by constants cannot evade classification", async (t) => {
  const {root} = await fixture(t);
  await writeFile(path.join(root, "apps/mcp/src/server.ts"), `const choices = ["list", "create", "destroy"] as const;
    const inputSchema = z.object({action: z.enum(choices)});
    const definition = {inputSchema};
    export function register(server) {
      server.registerTool("widgets", definition, () => {});
      server.server.setRequestHandler("resources/list", () => []);
    }`);
  rejected(run("check-capability-parity.mjs", root), /unclassified MCP action widgets:destroy/);
});

test("expands named tools from a source registry and checks action/capability classification", async (t) => {
  const {root, inventory, save} = await fixture(t);
  const registry = path.join(root, "apps/mcp/src/actions.ts");
  await writeFile(registry, `export const ACTIONS = [{id:"widgets.list", capabilityId:"WID-01"}] as const;`);
  await writeFile(path.join(root, "apps/mcp/src/server.ts"), `import {ACTIONS} from "./actions.js";
    export function register(server) {
      for (const action of ACTIONS) server.registerTool(action.id.replaceAll(".", "_"), {
        inputSchema: schemaFor(action), _meta: {actionId: action.id, capabilityId: action.capabilityId}
      }, () => {});
      server.server.setRequestHandler("resources/list", () => []);
    }`);
  inventory.mcp_tool_inventory = [{name: "widgets_list", action_id: "widgets.list", capability_ids: ["WID-01"], actions: []}];
  await save();
  successful(run("render-capability-parity.mjs", root));
  successful(run("check-capability-parity.mjs", root));
  await writeFile(registry, `export const ACTIONS = [{id:"widgets.list", capabilityId:"WID-01"}, {id:"widgets.create", capabilityId:"WID-01"}] as const;`);
  rejected(run("check-capability-parity.mjs", root), /unclassified MCP tool widgets_create/);
  await writeFile(registry, `export const ACTIONS = [{id:"widgets.list", capabilityId:"OTHER-01"}] as const;`);
  rejected(run("check-capability-parity.mjs", root), /MCP tool widgets_list: capability classification differs/);
});

test("static array mapping preserves each handoff action and unknown names fail", async (t) => {
  const {root, inventory, save} = await fixture(t);
  await writeFile(path.join(root, "apps/mcp/src/server.ts"), `const makeHandoff = (actionId: string, capabilityId = "WID-01") => ({actionId, capabilityIds: [capabilityId]});
    const handoffs = [makeHandoff("account.password"), ...["local.install"].map(id => makeHandoff(id))] as const;
    export function register(server) {
      server.registerTool("handoff", {inputSchema: z.object({actionId: z.enum(handoffs.map(item => item.actionId))})}, () => {});
      server.server.setRequestHandler("resources/list", () => []);
    }`);
  inventory.mcp_tool_inventory = [{name: "handoff", capability_ids: ["WID-01"], actions: [{name: "account.password", capability_ids: ["WID-01"]}]}];
  await save();
  successful(run("render-capability-parity.mjs", root));
  rejected(run("check-capability-parity.mjs", root), /unclassified MCP action handoff:local.install/);
});
