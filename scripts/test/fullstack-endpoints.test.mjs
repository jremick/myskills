import assert from "node:assert/strict";
import test from "node:test";
import { readFullstackEndpoint } from "../lib/fullstack-endpoints.mjs";

const project = "myskills-ci-endpoint-fixture";
const id = "a".repeat(64);
const composeArgs = ["compose", "--project-name", project, "--file", "docker-compose.e2e.yml"];
const row = () => ({ project, service: "web", running: true, ports: [{ HostIp: "127.0.0.1", HostPort: "49123" }] });
async function read(value, requestedPort = "0", ids = id) {
  const calls = [];
  const endpoint = await readFullstackEndpoint({ project, service: "web", containerPort: 80, requestedPort, composeArgs,
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return args.includes("ps") ? ids : typeof value === "string" ? value : JSON.stringify(value);
    },
  });
  return { endpoint, calls };
}

test("full-stack endpoint reads the daemon-owned port from one exact running Compose service", async () => {
  const { endpoint, calls } = await read(row());
  assert.equal(endpoint, "http://127.0.0.1:49123");
  assert.deepEqual(calls[0].args, [...composeArgs, "ps", "--quiet", "web"]);
  assert.deepEqual(calls[1].args.slice(0, 4), ["inspect", "--type", "container", "--format"]);
  assert.equal(calls[1].args.at(-1), id);
  assert.ok(calls.every(call => call.command === "docker" && call.options.capture === true));
  assert.doesNotMatch(calls[1].args[4], /\.Config\.Env|\.State\.Error/);
  assert.equal((await read(row(), "49123")).endpoint, endpoint, "explicit caller ports must match the actual binding");
  assert.equal((await read({ ...row(), ports: [{ HostIp: "127.0.0.1", HostPort: "49124" }] })).endpoint, "http://127.0.0.1:49124", "a fresh phase must use its own assigned endpoint");
});

test("full-stack endpoint refuses foreign ownership, wildcard/stale/missing and ambiguous bindings", async () => {
  const invalid = [null, [], {}, "not-json", { ...row(), project: "foreign" }, { ...row(), service: "mailpit" }, { ...row(), running: false },
    { ...row(), ports: null }, { ...row(), ports: [] }, { ...row(), ports: [...row().ports, ...row().ports] },
    ...["0.0.0.0", "::", "127.0.0.2"].map(HostIp => ({ ...row(), ports: [{ HostIp, HostPort: "49123" }] })),
    ...[0, "0", "65536", "49123\nPRIVATE-CANARY"].map(HostPort => ({ ...row(), ports: [{ HostIp: "127.0.0.1", HostPort }] })),
  ];
  for (const value of invalid) await assert.rejects(read(value), error => /endpoint ownership or loopback binding is invalid/.test(error.message) && !error.message.includes("PRIVATE-CANARY"));
  await assert.rejects(read(row(), "49124"), /binding is invalid/);
  for (const ids of ["", `${id}\n${"b".repeat(64)}`, "PRIVATE-CANARY"]) await assert.rejects(read(row(), "0", ids), /binding is invalid/);
});
