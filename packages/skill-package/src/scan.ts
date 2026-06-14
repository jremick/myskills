export interface ScanFinding {
  category: "secret" | "unsafe-command" | "install-hook" | "package-structure" | "prompt-injection" | "exfiltration";
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
  /\b(?:base64|openssl)\b[^\n|;]*(?:-d|-decode|enc\s+-d)\b[^\n|;]*\|\s*(?:sh|bash|zsh)\b/i,
  /\b(?:python|python3|perl|ruby|node)\b\s+-e\s+["'`][\s\S]{0,500}\b(?:child_process|exec|spawn|system|curl|wget|socket)\b/i,
];

const promptInjectionPatterns = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier|system|developer)\s+instructions\b/i,
  /\b(?:override|bypass|disable)\s+(?:the\s+)?(?:system|developer|safety|security|policy)\s+(?:instructions|rules|checks|guardrails)\b/i,
  /\breveal\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message|instructions)\b/i,
];

const exfiltrationPatterns = [
  /\b(?:exfiltrate|steal|leak|dump|upload|send|post)\b[\s\S]{0,160}\b(?:token|secret|password|credential|api[-_ ]?key|private[-_ ]?key|env(?:ironment)?\s+var)/i,
  /\b(?:token|secret|password|credential|api[-_ ]?key|private[-_ ]?key|env(?:ironment)?\s+var)[\s\S]{0,160}\b(?:exfiltrate|steal|leak|dump|upload|send|post)\b/i,
  /\b(?:curl|wget|fetch)\b[\s\S]{0,120}https?:\/\/[^\s"'`]+[\s\S]{0,160}\b(?:token|secret|password|credential|api[-_ ]?key|private[-_ ]?key|env(?:ironment)?\s+var)\b/i,
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
  if (promptInjectionPatterns.some((pattern) => pattern.test(text))) {
    findings.push({
      category: "prompt-injection",
      severity: "blocking",
      message: "Potential instruction-hijacking content detected.",
    });
  }
  if (exfiltrationPatterns.some((pattern) => pattern.test(text))) {
    findings.push({
      category: "exfiltration",
      severity: "blocking",
      message: "Potential credential or environment exfiltration instruction detected.",
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
