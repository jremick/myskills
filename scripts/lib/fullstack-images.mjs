// Compose v2 names these build-only images <project>-<service>. Capture only
// this invocation's successful builds, then use immutable IDs for every stack.
const builtServices = ["minio", "minio-init", "api", "mcp", "web"];

export async function buildFullstackImages({ run, composeArgs, project }) {
  await run("docker", [...composeArgs, "build"]);
  const images = {};
  for (const service of builtServices) {
    const id = (await run("docker", ["image", "inspect", "--format", "{{.Id}}", `${project}-${service}`], { capture: true })).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error(`Full-stack ${service} built image identity is invalid.`);
    images[service] = id;
  }
  return images;
}

export async function requireFullstackImages({ run, images }) {
  for (const [service, id] of Object.entries(images)) {
    const actual = (await run("docker", ["image", "inspect", "--format", "{{.Id}}", id], { capture: true })).trim();
    if (actual !== id) throw new Error(`Full-stack ${service} frozen image is unavailable.`);
  }
}
