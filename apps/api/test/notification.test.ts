import test from "node:test";
import assert from "node:assert/strict";
import {
  authActionUrl,
  ConsoleAuthNotificationSink,
  createAuthNotificationSinkFromEnv,
  ResendAuthNotificationSink,
  SmtpAuthNotificationSink,
} from "../src/auth/notification.js";
import type { AuthActionNotification } from "../src/auth/service.js";

test("auth action URLs are absolute and encode tokens", () => {
  assert.equal(
    authActionUrl("https://skills.example", "email_verification", "verify-token_123"),
    "https://skills.example/auth/verify-email#token=verify-token_123",
  );
  assert.equal(
    authActionUrl("https://skills.example/", "password_reset", "reset token"),
    "https://skills.example/auth/reset-password#token=reset%20token",
  );
  assert.equal(
    authActionUrl("https://skills.example/", "email_change", "change-token"),
    "https://skills.example/auth/change-email#token=change-token",
  );
});

test("SMTP auth notification sink formats verification, reset, and email-change messages", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const sink = new SmtpAuthNotificationSink({
    appBaseUrl: "https://skills.example",
    from: "MySkills <noreply@example.test>",
    transporter: {
      async sendMail(message: Record<string, unknown>) {
        sent.push(message);
        return { messageId: "test-message" };
      },
    },
  });

  await sink.sendEmailVerification(notification("verify-token"));
  await sink.sendPasswordReset(notification("reset-token"));
  await sink.sendEmailChangeVerification(notification("change-token", "new@example.com"));

  assert.equal(sent.length, 3);
  assert.equal(sent[0].from, "MySkills <noreply@example.test>");
  assert.equal(sent[0].to, "user@example.com");
  assert.equal(sent[0].subject, "Verify your MySkills email");
  assert.match(String(sent[0].text), /https:\/\/skills\.example\/auth\/verify-email#token=verify-token/);
  assert.match(String(sent[0].html), /href="https:\/\/skills\.example\/auth\/verify-email#token=verify-token"/);
  assert.equal(sent[1].subject, "Reset your MySkills password");
  assert.match(String(sent[1].text), /https:\/\/skills\.example\/auth\/reset-password#token=reset-token/);
  assert.equal(sent[2].to, "new@example.com");
  assert.equal(sent[2].subject, "Confirm your new MySkills email");
  assert.match(String(sent[2].text), /https:\/\/skills\.example\/auth\/change-email#token=change-token/);

  const serialized = JSON.stringify(sent);
  assert.equal(serialized.includes("tokenHash"), false);
  assert.equal(serialized.includes("passwordHash"), false);
});

test("Resend auth notification sink formats verification, reset, and email-change messages", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const sink = new ResendAuthNotificationSink({
    appBaseUrl: "https://skills.example",
    from: "MySkills <noreply@example.test>",
    client: {
      async send(message) {
        sent.push(message);
        return {
          data: { id: `email-${sent.length}` },
          error: null,
          headers: null,
        };
      },
    },
  });

  await sink.sendEmailVerification(notification("verify-token"));
  await sink.sendPasswordReset(notification("reset-token"));
  await sink.sendEmailChangeVerification(notification("change-token", "new@example.com"));

  assert.equal(sent.length, 3);
  assert.equal(sent[0].from, "MySkills <noreply@example.test>");
  assert.equal(sent[0].to, "user@example.com");
  assert.equal(sent[0].subject, "Verify your MySkills email");
  assert.match(String(sent[0].text), /https:\/\/skills\.example\/auth\/verify-email#token=verify-token/);
  assert.match(String(sent[0].html), /href="https:\/\/skills\.example\/auth\/verify-email#token=verify-token"/);
  assert.equal(sent[1].subject, "Reset your MySkills password");
  assert.match(String(sent[1].text), /https:\/\/skills\.example\/auth\/reset-password#token=reset-token/);
  assert.equal(sent[2].to, "new@example.com");
  assert.equal(sent[2].subject, "Confirm your new MySkills email");
  assert.match(String(sent[2].text), /https:\/\/skills\.example\/auth\/change-email#token=change-token/);

  const serialized = JSON.stringify(sent);
  assert.equal(serialized.includes("tokenHash"), false);
  assert.equal(serialized.includes("passwordHash"), false);
});

test("Resend auth notification sink reports provider errors", async () => {
  const sink = new ResendAuthNotificationSink({
    appBaseUrl: "https://skills.example",
    from: "MySkills <noreply@example.test>",
    client: {
      async send() {
        return {
          data: null,
          error: {
            name: "validation_error",
            message: "Invalid from address",
            statusCode: 422,
          },
          headers: null,
        };
      },
    },
  });

  await assert.rejects(
    () => sink.sendPasswordReset(notification("reset-token")),
    /Resend email delivery failed: validation_error Invalid from address/,
  );
});

test("console auth notification sink logs development links only through the injected logger", () => {
  const messages: string[] = [];
  const sink = new ConsoleAuthNotificationSink({
    appBaseUrl: "http://localhost:3000",
    logger: {
      info(message) {
        messages.push(message);
      },
    },
  });

  sink.sendEmailVerification(notification("dev-token"));

  assert.equal(messages.length, 1);
  assert.match(messages[0], /email_verification for user@example\.com/);
  assert.match(messages[0], /http:\/\/localhost:3000\/auth\/verify-email#token=dev-token/);
});

test("auth notification env config defaults to console in development", () => {
  const messages: string[] = [];
  const sink = createAuthNotificationSinkFromEnv(
    {
      NODE_ENV: "development",
      APP_BASE_URL: "http://localhost:3000",
    },
    {
      info(message) {
        messages.push(message);
      },
    },
  );

  assert.ok(sink);
  sink.sendPasswordReset(notification("dev-reset-token"));
  assert.match(messages[0], /http:\/\/localhost:3000\/auth\/reset-password#token=dev-reset-token/);
});

test("auth notification env config rejects unsafe production modes", () => {
  assert.throws(
    () => createAuthNotificationSinkFromEnv({ NODE_ENV: "production", AUTH_NOTIFICATION_MODE: "console", APP_BASE_URL: "https://skills.example" }),
    /console is not allowed in production/,
  );
  assert.throws(
    () => createAuthNotificationSinkFromEnv({ NODE_ENV: "production", AUTH_NOTIFICATION_MODE: "disabled" }),
    /disabled is not allowed in production/,
  );
  assert.throws(
    () => createAuthNotificationSinkFromEnv({
      NODE_ENV: "production",
      APP_BASE_URL: "https://skills.example",
    }),
    /SMTP_HOST is required/,
  );
  assert.throws(
    () => createAuthNotificationSinkFromEnv({
      NODE_ENV: "production",
      AUTH_NOTIFICATION_MODE: "smtp",
      APP_BASE_URL: "http://skills.example",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "noreply@example.com",
    }),
    /APP_BASE_URL must use https in production/,
  );
  assert.throws(
    () => createAuthNotificationSinkFromEnv({
      NODE_ENV: "production",
      AUTH_NOTIFICATION_MODE: "smtp",
      APP_BASE_URL: "https://skills.example",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "noreply@example.com",
      SMTP_TLS_REJECT_UNAUTHORIZED: "false",
    }),
    /SMTP_TLS_REJECT_UNAUTHORIZED=false is not allowed in production/,
  );
  assert.throws(
    () => createAuthNotificationSinkFromEnv({
      NODE_ENV: "production",
      AUTH_NOTIFICATION_MODE: "resend",
      APP_BASE_URL: "https://skills.example",
      RESEND_FROM: "MySkills <noreply@example.com>",
    }),
    /RESEND_API_KEY is required/,
  );
  assert.throws(
    () => createAuthNotificationSinkFromEnv({
      NODE_ENV: "production",
      AUTH_NOTIFICATION_MODE: "resend",
      APP_BASE_URL: "https://skills.example",
      RESEND_API_KEY: "re_test",
      RESEND_FROM: "MySkills",
    }),
    /RESEND_FROM must contain an email address/,
  );
  assert.throws(
    () => createAuthNotificationSinkFromEnv({
      AUTH_NOTIFICATION_MODE: "smtp",
      APP_BASE_URL: "http://localhost:3000",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "bad\r\nBcc: attacker@example.com",
    }),
    /SMTP_FROM cannot contain line breaks/,
  );
  assert.throws(
    () => createAuthNotificationSinkFromEnv({
      AUTH_NOTIFICATION_MODE: "smtp",
      APP_BASE_URL: "http://localhost:3000",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "MySkills",
    }),
    /SMTP_FROM must contain an email address/,
  );
});

test("auth notification env config supports Resend in production", () => {
  const sink = createAuthNotificationSinkFromEnv({
    NODE_ENV: "production",
    AUTH_NOTIFICATION_MODE: "resend",
    APP_BASE_URL: "https://skills.example",
    RESEND_API_KEY: "re_test",
    RESEND_FROM: "MySkills <noreply@example.com>",
  });

  assert.ok(sink);
  assert.equal(sink.constructor.name, "ResendAuthNotificationSink");
});

test("auth notification env config validates SMTP fields", () => {
  assert.throws(
    () => createAuthNotificationSinkFromEnv({
      AUTH_NOTIFICATION_MODE: "smtp",
      APP_BASE_URL: "http://localhost:3000",
      SMTP_FROM: "noreply@example.com",
    }),
    /SMTP_HOST is required/,
  );
  assert.throws(
    () => createAuthNotificationSinkFromEnv({
      AUTH_NOTIFICATION_MODE: "smtp",
      APP_BASE_URL: "http://localhost:3000",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "noreply@example.com",
      SMTP_PORT: "abc",
    }),
    /SMTP_PORT must be an integer/,
  );
  assert.throws(
    () => createAuthNotificationSinkFromEnv({
      AUTH_NOTIFICATION_MODE: "smtp",
      APP_BASE_URL: "http://localhost:3000",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "noreply@example.com",
      SMTP_SECURE: "yes",
    }),
    /Boolean environment values must be true or false/,
  );
  assert.throws(
    () => createAuthNotificationSinkFromEnv({
      AUTH_NOTIFICATION_MODE: "smtp",
      APP_BASE_URL: "http://localhost:3000",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "noreply@example.com",
      SMTP_USER: "user",
    }),
    /SMTP_USER and SMTP_PASSWORD must be provided together/,
  );
});

function notification(token: string, email = "user@example.com"): AuthActionNotification {
  return {
    user: {
      id: "user-1",
      email: "user@example.com",
      name: "User",
      status: "active",
      emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      roles: ["user"],
    },
    email,
    token,
    expiresAt: new Date("2026-01-01T01:00:00.000Z"),
  };
}
