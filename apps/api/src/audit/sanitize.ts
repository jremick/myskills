const SENSITIVE_KEY_PATTERN = /token|secret|password|cookie|private[-_ ]?key|code[-_ ]?hash|ciphertext|recovery[-_ ]?code|otpauth/i;
const SENSITIVE_VALUE_PATTERN = /token|secret|password|cookie|private[-_ ]?key|package content/i;
const MAX_AUDIT_STRING_LENGTH = 200;

export function sanitizeAuditDetails(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeAuditValue(value),
      ]),
  );
}

export function sanitizeAuditValue(input: unknown): unknown {
  if (typeof input === "string") {
    if (SENSITIVE_VALUE_PATTERN.test(input)) {
      return "[redacted]";
    }
    const redacted = input
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/ATATT[A-Za-z0-9_-]+/g, "[redacted-token]")
      .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[redacted-private-key]");
    const formulaSafe = /^[=+\-@]/.test(redacted) ? `'${redacted}` : redacted;
    return formulaSafe.length > MAX_AUDIT_STRING_LENGTH
      ? `${formulaSafe.slice(0, MAX_AUDIT_STRING_LENGTH)}...`
      : formulaSafe;
  }
  if (Array.isArray(input)) {
    return input.map(sanitizeAuditValue);
  }
  if (input && typeof input === "object") {
    return sanitizeAuditDetails(input as Record<string, unknown>);
  }
  return input;
}
