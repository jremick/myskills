#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Ask the installed runtime to load its skill catalog. No thread or model turn is created. */
export async function proveCodexRecognition({ workspace, slug, binary = "codex" }) {
  if (!isAbsolute(workspace) || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(slug)) {
    throw new Error("An absolute workspace and valid skill slug are required.");
  }
  const cwd = await realpath(workspace);
  const expected = await realpath(join(cwd, ".agents", "skills", slug, "SKILL.md"));
  if (!expected.startsWith(`${cwd}/.agents/skills/${slug}/`)) throw new Error("Skill path escapes the workspace.");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("MYSKILLS_") && !key.startsWith("S3_") && !key.startsWith("SMTP_")
    && !["DATABASE_URL", "AUTH_SECRET", "RESEND_API_KEY", "SEED_OWNER_PASSWORD"].includes(key),
  ));
  const child = spawn(binary, ["app-server", "--stdio"], { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  let pending = "";
  let bytes = 0;
  let complete = false;
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    return await new Promise((accept, reject) => {
      const timer = setTimeout(() => fail("Codex skill loading timed out."), 45_000);
      function fail(message) {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        reject(new Error(message));
      }
      child.on("error", () => fail("Could not start the installed Codex runtime."));
      child.on("exit", () => fail("Codex exited before reporting the workspace skill."));
      child.stdin.on("error", () => fail("Codex protocol connection closed."));
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) return fail("Codex response exceeded the verification limit.");
        pending += chunk.toString("utf8");
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { return fail("Codex returned an invalid protocol response."); }
          if (message.id === 1) {
            if (message.error) return fail("Codex initialization was rejected.");
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "skills/list", params: { cwds: [cwd], forceReload: true } });
          }
          if (message.id === 2) {
            if (message.error) return fail("Codex could not load the workspace skill catalog.");
            const entry = message.result?.data?.find((row) => row.cwd === cwd);
            const skill = entry?.skills?.find((row) => row.name === slug && row.path === expected);
            if (!skill || skill.enabled === false) return fail("The installed skill is not enabled in Codex's loaded catalog.");
            if (entry.errors?.some((error) => error.path === expected)) return fail("Codex reported a loading error for the installed skill.");
            complete = true;
            clearTimeout(timer);
            accept({ runtime: "codex", method: "skills/list", recognized: true, slug, scope: skill.scope, modelTurnCreated: false });
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "myskills-runtime-verifier", version: "1.0.0" } } });
    });
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node scripts/prove-codex-recognition.mjs /absolute/workspace skill-slug");
    console.log(JSON.stringify(await proveCodexRecognition({ workspace: process.argv[2], slug: process.argv[3] })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
