import { createHash } from "node:crypto";
import { gitBlobSha, type SourceHttpRequest, type SourceHttpResponse, type SourceHttpTransport } from "./github-source.js";

/**
 * Deterministic in-memory stand-in for api.github.com and
 * raw.githubusercontent.com. Test and E2E harness use only: production
 * server wiring never constructs it and no environment variable selects it.
 * Blob SHAs are real Git blob SHAs, so the adapter's integrity checks run
 * unchanged against fixture content.
 */

export interface FixtureRepositoryInput {
  id: number;
  owner: string;
  name: string;
  defaultBranch?: string;
  license?: string | null;
  private?: boolean;
  archived?: boolean;
  files: Record<string, string>;
  binaryFiles?: Record<string, Uint8Array>;
  symlinks?: Record<string, string>;
  submodules?: string[];
}

export interface FixtureCommitInput {
  branch?: string;
  /** Build on this commit instead of the branch head. A non-descendant parent models a force-push. */
  parent?: string;
  files?: Record<string, string | null>;
  binaryFiles?: Record<string, Uint8Array>;
  symlinks?: Record<string, string>;
}

export interface FixtureFailure {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

interface FixtureEntry {
  mode: "100644" | "120000" | "160000";
  type: "blob" | "commit";
  sha: string;
  content: Uint8Array | null;
}

interface FixtureCommit {
  sha: string;
  treeSha: string;
  parent: string | null;
  entries: Map<string, FixtureEntry>;
}

interface FixtureRepository {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
  license: string | null;
  private: boolean;
  archived: boolean;
  commits: Map<string, FixtureCommit>;
  branches: Map<string, string>;
  tags: Map<string, { commit: string; annotatedSha: string | null }>;
  releases: Array<{ id: number; tagName: string; name: string }>;
  previousNames: Set<string>;
  sizelessPaths: Set<string>;
}

export class FixtureGithubSource {
  readonly requests: Array<{ url: string; headers: Record<string, string> }> = [];
  private readonly repositories = new Map<number, FixtureRepository>();
  private readonly failures: Array<{ match: string | RegExp; failure: FixtureFailure; remaining: number }> = [];
  private readonly intercepts: Array<{ match: string | RegExp; hook: () => unknown; remaining: number }> = [];
  private counter = 0;

  createRepository(input: FixtureRepositoryInput): { fullName: string; headCommit: string } {
    const defaultBranch = input.defaultBranch ?? "main";
    const repository: FixtureRepository = {
      id: input.id,
      owner: input.owner,
      name: input.name,
      defaultBranch,
      license: input.license === undefined ? "MIT" : input.license,
      private: input.private ?? false,
      archived: input.archived ?? false,
      commits: new Map(),
      branches: new Map(),
      tags: new Map(),
      releases: [],
      previousNames: new Set(),
      sizelessPaths: new Set(),
    };
    this.repositories.set(input.id, repository);
    const entries = new Map<string, FixtureEntry>();
    applyChanges(entries, { files: input.files, binaryFiles: input.binaryFiles, symlinks: input.symlinks });
    for (const path of input.submodules ?? []) {
      entries.set(path, { mode: "160000", type: "commit", sha: sha1(`submodule:${path}`), content: null });
    }
    const commit = this.storeCommit(repository, null, entries);
    repository.branches.set(defaultBranch, commit.sha);
    return { fullName: `${repository.owner}/${repository.name}`, headCommit: commit.sha };
  }

  commit(fullName: string, input: FixtureCommitInput): string {
    const repository = this.requireRepository(fullName);
    const branch = input.branch ?? repository.defaultBranch;
    if (input.parent !== undefined && !repository.commits.has(input.parent)) throw new Error(`Fixture commit not found: ${input.parent}`);
    const parentSha = input.parent ?? repository.branches.get(branch);
    const parent = parentSha ? repository.commits.get(parentSha) : undefined;
    const entries = new Map(parent?.entries ?? []);
    applyChanges(entries, input);
    const commit = this.storeCommit(repository, parentSha ?? null, entries);
    repository.branches.set(branch, commit.sha);
    return commit.sha;
  }

  headCommit(fullName: string, branch?: string): string {
    const repository = this.requireRepository(fullName);
    const sha = repository.branches.get(branch ?? repository.defaultBranch);
    if (!sha) throw new Error(`Fixture branch not found: ${branch}`);
    return sha;
  }

  tag(fullName: string, name: string, options: { commit?: string; annotated?: boolean } = {}): void {
    const repository = this.requireRepository(fullName);
    const commit = options.commit ?? this.headCommit(fullName);
    repository.tags.set(name, { commit, annotatedSha: options.annotated ? sha1(`tag:${name}:${commit}`) : null });
  }

