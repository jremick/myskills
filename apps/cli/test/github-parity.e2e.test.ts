import assert from "node:assert/strict";
import test from "node:test";
import { runCli, type CliRuntime } from "../src/cli.js";

// Transport contract before implementation: safe GitHub operations must select
// their exact HTTP routes; linking/configuration must not send credentials or
// pretend the browser consent completed. Domain persistence has a PG journey.
test("CLI GitHub adapters preserve safe routes and trusted browser boundaries", async () => {
  const requests: Array<{ method: string; path: string }> = [];
  const output: string[] = [];
  const errors: string[] = [];
  const runtime: CliRuntime = {
    env: { MYSKILLS_API_URL: "https://fixture.example.test", MYSKILLS_TOKEN: "synthetic-session" },
    fetch: async (url, init) => {
      requests.push({ method: init?.method ?? "GET", path: new URL(url).pathname });
      assert.equal(init?.body, undefined);
      return Response.json({ github: { status: "connected", login: "synthetic-user" } });
    },
    io: { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) },
  };
  for (const args of [
    ["account", "github", "status"], ["account", "github", "disconnect"],
    ["admin", "github", "get"], ["admin", "github", "test"],
  ]) {
    assert.equal(await runCli([...args, "--json"], runtime), 0, errors.join("\n"));
  }
  assert.deepEqual(requests, [
    { method: "GET", path: "/v1/account/github" }, { method: "DELETE", path: "/v1/account/github" },
    { method: "GET", path: "/v1/admin/github" }, { method: "POST", path: "/v1/admin/github/test" },
  ]);
  for (const args of [["account", "github", "connect"], ["admin", "github", "configure"]]) {
    output.length = 0;
    assert.equal(await runCli([...args, "--json"], runtime), 0, errors.join("\n"));
    const handoff = JSON.parse(output[0]!);
    assert.equal(handoff.performed, false);
    assert.equal(handoff.completion.confirmed, false);
    assert.match(handoff.instructions, /trusted MySkills/);
  }
  for (const args of [
    ["account", "github", "disconnect", "extra"], ["admin", "github", "set"],
    ["admin", "github", "configure", "--client-secret", "never-send-this"],
  ]) assert.notEqual(await runCli([...args, "--json"], runtime), 0);
  assert.equal(requests.length, 4);
  assert.equal(errors.join("\n").includes("never-send-this"), false);
});
