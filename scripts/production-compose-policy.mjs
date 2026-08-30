function serviceBlock(composeText, serviceName) {
  const marker = new RegExp(`^[ ]{2}${escapeRegExp(serviceName)}:\\s*$`, "m");
  const match = marker.exec(composeText);
  if (!match) return null;

  const start = match.index + match[0].length;
  const remainder = composeText.slice(start);
  const nextService = /^[ ]{2}[A-Za-z0-9_-]+:\s*$/m.exec(remainder);
  return remainder.slice(0, nextService?.index ?? remainder.length);
}

function envValue(envTemplateText, key) {
  const prefix = `${key}=`;
  const line = envTemplateText
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith(prefix));
  if (!line) return null;
  return line.trimStart().slice(prefix.length).trim().replace(/^(["'])(.*)\1$/, "$2");
}

export function validateProductionComposePolicy(composeText, envTemplateText) {
  const errors = [];
  const api = serviceBlock(composeText, "api");
  const web = serviceBlock(composeText, "web");
  const trustProxy = envValue(envTemplateText, "TRUST_PROXY");

  if (!api) {
    errors.push("Production Compose must define the api service.");
    return errors;
  }
  if (!web) {
    errors.push("Production Compose must define the web service.");
    return errors;
  }

  const apiPublishesHostPorts = /^[ ]{4}ports:\s*$/m.test(api);
  if (apiPublishesHostPorts) {
    errors.push("Production Compose keeps the API private; route API traffic through the web proxy instead of publishing an API host port.");
  }

  if (!/^[ ]{4}expose:\s*$[\s\S]*?^[ ]{6}- ["']?3001["']?\s*$/m.test(api)) {
    errors.push("Production Compose must expose API port 3001 only to the private Compose network.");
  }
  if (!api.includes("TRUST_PROXY: ${TRUST_PROXY:?set TRUST_PROXY}")) {
    errors.push("Production Compose must require the explicit address-aware TRUST_PROXY setting.");
  }
  if (!trustProxy || /^[1-9]\d*$/.test(trustProxy)) {
    errors.push("Production Compose must use an address-aware TRUST_PROXY value.");
  }
  if (!web.includes("API_PROXY_TARGET: ${API_PROXY_TARGET:-http://api:3001}")) {
    errors.push("Production Compose web must proxy /api to the private api service.");
  }
  if (!/^[ ]{4}ports:\s*$/m.test(web)) {
    errors.push("Production Compose web must remain the published browser/API ingress.");
  }

  return errors;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