  release(fullName: string, input: { tagName: string; name?: string; id?: number }): void {
    const repository = this.requireRepository(fullName);
    repository.releases.push({ id: input.id ?? 900_000 + repository.releases.length, tagName: input.tagName, name: input.name ?? input.tagName });
  }

  rename(fullName: string, owner: string, name: string): void {
    const repository = this.requireRepository(fullName);
    repository.previousNames.add(fullName.toLowerCase());
    repository.owner = owner;
    repository.name = name;
  }

  failNext(match: string | RegExp, failure: FixtureFailure, times = 1): void {
    this.failures.push({ match, failure, remaining: times });
  }

  /** Tree responses omit `size` for these paths, as a transport without sizes would. */
  hideTreeSizes(fullName: string, paths: string[]): void {
    const repository = this.requireRepository(fullName);
    for (const path of paths) repository.sizelessPaths.add(path);
  }

  /** Runs `hook` before answering the next matching request, which then answers normally. */
  interceptNext(match: string | RegExp, hook: () => unknown): void {
    this.intercepts.push({ match, hook, remaining: 1 });
  }

  transport(): SourceHttpTransport {
    return { get: async (request) => this.handle(request) };
  }

  private async handle(request: SourceHttpRequest): Promise<SourceHttpResponse> {
    const url = request.url.toString();
    this.requests.push({ url, headers: { ...request.headers } });
    if (request.signal.aborted) throw new Error("aborted");
    const intercept = this.intercepts.find((item) => item.remaining > 0 && (typeof item.match === "string" ? url.includes(item.match) : item.match.test(url)));
    if (intercept) {
      intercept.remaining -= 1;
      await intercept.hook();
    }
    const failure = this.failures.find((item) => item.remaining > 0 && (typeof item.match === "string" ? url.includes(item.match) : item.match.test(url)));
    if (failure) {
      failure.remaining -= 1;
      return response(failure.failure.status, failure.failure.body ?? { message: "fixture failure" }, failure.failure.headers ?? {});
    }
    if (request.url.protocol !== "https:") return response(400, { message: "https only" });
    if (request.url.host === "raw.githubusercontent.com") return this.raw(request);
    if (request.url.host !== "api.github.com") throw new Error(`Fixture refuses host ${request.url.host}`);
    const segments = request.url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments[0] === "repositories" && segments.length === 2) {
      const repository = this.repositories.get(Number(segments[1]));
      return repository && !repository.private ? response(200, repositoryJson(repository)) : response(404, { message: "Not Found" });
    }
    if (segments[0] !== "repos" || segments.length < 3) return response(404, { message: "Not Found" });
    const fullName = `${segments[1]}/${segments[2]}`.toLowerCase();
    const repository = [...this.repositories.values()].find((item) => `${item.owner}/${item.name}`.toLowerCase() === fullName);
    if (!repository) {
      const moved = [...this.repositories.values()].find((item) => item.previousNames.has(fullName));
      if (moved) {
        return { status: 301, headers: { location: `https://api.github.com/repositories/${moved.id}` }, body: new Uint8Array() };
      }
      return response(404, { message: "Not Found" });
    }
    if (repository.private) return response(404, { message: "Not Found" });
    const rest = segments.slice(3);
    if (rest.length === 0) return response(200, repositoryJson(repository));
    if (rest[0] === "git" && rest[1] === "ref" && (rest[2] === "heads" || rest[2] === "tags")) {
      const name = rest.slice(3).join("/");
      if (rest[2] === "heads") {
        const sha = repository.branches.get(name);
        return sha ? response(200, { ref: `refs/heads/${name}`, object: { type: "commit", sha } }) : response(404, { message: "Not Found" });
      }
      const tag = repository.tags.get(name);
      if (!tag) return response(404, { message: "Not Found" });
      return response(200, { ref: `refs/tags/${name}`, object: tag.annotatedSha ? { type: "tag", sha: tag.annotatedSha } : { type: "commit", sha: tag.commit } });
    }
    if (rest[0] === "git" && rest[1] === "tags" && rest.length === 3) {
      const tag = [...repository.tags.values()].find((item) => item.annotatedSha === rest[2]);
      return tag ? response(200, { sha: rest[2], object: { type: "commit", sha: tag.commit } }) : response(404, { message: "Not Found" });
    }
    if (rest[0] === "git" && rest[1] === "matching-refs" && rest[2] === "tags") {
      const prefix = rest.slice(3).join("/");
      return response(200, [...repository.tags.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, tag]) => ({ ref: `refs/tags/${name}`, object: tag.annotatedSha ? { type: "tag", sha: tag.annotatedSha } : { type: "commit", sha: tag.commit } })));
    }
    if (rest[0] === "git" && rest[1] === "commits" && rest.length === 3) {
      const commit = repository.commits.get(rest[2]!);
      return commit ? response(200, { sha: commit.sha, tree: { sha: commit.treeSha }, parents: commit.parent ? [{ sha: commit.parent }] : [] }) : response(404, { message: "Not Found" });
    }
    if (rest[0] === "git" && rest[1] === "trees" && rest.length === 3) {
      const commit = [...repository.commits.values()].find((item) => item.treeSha === rest[2]);
      if (!commit) return response(404, { message: "Not Found" });
      return response(200, {
        sha: commit.treeSha,
        truncated: false,
        tree: [...commit.entries.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, entry]) => ({
          path,
          mode: entry.mode,
          type: entry.type,
          sha: entry.sha,
          ...(entry.content && !repository.sizelessPaths.has(path) ? { size: entry.content.byteLength } : {}),
        })),
      });
    }
    if (rest[0] === "releases" && rest[1] === "latest") {
      const latest = repository.releases.at(-1);
      return latest ? response(200, { id: latest.id, tag_name: latest.tagName, name: latest.name, draft: false, prerelease: false }) : response(404, { message: "Not Found" });
    }
    if (rest[0] === "compare" && rest.length === 2) {
      const [base, head] = rest[1]!.split("...");
      if (!base || !head || !repository.commits.has(base) || !repository.commits.has(head)) return response(404, { message: "Not Found" });
      const status = base === head ? "identical"
        : this.isAncestor(repository, base, head) ? "ahead"
          : this.isAncestor(repository, head, base) ? "behind" : "diverged";
      return response(200, { status, ahead_by: 0, behind_by: 0, commits: [], files: [] });
    }
    return response(404, { message: "Not Found" });
  }

  private raw(request: SourceHttpRequest): SourceHttpResponse {
    const segments = request.url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    const [owner, name, commitSha, ...path] = segments;
    const repository = [...this.repositories.values()].find((item) => item.owner === owner && item.name === name && !item.private);
    const commit = commitSha ? repository?.commits.get(commitSha) : undefined;
    const entry = commit?.entries.get(path.join("/"));
    if (!entry?.content) return { status: 404, headers: {}, body: Buffer.from("404: Not Found") };
    if (entry.content.byteLength > request.maxBytes) throw new Error("fixture body exceeds maxBytes");
    return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: entry.content };
  }

  private isAncestor(repository: FixtureRepository, ancestor: string, descendant: string): boolean {
    let current = repository.commits.get(descendant)?.parent ?? null;
    while (current) {
      if (current === ancestor) return true;
      current = repository.commits.get(current)?.parent ?? null;
    }
    return false;
  }

  private storeCommit(repository: FixtureRepository, parent: string | null, entries: Map<string, FixtureEntry>): FixtureCommit {
    this.counter += 1;
    const treeSha = sha1(`tree:${JSON.stringify([...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, entry]) => [path, entry.mode, entry.sha]))}`);
    const sha = sha1(`commit:${repository.id}:${parent ?? "root"}:${treeSha}:${this.counter}`);
    const commit = { sha, treeSha, parent, entries };
    repository.commits.set(sha, commit);
    return commit;
  }

  private requireRepository(fullName: string): FixtureRepository {
    const repository = [...this.repositories.values()].find((item) => `${item.owner}/${item.name}`.toLowerCase() === fullName.toLowerCase());
    if (!repository) throw new Error(`Fixture repository not found: ${fullName}`);
    return repository;
  }
}

