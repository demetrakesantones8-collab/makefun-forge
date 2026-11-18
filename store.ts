// The forge's store: repositories, their objects, refs, labels, issues and pull requests. Everything
// lives in memory for the life of one trial; nothing is written to disk.

import { hashObject, parseCommit, parseTree, type GitObject, type ObjType } from './gitobjects.ts';

export const VIEWER_LOGIN = process.env.MAKEFUN_FORGE_LOGIN ?? 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  base: string;
  head_sha: string | null;
  merge_commit: string | null;
  user: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  created_at: string;
  pushed_at: string | null;
  default_branch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  next_issue: number;
  next_pull: number;
  next_label: number;
}

const repos = new Map<string, Repo>();
let next_repo_id = 1000;
const now = (): string => new Date().toISOString();

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function createRepo(owner: string, name: string, description: string | null, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: (next_repo_id += 1),
    owner,
    name,
    description,
    private: isPrivate,
    created_at: now(),
    pushed_at: null,
    default_branch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    next_issue: 1,
    next_pull: 1,
    next_label: 1,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

export function getRepo(owner: string | null, name: string): Repo | null {
  if (owner && owner.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) return null;
  return repos.get(repoKey(owner ?? VIEWER_LOGIN, name)) ?? null;
}

export function deleteRepo(repo: Repo): void {
  repos.delete(repoKey(repo.owner, repo.name));
}

export function listRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id));
}

/** Every object a clone of `repo` at `tip` needs, tip first: commits down `depth` levels, trees, blobs. */
export function packObjects(repo: Repo, tip: string, depth: number): { sha: string; object: GitObject }[] {
  const out: { sha: string; object: GitObject }[] = [];
  const seen = new Set<string>();
  const push = (sha: string, object: GitObject): void => {
    if (seen.has(sha)) return;
    seen.add(sha);
    out.push({ sha, object });
  };
  const walkTree = (sha: string): void => {
    if (seen.has(sha)) return;
    const object = repo.objects.get(sha);
    if (!object) return;
    push(sha, object);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') walkTree(entry.sha);
      else {
        const blob = repo.objects.get(entry.sha);
        if (blob) push(entry.sha, blob);
      }
    }
  };
  const walkCommit = (sha: string, level: number): void => {
    if (seen.has(sha)) return;
    const object = repo.objects.get(sha);
    if (!object || object.type !== 'commit') return;
    push(sha, object);
    const commit = parseCommit(object.data);
    walkTree(commit.tree);
    if (level > 0) for (const parent of commit.parents) walkCommit(parent, level - 1);
  };
  walkCommit(tip, depth);
  return out;
}

export function putObject(repo: Repo, object: GitObject): string {
  const sha = hashObject(object.type, object.data);
  repo.objects.set(sha, object);
  return sha;
}

export function getObject(repo: Repo, sha: string): GitObject | undefined {
  return repo.objects.get(sha);
}

export function typeOf(repo: Repo, sha: string): ObjType | undefined {
  return repo.objects.get(sha)?.type;
}

/** Whether `ancestor` is `descendant` or one of its parents, all the way down. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = repo.objects.get(sha);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The commit at the tip of a branch, or null. */
export function tipOf(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const number = repo.next_issue++;
  const stamp = now();
  const issue: Issue = {
    id: repo.id * 100000 + number,
    number,
    title,
    body,
    state: 'open',
    labels,
    user: VIEWER_LOGIN,
    created_at: stamp,
    updated_at: stamp,
    closed_at: null,
  };
  repo.issues.set(number, issue);
  return issue;
}

export function createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
  const number = repo.next_pull++;
  const stamp = now();
  const pull: Pull = {
    id: repo.id * 200000 + number,
    number,
    title,
    body,
    state: 'open',
    merged: false,
    head,
    base,
    head_sha: repo.refs.get(`refs/heads/${head}`) ?? null,
    merge_commit: null,
    user: VIEWER_LOGIN,
    created_at: stamp,
    updated_at: stamp,
    merged_at: null,
  };
  repo.pulls.set(number, pull);
  return pull;
}
