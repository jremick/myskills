export const repository = "https://github.com/jremick/myskills";
export const source = (path) => `${repository}/blob/main/${path}`;

// This release snapshot is evidence supplied by the release readback in DISC-SITE.
// Updating source does not publish a release. Link the release listing for freshness.
export const release = {
  tag: "v0.1.0-beta.17",
  publishedAt: "2026-09-29T00:21:04Z",
  url: `${repository}/releases/tag/v0.1.0-beta.17`,
};

export const surfaces = [
  { path: "/", label: "Home", title: "MySkills — compose and govern AI skill sets", description: "Compose versioned skill architectures, choose profiles and environments, and review lifecycle changes. Explore the public beta and its current delivery boundaries." },
  { path: "/setup/", label: "Setup", title: "Local setup — MySkills", description: "Start a local MySkills evaluation with the canonical setup guide, supported runtimes, and a clear path to self-hosting." },
  { path: "/docs/", label: "Docs", title: "Documentation — MySkills", description: "Canonical MySkills guides for setup, deployment, CLI, API, MCP, skill packages, security, and release operations." },
  { path: "/examples/", label: "Examples", title: "Public skill examples — MySkills", description: "Read the real public Release Notes Helper, App and Environment Reviewer, and Model Guidance Reviewer skill packages." },
  { path: "/downloads/", label: "Downloads", title: "Downloads and status — MySkills", description: "Find the verified GitHub prerelease, release artifacts, source tree version, and MySkills public beta limits." },
  { path: "/security/", label: "Security", title: "Security and reporting — MySkills", description: "Understand MySkills beta boundaries, package review, server authorization, and private vulnerability reporting." },
];

export const guides = [
  { group: "Use and integrate", title: "Architecture lifecycle", path: "docs/ARCH_LIFE_DELIVERY.md", text: "Composed skill sets, exact-revision reviews, target fences, and current rollout acceptance." },
  { group: "Start and operate", title: "Getting started", path: "docs/GETTING_STARTED.md", text: "Supported runtimes, local dependencies, first run, and example validation." },
  { group: "Start and operate", title: "Production deployment", path: "docs/DEPLOYMENT.md", text: "Production configuration, containers, and deployment preflight." },
  { group: "Start and operate", title: "Railway deployment", path: "docs/RAILWAY_DEPLOYMENT.md", text: "The maintained Railway deployment shape and verification path." },
  { group: "Use and integrate", title: "API, MCP, and CLI", path: "docs/API_MCP_CLI_PLAN.md", text: "Client surfaces, API authority, and delivery boundaries." },
  { group: "Use and integrate", title: "CLI guide", path: "apps/cli/README.md", text: "Authentication, authoring, install, update, and rollback commands." },
  { group: "Use and integrate", title: "MCP guide", path: "apps/mcp/README.md", text: "Stdio and HTTP adapters, scoped access, and client behavior." },
  { group: "Use and integrate", title: "Package validation", path: "packages/skill-package/README.md", text: "Manifest loading, package scanning, bundling, and install boundaries." },
  { group: "Use and integrate", title: "Capability parity", path: "docs/CAPABILITY_PARITY.md", text: "Surface coverage with actual verification evidence and open gaps." },
  { group: "Review and maintain", title: "Security model", path: "docs/SECURITY_MODEL.md", text: "Authorization, package safety, secrets, and explicit trust boundaries." },
  { group: "Review and maintain", title: "Release operations", path: "docs/OPERATIONAL_BETA_DELIVERY.md", text: "The accepted operational beta baseline and release evidence." },
  { group: "Review and maintain", title: "Roadmap", path: "docs/ROADMAP.md", text: "Current work, future capabilities, and their acceptance criteria." },
];
