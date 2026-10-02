import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fullstackPhases } from "./lib/fullstack-phases.mjs";
import { readFullstackEndpoint } from "./lib/fullstack-endpoints.mjs";
import { buildFullstackImages, requireFullstackImages } from "./lib/fullstack-images.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = resolve(root, "docker-compose.e2e.yml");
// CI runners pass an exact per-run project so they can clean up after a hard stop.
const projectName = process.env.MYSKILLS_E2E_COMPOSE_PROJECT ?? `myskills-beta2-e2e-${process.pid}-${randomBytes(4).toString("hex")}`;
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectName)) {
  console.error("MYSKILLS_E2E_COMPOSE_PROJECT must be a lowercase Docker Compose project name of at most 63 characters.");
  process.exit(1);
}
const webPort = process.env.MYSKILLS_E2E_WEB_PORT ?? "0";
const mailpitPort = process.env.MYSKILLS_E2E_MAILPIT_PORT ?? "0";
for (const port of [webPort, mailpitPort]) {
  if (port !== "0" && (!/^[1-9]\d{3,4}$/.test(port) || Number(port) < 1024 || Number(port) > 65535)) throw new Error("Full-stack published ports must be 0 (automatic) or 1024..65535.");
}
let baseURL;
const composeArgs = ["compose", "--project-name", projectName, "--file", composeFile];
const environment = {
  ...process.env,
  COMPOSE_PROGRESS: "plain",
  MYSKILLS_E2E_AUTH_SECRET: randomCredential(48),
  MYSKILLS_E2E_INVITEE_PASSWORD: randomCredential(24),
  MYSKILLS_E2E_MAILPIT_PORT: mailpitPort,
  MYSKILLS_E2E_MINIO_ROOT_PASSWORD: randomCredential(24),
  MYSKILLS_E2E_MINIO_ROOT_USER: `e2e${randomBytes(6).toString("hex")}`,
  MYSKILLS_E2E_OWNER_EMAIL: "beta2-owner@example.test",
  MYSKILLS_E2E_OWNER_PASSWORD: randomCredential(24),
  MYSKILLS_E2E_POSTGRES_PASSWORD: randomCredential(24),
  MYSKILLS_E2E_WEB_PORT: webPort,
  // Bootstrap configuration only. No authenticated journey runs until the
  // daemon's actual bound origin is read back and configured in API/MCP.
  MYSKILLS_E2E_PUBLIC_WEB_PORT: webPort === "0" ? "43100" : webPort,
};
// Container logs can echo these generated values; keep them out of CI output.
const generatedSecrets = [
  environment.MYSKILLS_E2E_AUTH_SECRET,
  environment.MYSKILLS_E2E_INVITEE_PASSWORD,
  environment.MYSKILLS_E2E_MINIO_ROOT_PASSWORD,
  environment.MYSKILLS_E2E_MINIO_ROOT_USER,
  environment.MYSKILLS_E2E_OWNER_PASSWORD,
  environment.MYSKILLS_E2E_POSTGRES_PASSWORD,
];

// Arguments after `--` are Playwright test filters, such as a spec file or
// --grep. Without filters, registry journeys and the remote MCP connector
// journey each run on their own fresh disposable stack; the production login
// limiter is unchanged, and journeys sharing this host address stay isolated.
const phases = fullstackPhases(process.argv.slice(2));
let stackUp = false;
let imageDirectory;
let frozenImages;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void teardown().finally(() => removeImageOverride()).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

try {
  await run("docker", [...composeArgs, "config", "--quiet"]);
  // Build the CLI packages once; each phase gets fresh containers and data.
  await run("npm", ["run", "build", "-w", "@myskills-app/core", "-w", "@myskills-app/skill-package", "-w", "@jarel/myskills"]);
  frozenImages = await buildFullstackImages({ run, composeArgs, project: projectName });
  // Pull external dependencies once. Later stacks must never build or pull a
  // replacement when an image from this invocation is missing.
  await run("docker", [...composeArgs, "pull", "--ignore-buildable"]);
  imageDirectory = await mkdtemp(resolve(tmpdir(), "myskills-fullstack-images-"));
  const imageOverride = resolve(imageDirectory, "images.json");
  await writeFile(imageOverride, JSON.stringify({ services: Object.fromEntries(Object.entries(frozenImages).map(([service, image]) => [service, { image, pull_policy: "never" }])) }), { mode: 0o600 });
  composeArgs.push("--file", imageOverride);
  for (const phase of phases) {
    console.log(`Full-stack phase "${phase.name}" on a fresh disposable stack.`);
    await runPhase(phase);
  }
} finally {
  try { await teardown(); } finally { await removeImageOverride(); }
}

