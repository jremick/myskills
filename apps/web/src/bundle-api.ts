import type {
  BundleInput,
  BundleMembersPage,
  BundleMembership,
  BundlePageInput,
  BundleSourceSelection,
  BundleSummary,
  LibraryEntry,
  RegistryCatalog,
  RegistryView,
} from "@myskills-app/core";
import { requestJson } from "./api.js";
const id = encodeURIComponent;
const query = (input: BundlePageInput & { view?: RegistryView }) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input))
    if (value !== undefined) params.set(key, String(value));
  return params.size ? `?${params}` : "";
};
export function createBundleClient(
  root: string,
  fetchImpl: typeof fetch,
  token?: string,
) {
  const get = <T>(path: string) =>
    requestJson<T>(fetchImpl, `${root}/v1${path}`, { token });
  const send = <T>(path: string, method: "POST" | "PATCH", body: unknown) =>
    requestJson<T>(fetchImpl, `${root}/v1${path}`, { token, method, body });
  return {
    catalog: (input: BundlePageInput & { view?: RegistryView } = {}) =>
      get<RegistryCatalog>(`/registry/catalog${query(input)}`),
    get: (bundleId: string) =>
      get<{ bundle: BundleSummary }>(`/bundles/${id(bundleId)}`),
    members: (bundleId: string, input: BundlePageInput = {}) =>
      get<BundleMembersPage>(`/bundles/${id(bundleId)}/members${query(input)}`),
    memberships: (slug: string) =>
      get<{ bundles: BundleMembership[] }>(`/skills/${id(slug)}/bundles`),
    create: (input: BundleInput) =>
      send<{ bundle: BundleSummary }>("/bundles", "POST", input),
    update: (
      bundleId: string,
      input: BundleInput & { expectedRevision: number },
    ) =>
      send<{ bundle: BundleSummary }>(
        `/bundles/${id(bundleId)}`,
        "PATCH",
        input,
      ),
    save: (
      bundleId: string,
      input: { libraryId: string; expectedRevision: number },
    ) =>
      send<{ entry: LibraryEntry; replayed: boolean }>(
        `/bundles/${id(bundleId)}/library-references`,
        "POST",
        input,
      ),
    sources: () => get<{ sources: BundleSourceSelection[] }>("/bundle-sources"),
  };
}
export type BundleClient = ReturnType<typeof createBundleClient>;
