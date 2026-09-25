import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import type { FetchLike } from "../src/api-client.js";

export function nativeFixture(input: { slug?: string; instructions?: string; version?: string; extra?: Array<{ path: string; content: string }> } = {}) {
  const slug = input.slug ?? "native-test";
  const version = input.version ?? "1.0.0+build.4";
  const files = [
    { path: "skill.json", content: JSON.stringify({ name: slug, title: "Native test", summary: "Test native delivery", version, license: "MIT", platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }] }) },
    { path: "SKILL.md", content: input.instructions ?? "\uFEFF---\nname: author-label\ndescription: Read café notes\nlicense: MIT\nmetadata:\n  count: '2'\n  enabled: 'true'\n---\nRead references/café.md only when needed.\n" },
    { path: "references/café.md", content: "Résumé — 你好\n" },
    ...(input.extra ?? []),
  ];
  const body = JSON.stringify({ files });
  const release = {
    slug, title: "Native test", summary: "Test native delivery", version,
    reviewStatus: "approved", securityStatus: "passed", publishedAt: "2026-09-25T00:00:00.000Z",
    platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
    artifact: { sha256: hash(body), byteSize: Buffer.byteLength(body), contentType: "application/vnd.myskills-app.package+json" },
  };
  const skill = { slug: release.slug, title: release.title, summary: release.summary, latestVersion: version, reviewStatus: "approved", securityStatus: "passed", lifecycleStatus: "approved", visibility: "public", platforms: release.platforms, tags: [] };
  const state = { revoked: false, hidden: false, tamper: false, actor: "reader", scopes: ["skills:read"], nextCursor: null as string | null };
  const calls: Array<{ url: string; method?: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    assert.equal(init?.headers?.authorization, "Bearer aiss_native_test");
    const parsed = new URL(url);
    calls.push({ url: parsed.pathname + parsed.search, method: init?.headers?.["x-myskills-mcp-method"] });
    if (parsed.pathname === "/v1/mcp/session") {
      return json(state.revoked ? 401 : 200, {
        user: { id: state.actor, email: "reader@example.test", name: "Reader", roles: ["user"], emailVerified: true, mfaVerified: false },
        credential: { kind: "api_token", tokenId: "token-native", scopes: state.scopes },
      });
    }
    if (parsed.pathname === "/v1/skills") {
      if (parsed.searchParams.get("cursor") && parsed.searchParams.get("cursor") !== `cursor-${state.actor}`) return json(400, { error: { code: "INVALID_SKILL_CURSOR" } });
      return json(200, { skills: state.hidden || parsed.searchParams.has("cursor") ? [] : [skill], nextCursor: parsed.searchParams.has("cursor") ? null : state.nextCursor });
    }
    const prefix = `/v1/skills/${encodeURIComponent(slug)}/releases/${encodeURIComponent(version)}`;
    if (state.hidden) return json(404, { error: { code: "RELEASE_NOT_FOUND" } });
    if (parsed.pathname === prefix) return json(200, { release });
    if (parsed.pathname === `${prefix}/bundle`) {
      assert.equal(parsed.searchParams.get("platform"), "codex");
      return new Response(state.tamper ? body.replace("Résumé", "Changed") : body, { headers: { "content-type": release.artifact.contentType } });
    }
    return json(404, {});
  };
  return { files, body, release, skill, state, calls, fetchImpl };
}

export function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function json(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
