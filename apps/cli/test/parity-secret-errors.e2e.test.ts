import assert from "node:assert/strict";
import test from "node:test";
import { runCli, type CliRuntime } from "../src/cli.js";

// Failure inventory before repair: an API validation/transport error can echo
// a prompted password into human or JSON stderr. Retain safe code/status only.
test("CLI account failures do not echo prompted credentials from upstream errors", async () => {
  for (const json of [false, true]) {
    const secret = "synthetic prompt password";
    const errors: string[] = [];
    const runtime: CliRuntime = {
      env: { MYSKILLS_API_URL: "https://fixture.example.test", MYSKILLS_TOKEN: "fixture-session" },
      prompt: { secret: async () => secret, text: async () => "" },
      fetch: async () => new Response(JSON.stringify({ error: { code: "INVALID_PASSWORD", message: `Rejected password: ${secret}` } }), { status: 400, headers: { "content-type": "application/json" } }),
      io: { stdout: () => {}, stderr: (text) => errors.push(text) },
    };
    assert.notEqual(await runCli(["account", "change-password", ...(json ? ["--json"] : [])], runtime), 0);
    assert.equal(errors.join("\n").includes(secret), false);
    if (json) {
      assert.equal(JSON.parse(errors[0]!).error.code, "INVALID_PASSWORD");
      assert.equal(JSON.parse(errors[0]!).error.status, 400);
    }
  }
});
