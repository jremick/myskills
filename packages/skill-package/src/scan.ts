export interface ScanFinding {
  category: "secret" | "unsafe-command" | "install-hook" | "package-structure" | "prompt-injection" | "exfiltration";
  severity: "warning" | "blocking";
  message: string;
  path?: string;
}

// Every package accepted by the 1 MiB UTF-8 package limit fits this ceiling.
// Also bound direct callers without truncating text or skipping long lines.
export const MAX_SCAN_TEXT_LENGTH = 1024 * 1024;

const secretPatterns = [
  /\bATATT[0-9A-Za-z_-]{20,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z_]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{32,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
];

const unsafeCommandPatterns = [
  /\brm\s+-rf\s+(?:\/|\$HOME|~)/,
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
];

export function scanTextForPackageRisks(text: string): ScanFinding[] {
  if (text.length > MAX_SCAN_TEXT_LENGTH) {
    return [{
      category: "package-structure",
      severity: "blocking",
      message: `Package text exceeds scanner limit of ${MAX_SCAN_TEXT_LENGTH} UTF-16 code units.`,
    }];
  }

  const findings: ScanFinding[] = [];
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    findings.push({
      category: "secret",
      severity: "blocking",
      message: "Potential credential or private key detected.",
    });
  }
  if (unsafeCommandPatterns.some((pattern) => pattern.test(text))
    || hasDownloadShellPipe(text) || hasDecodedShellPipe(text)) {
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
  if (exfiltrationPatterns.some((pattern) => pattern.test(text)) || hasUrlExfiltration(text)) {
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

function hasDownloadShellPipe(text: string): boolean {
  // Visit each command, line break and pipe once instead of retrying .+ from
  // every command. Keep the original case sensitivity and .+ line boundaries.
  const tokens = /\b(?:curl|wget)\b|[\n\r\u2028\u2029]|\|/g;
  const shell = /\s*(?:sh|bash)\b/y;
  let commandEnd = -1;
  for (const token of text.matchAll(tokens)) {
    if (token[0] === "curl" || token[0] === "wget") {
      if (commandEnd < 0) commandEnd = token.index + token[0].length;
    } else if (token[0] === "|") {
      shell.lastIndex = token.index + 1;
      if (commandEnd >= 0 && token.index > commandEnd && shell.test(text)) return true;
    } else {
      commandEnd = -1;
    }
  }
  return false;
}

function hasDecodedShellPipe(text: string): boolean {
  // Decode options and separators are disjoint tokens. enc\s+-d deliberately
  // remains one token: the previous rule allowed its whitespace to span lines.
  const tokens = /\b(?:base64|openssl)\b|enc\s+-d\b|-d(?:ecode)?\b|[\n|;]/gi;
  const shell = /\s*(?:sh|bash|zsh)\b/iy;
  let decoderSeen = false;
  let decodeSeen = false;
  for (const token of text.matchAll(tokens)) {
    const value = token[0].toLowerCase();
    if (value === "base64" || value === "openssl") {
      decoderSeen = true;
    } else if (value === "\n" || value === "|" || value === ";") {
      shell.lastIndex = token.index + 1;
      if (value === "|" && decodeSeen && shell.test(text)) return true;
      decoderSeen = false;
      decodeSeen = false;
    } else if (value.includes("\n")) {
      // Only the option itself may bridge a newline, once per decoder. Earlier
      // options cannot carry a match through another line-spanning option.
      decodeSeen = decoderSeen;
      decoderSeen = false;
    } else if (decoderSeen) {
      decodeSeen = true;
    }
  }
  return false;
}

function hasUrlExfiltration(text: string): boolean {
  // Four forward-only cursors preserve the 120/160-character windows, including
  // credentials inside a URL. Never rescan a URL body for each command or scheme.
  const commands = /\b(?:curl|wget|fetch)\b/gi;
  const delimiters = /[\s"'`]+/g;
  const credentials = /\b(?:token|secret|password|credential|api[-_ ]?key|private[-_ ]?key|env(?:ironment)?\s+var)\b/gi;
  let command = commands.exec(text);
  let delimiter = delimiters.exec(text);
  let credential = credentials.exec(text);
  let commandEnd = -1;

  for (const scheme of text.matchAll(/https?:\/\//gi)) {
    while (command && command.index + command[0].length <= scheme.index) {
      commandEnd = command.index + command[0].length;
      command = commands.exec(text);
    }
    if (commandEnd < 0 || scheme.index - commandEnd > 120) continue;

    const bodyStart = scheme.index + scheme[0].length;
    while (delimiter && delimiter.index < bodyStart) delimiter = delimiters.exec(text);
    const bodyEnd = delimiter?.index ?? text.length;
    if (bodyEnd <= bodyStart) continue;

    // The URL must consume at least one character before the credential starts.
    while (credential && credential.index <= bodyStart) credential = credentials.exec(text);
    if (credential && credential.index <= bodyEnd + 160) return true;
  }
  return false;
}

export function hasBlockingFindings(findings: ScanFinding[]): boolean {
  return findings.some((finding) => finding.severity === "blocking");
}
