import { once } from "node:events";
import { runCli, type CliRuntime } from "../../src/cli.js";
import type { ArchitectureTarget } from "@myskills-app/core";

const input = JSON.parse(process.argv[2]) as { workspace: string; authority: string; target: ArchitectureTarget; holdRegistration: boolean };
let target = input.target;
let waiting = false;
const runtime: CliRuntime = {
  env: { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, MYSKILLS_TOKEN: "synthetic-enrollment-process-token" },
  workspaceEnrollmentStateDirectory: input.authority,
  workspaceEnrollmentWait: () => { if (!waiting) { waiting = true; process.send?.({ event: "authority-wait", pid: process.pid }); } },
  io: { stdout: () => {}, stderr: () => {} },
  fetch: async (url, init) => {
    const route = new URL(String(url)).pathname;
    let body: unknown;
    if (route === "/v1/capabilities") body = { instanceId: "11111111-1111-4111-8111-111111111111" };
    else if (route === "/v1/architecture-targets" && init?.method === "POST") {
      const request = JSON.parse(String(init.body));
      target = { ...target, id: `process-${process.pid}`, identityDigest: request.identityDigest, consent: { status: "pending", requestedAt: "2026-10-01T00:00:00.000Z" } };
      process.send?.({ event: "registration", pid: process.pid });
      if (input.holdRegistration) await once(process, "message");
      body = { target };
    } else if (route.endsWith("/consent")) {
      target = { ...target, consent: { status: "granted", requestedAt: target.consent.requestedAt, grantedAt: "2026-10-01T00:00:00.000Z" } };
      body = { target };
    } else if (route === `/v1/architecture-targets/${target.id}`) body = { target };
    else throw new Error("Unexpected enrollment fixture route");
    return new Response(JSON.stringify(body), { status: route === "/v1/architecture-targets" && init?.method === "POST" ? 201 : 200 });
  },
};
const code = await runCli(["codex", "enroll", "--workspace", input.workspace, "--architecture-id", target.architectureId!, "--environment-id", target.environmentId!, "--profile-id", target.profileId!, "--api-url", "http://fixture.test", "--json"], runtime);
process.send?.({ event: "result", code, pid: process.pid });
process.disconnect?.();
process.exitCode = code;