function applyChanges(entries: Map<string, FixtureEntry>, input: FixtureCommitInput): void {
  for (const [path, content] of Object.entries(input.files ?? {})) {
    if (content === null) {
      entries.delete(path);
      continue;
    }
    const bytes = Buffer.from(content, "utf8");
    entries.set(path, { mode: "100644", type: "blob", sha: gitBlobSha(bytes), content: bytes });
  }
  for (const [path, bytes] of Object.entries(input.binaryFiles ?? {})) {
    entries.set(path, { mode: "100644", type: "blob", sha: gitBlobSha(bytes), content: bytes });
  }
  for (const [path, target] of Object.entries(input.symlinks ?? {})) {
    const bytes = Buffer.from(target, "utf8");
    entries.set(path, { mode: "120000", type: "blob", sha: gitBlobSha(bytes), content: bytes });
  }
}

function repositoryJson(repository: FixtureRepository) {
  return {
    id: repository.id,
    full_name: `${repository.owner}/${repository.name}`,
    html_url: `https://github.com/${repository.owner}/${repository.name}`,
    default_branch: repository.defaultBranch,
    private: repository.private,
    visibility: repository.private ? "private" : "public",
    archived: repository.archived,
    license: repository.license ? { spdx_id: repository.license } : null,
  };
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): SourceHttpResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body: Buffer.from(JSON.stringify(body)) };
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}
