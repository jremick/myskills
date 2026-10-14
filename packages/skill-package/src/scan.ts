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
  if (hasExfiltrationInstruction(text) || hasUnsafeCredentialTransmission(text)) {
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

interface SensitiveValue {
  // Intersection of service labels evidenced by every source. An empty set
  // means sensitive data with no provable service; undefined means no source.
  services: ReadonlySet<string> | undefined;
  wholeEnvironment: boolean;
  encoded: boolean;
}

function sensitiveValue(text: string, aliases: Map<string, SensitiveValue>): SensitiveValue {
  let services: ReadonlySet<string> | undefined;
  const include = (incoming: ReadonlySet<string>): void => {
    services = services === undefined ? incoming : new Set([...services].filter((service) => incoming.has(service)));
  };
  const executable = text.replace(/(["'])(?:process\.env|os\.environ)\1/g, "");
  let wholeEnvironment = /\bprocess\s*\.\s*env\b(?!\s*(?:\.\s*[A-Za-z_$]|\[))|\bos\s*\.\s*environ\b(?!\s*(?:\[|\.\s*get\b))|\$\(\s*(?:env|printenv)\s*(?:\)|\|)|`\s*(?:env|printenv)\s*(?:`|\|)/.test(executable);
  let encoded = /\b(?:base64|b64encode|btoa)\b/.test(text);
  for (const match of text.matchAll(/\bprocess\.env\.([A-Za-z_]\w*)|\b(?:process\.env|os\.environ)\[\s*["']([^"']+)["']|\bos\.(?:environ\.get|getenv)\(\s*["']([^"']+)["']|\$\{?([A-Za-z_]\w*)\b(?![.\[])/g)) {
    const name = match[1] ?? match[2] ?? match[3] ?? match[4]!;
    // Shell substitutions include ordinary arguments and destination variables.
    if (!match[4] || (!aliases.has(name) && /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|(?:API|PRIVATE|USER)_KEY)/i.test(name))) {
      include(new Set(name.toLowerCase().split("_").filter((part) => !/^(?:api|app|key|token|secret|password|credential|user|private|access|auth)$/.test(part))));
    }
  }
  for (const match of text.matchAll(/\b[A-Za-z_]\w*\b/g)) {
    const alias = aliases.get(match[0]);
    if (!alias) continue;
    if (alias.services !== undefined) include(alias.services);
    wholeEnvironment ||= alias.wholeEnvironment;
    encoded ||= alias.encoded;
  }
  return { services, wholeEnvironment, encoded };
}

function hasExfiltrationInstruction(text: string): boolean {
  // Security guidance and API descriptions are not data flows. Require an
  // explicit theft/dump instruction or a credential transfer to a destination.
  const instructions = /\b(?:exfiltrate|steal|leak|dump)\b[^\n.!?]{0,120}\b(?:tokens?|secrets?|passwords?|credentials?|api[-_ ]?keys?|private[-_ ]?keys?|env(?:ironment)?(?:\s+var\w*)?)\b|\b(?:send|post|upload)\s+(?:(?:any|all|the|your)\s+)?(?:[A-Za-z][\w-]*\s+)?(?:tokens?|secrets?|passwords?|credentials?|(?:app\s+)?tokens?|api[-_ ]?keys?|private[-_ ]?keys?|environment\s+variables?)\b[^\n.!?]{0,120}\bto\s+(?:https?:\/\/|(?:an?\s+)?(?:arbitrary|external|unrelated|remote)\s+(?:host|server|endpoint))/gi;
  for (const match of text.matchAll(instructions)) {
    const prefixWindow = text.slice(Math.max(0, match.index - 80), match.index);
    const prefix = prefixWindow.slice(prefixWindow.lastIndexOf("\n") + 1);
    if (/\b(?:do\s+not|don't|never|must\s+not|should\s+not|avoid|without)\b[^.!?;]*$/i.test(prefix)) continue;
    const instruction = text.slice(match.index, match.index + 1024).split("\n", 1)[0]!;
    const service = instruction.match(/\b([A-Za-z][\w-]*)\s+(?:API\s+key|app\s+token|token)\b/i)?.[1]?.toLowerCase();
    const destination = instruction.match(/https?:\/\/[^\s<>"'`]+/i)?.[0];
    if (/^(?:send|post|upload)\b/i.test(match[0]) && service && destination
      && serviceForUrl(destination) === service && /\bauthenticat(?:e|ion)\b/i.test(instruction)) continue;
    return true;
  }
  return false;
}

function requestEnd(text: string, start: number, shell: boolean): number {
  let quote = "";
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\") { index += 1; continue; }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (!shell && char === "(") depth += 1;
    if (!shell && char === ")" && --depth <= 0) return index + 1;
    if ((char === "\n" || char === ";") && depth <= 0) return index;
  }
  return text.length;
}

function withoutAuthenticationValues(request: string, shell: boolean): string {
  if (shell) {
    return request
      .replace(/(?:-H|--header)\s+(["'])(?:authorization|x-api-key|api-key):[^\n]*?\1/gi, "")
      .replace(/((?:--data(?:-urlencode)?|-d)\s+["'])(?:token|api_key)=[^&"']*/gi, "$1");
  }
  const fields = /(?:["'](?:authorization|x-api-key|api-key|token|api_key|access_token|key)["']|\bAuthorization)\s*:\s*/gi;
  const parts: string[] = [];
  let cursor = 0;
  for (let field = fields.exec(request); field; field = fields.exec(request)) {
    parts.push(request.slice(cursor, field.index));
    let depth = 0;
    let quote = "";
    let index = fields.lastIndex;
    for (; index < request.length; index += 1) {
      const char = request[index]!;
      if (char === "\\") { index += 1; continue; }
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'" || char === "`") quote = char;
      else if ("([{".includes(char)) depth += 1;
      else if (depth === 0 && ",)}]".includes(char)) break;
      else if (")]}".includes(char)) depth -= 1;
    }
    cursor = index;
    fields.lastIndex = index;
  }
  parts.push(request.slice(cursor));
  return parts.join("");
}

function isServiceAuthentication(request: string, value: SensitiveValue, endpoints: Map<string, string>, aliases: Map<string, SensitiveValue>, shell: boolean): boolean {
  if (value.wholeEnvironment || value.encoded || value.services === undefined) return false;
  // An auth header cannot make a separate credential-bearing body safe.
  const remaining = sensitiveValue(withoutAuthenticationValues(request, shell), aliases);
  if (remaining.services !== undefined || remaining.wholeEnvironment) return false;
  const urls = [...request.matchAll(/https?:\/\/[^\s"'`<>),]+/g)].map((match) => match[0]);
  const argument = shell
    ? request.match(/\$\{?([A-Z_]*(?:URL|HOST|ENDPOINT)[A-Z_]*)\}?/i)
    : request.match(/^[^(]*\(\s*([A-Za-z_]\w*)\s*[,)]/);
  if (argument) {
    const endpoint = endpoints.get(argument[1]!);
    if (!endpoint) return false;
    urls.unshift(endpoint);
  }
  if (urls.length === 0 || !/\b(?:authorization|x-api-key|api-key)\b|["'](?:token|api_key|access_token|key)["']\s*:|(?:--data(?:-urlencode)?|-d)\s+["'](?:token|api_key)=/i.test(request)) return false;
  for (const raw of urls) {
    const service = serviceForUrl(raw);
    if (!service) return false;
    // The service must be the registrable domain, not a matching subdomain of
    // an unrelated collector. Generic TOKEN/API_KEY alone conveys no ownership.
    if (!value.services.has(service)) return false;
  }
  return true;
}

function serviceForUrl(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || /[$%{}]/.test(url.hostname)) return undefined;
  const labels = url.hostname.toLowerCase().split(".");
  return /^(?:com|net|org|io|ai|dev|app|cloud)$/.test(labels.at(-1)!) ? labels.at(-2) : undefined;
}

function hasUnsafeCredentialTransmission(text: string): boolean {
  const aliases = new Map<string, SensitiveValue>();
  const endpoints = new Map<string, string>();
  const assignedEndpoints = new Set<string>();
  // One pass collects simple local aliases. This is a conservative text scanner,
  // not an evaluator: arbitrary function calls and computed URLs are not trusted.
  for (const assignment of text.matchAll(/(?:^|[\n;])\s*(?:(?:const|let|var|export)\s+)?([A-Za-z_]\w*)\s*=\s*([^\n;]+)/g)) {
    const name = assignment[1]!;
    const expression = assignment[2]!;
    const value = sensitiveValue(expression, aliases);
    if (value.services !== undefined || value.wholeEnvironment) aliases.set(name, value);
    const literal = expression.match(/^["'](https?:\/\/[^"']+)["']\s*$/);
    if (assignedEndpoints.has(name)) endpoints.delete(name);
    else if (literal) endpoints.set(name, literal[1]!);
    assignedEndpoints.add(name);
  }
  // Bare env/printenv commands dump the process environment even without a
  // network pipe. Do not confuse shebangs, env KEY=value command, or prose.
  if (/^[\t ]*(?:\$[\t ]+)?(?:printenv|env)(?:[\t ]+(?:--null|-0))?[\t ]*(?:$|[|>])/m.test(text)) return true;
  const sinks = /\b(?:curl|wget|fetch|requests\.(?:get|post|put|patch|request)|axios\.(?:get|post|put|patch)|urllib\.request\.(?:Request|urlopen)|console\.(?:log|dir|error)|process\.(?:stdout|stderr)\.write|print)\b/g;
  for (let sink = sinks.exec(text); sink; sink = sinks.exec(text)) {
    const shell = sink[0] === "curl" || sink[0] === "wget";
    const end = requestEnd(text, sink.index + sink[0].length, shell);
    const request = text.slice(sink.index, end);
    sinks.lastIndex = Math.max(end, sinks.lastIndex);
    const value = sensitiveValue(request, aliases);
    if (value.wholeEnvironment) return true;
    if (sink[0] === "print" || sink[0].startsWith("console.") || sink[0].startsWith("process.")) continue;
    if (value.services === undefined) continue;
    if (!isServiceAuthentication(request, value, endpoints, aliases, shell)) return true;
  }
  return false;
}

export function hasBlockingFindings(findings: ScanFinding[]): boolean {
  return findings.some((finding) => finding.severity === "blocking");
}
