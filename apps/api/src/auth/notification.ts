import nodemailer, { type Transporter } from "nodemailer";
import type { AuthActionNotification, AuthNotificationSink } from "./service.js";

type AuthNotificationPurpose = "email_verification" | "password_reset";
type AuthNotificationMode = "console" | "smtp" | "disabled";

export interface AuthNotificationLogger {
  info(message: string): void;
}

export interface SmtpAuthNotificationOptions {
  appBaseUrl: string;
  from: string;
  transporter: Pick<Transporter, "sendMail">;
}

export class ConsoleAuthNotificationSink implements AuthNotificationSink {
  constructor(
    private readonly options: {
      appBaseUrl: string;
      logger: AuthNotificationLogger;
    },
  ) {}

  sendEmailVerification(input: AuthActionNotification): void {
    this.log("email_verification", input);
  }

  sendPasswordReset(input: AuthActionNotification): void {
    this.log("password_reset", input);
  }

  private log(purpose: AuthNotificationPurpose, input: AuthActionNotification): void {
    const url = authActionUrl(this.options.appBaseUrl, purpose, input.token);
    this.options.logger.info(`[auth-notification] ${purpose} for ${input.email}: ${url} expires=${input.expiresAt.toISOString()}`);
  }
}

export class SmtpAuthNotificationSink implements AuthNotificationSink {
  constructor(private readonly options: SmtpAuthNotificationOptions) {}

  async sendEmailVerification(input: AuthActionNotification): Promise<void> {
    await this.send("email_verification", input);
  }

  async sendPasswordReset(input: AuthActionNotification): Promise<void> {
    await this.send("password_reset", input);
  }

  private async send(purpose: AuthNotificationPurpose, input: AuthActionNotification): Promise<void> {
    const message = authActionMessage(this.options.appBaseUrl, purpose, input);
    await this.options.transporter.sendMail({
      from: this.options.from,
      to: input.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

export function createAuthNotificationSinkFromEnv(
  env: NodeJS.ProcessEnv,
  logger: AuthNotificationLogger = console,
): AuthNotificationSink | undefined {
  const production = env.NODE_ENV === "production";
  const mode = normalizeMode(env.AUTH_NOTIFICATION_MODE ?? (production ? "smtp" : "console"));

  if (mode === "disabled") {
    if (production) {
      throw new Error("AUTH_NOTIFICATION_MODE=disabled is not allowed in production.");
    }
    return undefined;
  }

  const appBaseUrl = requiredAppBaseUrl(env.APP_BASE_URL, production);
  if (mode === "console") {
    if (production) {
      throw new Error("AUTH_NOTIFICATION_MODE=console is not allowed in production.");
    }
    return new ConsoleAuthNotificationSink({ appBaseUrl, logger });
  }

  const secure = optionalBoolean(env.SMTP_SECURE);
  const port = optionalPort(env.SMTP_PORT, secure);
  const transporter = nodemailer.createTransport({
    host: requiredString(env.SMTP_HOST, "SMTP_HOST"),
    port,
    secure: secure ?? port === 465,
    requireTLS: optionalBoolean(env.SMTP_REQUIRE_TLS) ?? port !== 465,
    tls: {
      rejectUnauthorized: tlsRejectUnauthorized(env.SMTP_TLS_REJECT_UNAUTHORIZED, production),
    },
    auth: optionalSmtpAuth(env.SMTP_USER, env.SMTP_PASSWORD),
  });

  return new SmtpAuthNotificationSink({
    appBaseUrl,
    from: requiredEmailHeader(env.SMTP_FROM, "SMTP_FROM"),
    transporter,
  });
}

export function authActionUrl(appBaseUrl: string, purpose: AuthNotificationPurpose, token: string): string {
  const base = new URL(normalizeBaseUrl(appBaseUrl));
  base.pathname = purpose === "email_verification" ? "/auth/verify-email" : "/auth/reset-password";
  base.search = "";
  base.hash = "";
  base.hash = `token=${encodeURIComponent(token)}`;
  return base.toString();
}

function authActionMessage(
  appBaseUrl: string,
  purpose: AuthNotificationPurpose,
  input: AuthActionNotification,
): { subject: string; text: string; html: string } {
  const url = authActionUrl(appBaseUrl, purpose, input.token);
  const expiresAt = input.expiresAt.toISOString();
  const action = purpose === "email_verification" ? "verify your email address" : "reset your password";
  const subject = purpose === "email_verification"
    ? "Verify your AI Skills Share email"
    : "Reset your AI Skills Share password";
  const escapedUrl = escapeHtml(url);
  const escapedAction = escapeHtml(action);
  return {
    subject,
    text: [
      `Use this link to ${action}:`,
      "",
      url,
      "",
      `This link expires at ${expiresAt}.`,
      "If you did not request this, you can ignore this email.",
    ].join("\n"),
    html: [
      `<p>Use this link to ${escapedAction}:</p>`,
      `<p><a href="${escapedUrl}">${escapedUrl}</a></p>`,
      `<p>This link expires at ${escapeHtml(expiresAt)}.</p>`,
      "<p>If you did not request this, you can ignore this email.</p>",
    ].join(""),
  };
}

function normalizeMode(mode: string): AuthNotificationMode {
  if (mode === "console" || mode === "smtp" || mode === "disabled") {
    return mode;
  }
  throw new Error("AUTH_NOTIFICATION_MODE must be console, smtp, or disabled.");
}

function requiredAppBaseUrl(value: string | undefined, production: boolean): string {
  const normalized = normalizeBaseUrl(requiredString(value, "APP_BASE_URL"));
  const url = new URL(normalized);
  if (production && url.protocol !== "https:") {
    throw new Error("APP_BASE_URL must use https in production.");
  }
  return normalized;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("APP_BASE_URL is required.");
  }
  const url = new URL(trimmed);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function requiredString(value: string | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function requiredEmailHeader(value: string | undefined, name: string): string {
  const trimmed = requiredString(value, name);
  if (/[\r\n]/.test(trimmed)) {
    throw new Error(`${name} cannot contain line breaks.`);
  }
  if (!trimmed.includes("@")) {
    throw new Error(`${name} must contain an email address.`);
  }
  return trimmed;
}

function optionalPort(value: string | undefined, secure: boolean | undefined): number {
  if (value === undefined || !value.trim()) {
    return secure ? 465 : 587;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== value.trim()) {
    throw new Error("SMTP_PORT must be an integer from 1 to 65535.");
  }
  return parsed;
}

function optionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || !value.trim()) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error("Boolean environment values must be true or false.");
}

function optionalSmtpAuth(user: string | undefined, password: string | undefined): { user: string; pass: string } | undefined {
  const hasUser = typeof user === "string" && user.trim() !== "";
  const hasPassword = typeof password === "string" && password.trim() !== "";
  if (!hasUser && !hasPassword) {
    return undefined;
  }
  if (!hasUser || !hasPassword) {
    throw new Error("SMTP_USER and SMTP_PASSWORD must be provided together.");
  }
  return {
    user: user.trim(),
    pass: password,
  };
}

function tlsRejectUnauthorized(value: string | undefined, production: boolean): boolean {
  const parsed = optionalBoolean(value);
  if (production && parsed === false) {
    throw new Error("SMTP_TLS_REJECT_UNAUTHORIZED=false is not allowed in production.");
  }
  return parsed ?? true;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
