import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = resolve(root, "docker-compose.e2e.yml");
const projectName = `myskills-beta2-e2e-${process.pid}-${randomBytes(4).toString("hex")}`;
const webPort = "43100";
const mailpitPort = "43101";
const baseURL = `http://127.0.0.1:${webPort}`;
const composeArgs = ["compose", "--project-name", projectName, "--file", composeFile];
const environment = {
  ...process.env,
  COMPOSE_PROGRESS: "plain",
  MYSKILLS_E2E_AUTH_SECRET: randomCredential(48),
  MYSKILLS_E2E_BASE_URL: baseURL,
  MYSKILLS_E2E_INVITEE_PASSWORD: randomCredential(24),
  MYSKILLS_E2E_MAILPIT_PORT: mailpitPort,
  MYSKILLS_E2E_MAILPIT_URL: `http://127.0.0.1:${mailpitPort}`,
  MYSKILLS_E2E_MINIO_ROOT_PASSWORD: randomCredential(24),
  MYSKILLS_E2E_MINIO_ROOT_USER: `e2e${randomBytes(6).toString("hex")}`,
  MYSKILLS_E2E_OWNER_EMAIL: "beta2-owner@example.test",
  MYSKILLS_E2E_OWNER_PASSWORD: randomCredential(24),
  MYSKILLS_E2E_POSTGRES_PASSWORD: randomCredential(24),
  MYSKILLS_E2E_WEB_PORT: webPort,
};

let teardownStarted = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void teardown().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

try {
  await run("docker", [...composeArgs, "config", "--quiet"]);
  await run("docker", [...composeArgs, "up", "--build", "--detach", "--wait", "--wait-timeout", "300"]);
  await run("npm", ["run", "build", "-w", "@myskills-app/core", "-w", "@myskills-app/skill-package", "-w", "@jarel/myskills"]);
  const owner = await prepareOwnerMfa();
  environment.MYSKILLS_E2E_OWNER_RECOVERY_CODES = JSON.stringify(owner.recoveryCodes);
  environment.MYSKILLS_ACCEPTANCE_OWNER_TOKEN = owner.sessionToken;
  await run(resolve(root, "node_modules/.bin/playwright"), [
    "test",
    "--config",
    resolve(root, "apps/web/playwright.fullstack.config.ts"),
  ]);
} catch (error) {
  await run("docker", [...composeArgs, "ps"], { allowFailure: true });
  await run("docker", [...composeArgs, "logs", "--no-color", "--tail", "200"], { allowFailure: true });
  throw error;
} finally {
  await teardown();
}

async function teardown() {
  if (teardownStarted) {
    return;
  }
  teardownStarted = true;
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
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0 || options.allowFailure) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}