async function runPhase(phase) {
  try {
    await requireFullstackImages({ run, images: frozenImages });
    stackUp = true;
    await run("docker", [...composeArgs, "up", "--no-build", "--pull", "never", "--detach", "--wait", "--wait-timeout", "300"]);
    const endpoint = (service, containerPort, requestedPort) => readFullstackEndpoint({ run, composeArgs, project: projectName, service, containerPort, requestedPort });
    baseURL = await endpoint("web", 80, webPort);
    environment.MYSKILLS_E2E_BASE_URL = baseURL;
    environment.MYSKILLS_E2E_MAILPIT_URL = await endpoint("mailpit", 8025, mailpitPort);
    environment.MYSKILLS_E2E_PUBLIC_WEB_PORT = new URL(baseURL).port;
    if (webPort === "0") {
      // Keep the already-bound web/Mailpit containers. Configure exact OAuth
      // issuer/consent and cookie origins before the first authenticated read.
      await run("docker", [...composeArgs, "up", "--no-build", "--pull", "never", "--no-deps", "--detach", "--wait", "--wait-timeout", "300", "api", "mcp"]);
      // Reload nginx upstream addresses after API/MCP recreation while keeping
      // the web container and its listening socket/daemon binding intact.
      await run("docker", [...composeArgs, "exec", "--no-TTY", "web", "nginx", "-s", "reload"]);
    }
    if (await endpoint("web", 80, webPort) !== baseURL || await endpoint("mailpit", 8025, mailpitPort) !== environment.MYSKILLS_E2E_MAILPIT_URL) throw new Error("Full-stack bound endpoints changed during origin configuration.");
    console.log(`Full-stack bound endpoints: web=${baseURL} mailpit=${environment.MYSKILLS_E2E_MAILPIT_URL}`);
    // Remote MCP OAuth discovery, authorization, token and MCP paths must reach
    // the API and MCP services through the production nginx template.
    await run(process.execPath, [resolve(root, "scripts/check-mcp-oauth-routing.mjs"), "--origin", baseURL]);
    const owner = await prepareOwnerMfa();
    environment.MYSKILLS_E2E_OWNER_RECOVERY_CODES = JSON.stringify(owner.recoveryCodes);
    environment.MYSKILLS_ACCEPTANCE_OWNER_TOKEN = owner.sessionToken;
    generatedSecrets.push(owner.sessionToken, ...owner.recoveryCodes);
    if (phase.jsonReport) environment.MYSKILLS_E2E_JSON_REPORT = resolve(root, "apps/web", phase.jsonReport);
    else delete environment.MYSKILLS_E2E_JSON_REPORT;
    await run(resolve(root, "node_modules/.bin/playwright"), [
      "test",
      "--config",
      resolve(root, "apps/web/playwright.fullstack.config.ts"),
      ...(phase.outputDir ? ["--output", resolve(root, "apps/web", phase.outputDir)] : []),
      ...phase.playwrightArgs,
    ]);
  } catch (error) {
    await run("docker", [...composeArgs, "ps"], { allowFailure: true });
    await run("docker", [...composeArgs, "logs", "--no-color", "--tail", "200"], { allowFailure: true });
    throw error;
  } finally {
    await teardown();
  }
}

async function removeImageOverride() {
  if (imageDirectory) await rm(imageDirectory, { recursive: true, force: true });
}

async function teardown() {
  if (!stackUp) {
    return;
  }
  stackUp = false;
  await run("docker", [...composeArgs, "down", "--volumes", "--remove-orphans", "--timeout", "10"], { allowFailure: true });
}

function randomCredential(bytes) {
  return randomBytes(bytes).toString("base64url");
}

