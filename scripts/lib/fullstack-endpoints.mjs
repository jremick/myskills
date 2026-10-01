/** Read only the exact Compose service's ownership and loopback port binding. */
export async function readFullstackEndpoint({ run, composeArgs, project, service, containerPort, requestedPort }) {
  const invalid = () => new Error(`Full-stack ${service} endpoint ownership or loopback binding is invalid.`);
  const id = (await run("docker", [...composeArgs, "ps", "--quiet", service], { capture: true })).trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw invalid();
  const format = `{"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"running":{{json .State.Running}},"ports":{{json (index .NetworkSettings.Ports "${containerPort}/tcp")}}}`;
  const body = await run("docker", ["inspect", "--type", "container", "--format", format, id], { capture: true });
  let row;
  try { row = JSON.parse(body); } catch { throw invalid(); }
  if (!row || row.project !== project || row.service !== service || row.running !== true || !Array.isArray(row.ports) || row.ports.length !== 1) throw invalid();
  const binding = row.ports[0];
  if (binding?.HostIp !== "127.0.0.1" || typeof binding.HostPort !== "string" || !/^[1-9]\d{0,4}$/.test(binding.HostPort) || Number(binding.HostPort) > 65535
    || requestedPort !== "0" && binding.HostPort !== requestedPort) throw invalid();
  return `http://127.0.0.1:${binding.HostPort}`;
}
