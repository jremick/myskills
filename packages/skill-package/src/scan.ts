export interface ScanFinding {
  category: "secret" | "unsafe-command" | "install-hook" | "package-structure";
  severity: "warning" | "blocking";
  message: string;
  path?: string;
}

const secretPatterns = [
  /\bATATT[0-9A-Za-z_-]{20,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z_]{30,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
];

const unsafeCommandPatterns = [
  /\brm\s+-rf\s+(?:\/|\$HOME|~)/,
  /\bcurl\b.+\|\s*(?:sh|bash)\b/,
  /\bwget\b.+\|\s*(?:sh|bash)\b/,
];

export function scanTextForPackageRisks(text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    findings.push({
      category: "secret",
      severity: "blocking",
      message: "Potential credential or private key detected.",
    });
  }
  if (unsafeCommandPatterns.some((pattern) => pattern.test(text))) {
    findings.push({
      category: "unsafe-command",
      severity: "blocking",
      message: "Potentially destructive or remote-shell command detected.",
    });
  }
  if (/"(?:preinstall|install|postinstall)"\s*:/.test(text)) {
    findings.push({
      category: "install-hook",
      severity: "warning",
      message: "Dependency install hook requires maintainer review.",
    });
  }
  return findings;
}

export function hasBlockingFindings(findings: ScanFinding[]): boolean {
  return findings.some((finding) => finding.severity === "blocking");
}