async function prepareOwnerMfa() {
  const sessionResponse = await fetch(`${baseURL}/api/v1/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-myskills-session-response": "cookie",
    },
    body: JSON.stringify({
      email: environment.MYSKILLS_E2E_OWNER_EMAIL,
      password: environment.MYSKILLS_E2E_OWNER_PASSWORD,
    }),
  });
  await requireOk(sessionResponse, "Owner E2E login");
  const setCookie = sessionResponse.headers.get("set-cookie");
  const sessionCookie = setCookie?.split(";", 1)[0];
  if (!sessionCookie) {
    throw new Error("Owner E2E login did not return a session cookie.");
  }

  const enrollmentResponse = await fetch(`${baseURL}/api/v1/auth/mfa/totp/enroll`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: sessionCookie,
      origin: baseURL,
    },
    body: JSON.stringify({ password: environment.MYSKILLS_E2E_OWNER_PASSWORD, label: "Full-stack E2E" }),
  });
  const enrollmentBody = await requireJson(enrollmentResponse, "Owner E2E MFA enrollment");
  const enrollment = enrollmentBody.enrollment;
  if (!enrollment?.factorId || !enrollment.secret) {
    throw new Error("Owner E2E MFA enrollment response was incomplete.");
  }

  const confirmationResponse = await fetch(`${baseURL}/api/v1/auth/mfa/totp/confirm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: sessionCookie,
      origin: baseURL,
    },
    body: JSON.stringify({
      factorId: enrollment.factorId,
      code: generateTotpCode(enrollment.secret),
    }),
  });
  const confirmationBody = await requireJson(confirmationResponse, "Owner E2E MFA confirmation");
  const recoveryCodes = confirmationBody.mfa?.recoveryCodes;
  if (!Array.isArray(recoveryCodes) || recoveryCodes.length < 4 || recoveryCodes.some((code) => typeof code !== "string")) {
    throw new Error("Owner E2E MFA confirmation did not return enough recovery codes.");
  }
  // Enrollment does not upgrade the existing session's MFA assurance. Obtain a
  // verified session for fixture administration without consuming browser codes.
  const challengeResponse = await fetch(`${baseURL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: environment.MYSKILLS_E2E_OWNER_EMAIL, password: environment.MYSKILLS_E2E_OWNER_PASSWORD }),
  });
  const challenge = await requireJson(challengeResponse, "Owner E2E MFA login");
  if (!challenge.mfaRequired || !challenge.challengeToken || !recoveryCodes[6]) throw new Error("Owner E2E MFA challenge was incomplete.");
  const verifiedResponse = await fetch(`${baseURL}/api/v1/auth/mfa/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeToken: challenge.challengeToken, recoveryCode: recoveryCodes[6] }),
  });
  const verified = await requireJson(verifiedResponse, "Owner E2E MFA verification");
  if (!verified.token || !verified.user?.mfaVerified) throw new Error("Owner E2E session was not MFA verified.");
  return { recoveryCodes, sessionToken: verified.token };
}

async function requireJson(response, label) {
  await requireOk(response, label);
  return response.json();
}

async function requireOk(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}.`);
  }
}

function generateTotpCode(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = secret.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) {
      throw new Error("Owner E2E MFA secret was not base32 encoded.");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  );
  return String(binary % 1_000_000).padStart(6, "0");
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let captured = "", overflow = false;
    if (options.capture) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        if (captured.length + chunk.length > 8192) overflow = true;
        else if (!overflow) captured += chunk;
      });
    } else forwardRedacted(child.stdout, process.stdout);
    forwardRedacted(child.stderr, process.stderr);
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (overflow) { rejectPromise(new Error("Full-stack endpoint readback exceeded its bounded size.")); return; }
      if (code === 0 || options.allowFailure) {
        resolvePromise(options.capture ? captured : undefined);
        return;
      }
      rejectPromise(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}

function forwardRedacted(input, output) {
  // Line buffering keeps a value split across chunks from escaping redaction.
  let pending = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop();
    for (const line of lines) output.write(`${redact(line)}\n`);
  });
  input.on("end", () => {
    if (pending) output.write(redact(pending));
  });
}

function redact(text) {
  let redacted = text;
  for (const secret of generatedSecrets) {
    if (secret) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}
