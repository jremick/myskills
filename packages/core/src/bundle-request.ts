/** Fixed API routing shared by CLI and MCP. No arbitrary URL or installation action. */
export type BundleAction =
  | "list"
  | "show"
  | "members"
  | "memberships"
  | "sources"
  | "create"
  | "edit"
  | "save";
export interface BundleRequest {
  method: "GET" | "POST" | "PATCH";
  pathname: string;
  payload?: Record<string, unknown>;
}
export function bundleRequest(
  action: string,
  reference: string | undefined,
  options: Record<string, unknown> = {},
  payload?: Record<string, unknown>,
): BundleRequest {
  const routes: Record<
    BundleAction,
    { method: BundleRequest["method"]; path: string; body?: boolean }
  > = {
    list: { method: "GET", path: "/registry/catalog" },
    show: { method: "GET", path: "/bundles/:id" },
    members: { method: "GET", path: "/bundles/:id/members" },
    memberships: { method: "GET", path: "/skills/:id/bundles" },
    sources: { method: "GET", path: "/bundle-sources" },
    create: { method: "POST", path: "/bundles", body: true },
    edit: { method: "PATCH", path: "/bundles/:id", body: true },
    save: {
      method: "POST",
      path: "/bundles/:id/library-references",
      body: true,
    },
  };
  const route = Object.hasOwn(routes, action)
    ? routes[action as BundleAction]
    : undefined;
  if (!route)
    throw new Error(
      "Bundle action must be list, show, members, memberships, sources, create, edit or save.",
    );
  if (
    route.path.includes(":id") &&
    (!reference || reference.length > 128 || !/^[A-Za-z0-9-]+$/.test(reference))
  )
    throw new Error("Provide a valid bundle ID or skill slug.");
  if (Boolean(route.body) !== Boolean(payload))
    throw new Error(
      route.body
        ? "Provide a reviewed JSON request body."
        : "This action does not accept a request body.",
    );
  const params = new URLSearchParams();
  for (const key of ["query", "view", "limit", "cursor"]) {
    const value = options[key];
    if (value === undefined) continue;
    if (
      !["list", "members"].includes(action) ||
      (key === "view" && action !== "list")
    )
      throw new Error(`--${key} is not supported by this action.`);
    if (typeof value !== "string" && typeof value !== "number")
      throw new Error(`--${key} requires a value.`);
    const text = String(value);
    if (key === "limit" && (!/^\d+$/.test(text) || +text < 1 || +text > 100))
      throw new Error("Limit must be 1–100.");
    if (key === "view" && !["grouped", "list", "outline"].includes(text))
      throw new Error("View must be grouped, list or outline.");
    if (text.length > (key === "cursor" ? 2048 : 200))
      throw new Error("Query option is too long.");
    params.set(key, text);
  }
  return {
    method: route.method,
    pathname: `/v1${route.path.replace(":id", encodeURIComponent(reference ?? ""))}${params.size ? `?${params}` : ""}`,
    ...(payload ? { payload } : {}),
  };
}
