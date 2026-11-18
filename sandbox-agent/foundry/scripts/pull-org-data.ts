#!/usr/bin/env bun
/**
 * Pull public GitHub organization data into a JSON fixture file.
 *
 * This script mirrors the sync logic in the backend organization actor
 * (see: packages/backend/src/actors/organization/app-shell.ts — syncGithubOrganizations
 * and syncGithubOrganizationRepos). Keep the two in sync: when the backend
 * sync workflow changes what data it fetches or how it structures organizations,
 * update this script to match.
 *
 * Key difference from the backend sync: this script only fetches **public** data
 * from the GitHub API (no auth token required, no private repos). It is used to
 * populate realistic mock/test data for the Foundry frontend without needing
 * GitHub OAuth credentials or a GitHub App installation.
 *
 * Usage:
 *   bun foundry/scripts/pull-org-data.ts <org-login> [--out <path>]
 *
 * Examples:
 *   bun foundry/scripts/pull-org-data.ts rivet-gg
 *   bun foundry/scripts/pull-org-data.ts rivet-gg --out foundry/scripts/data/rivet-gg.json
 */

import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ── Types matching the backend sync output ──
// See: packages/shared/src/app-shell.ts

interface OrgFixtureRepo {
  fullName: string;
  cloneUrl: string;
  description: string | null;
  language: string | null;
  stars: number;
  updatedAt: string;
}

interface OrgFixtureMember {
  id: string;
  login: string;
  avatarUrl: string;
  role: "admin" | "member";
}

interface OrgFixturePullRequest {
  number: number;
  title: string;
  state: "open";
  draft: boolean;
  headRefName: string;
  author: string;
  repoFullName: string;
  updatedAt: string;
}

interface OrgFixture {
  /** ISO timestamp of when this data was pulled */
  pulledAt: string;
  /** GitHub organization login (e.g. "rivet-gg") */
  login: string;
  /** GitHub numeric ID */
  id: number;
  /** Display name */
  name: string | null;
  /** Organization description */
  description: string | null;
  /** Public email */
  email: string | null;
  /** Blog/website URL */
  blog: string | null;
  /** Avatar URL */
  avatarUrl: string;
  /** Public repositories (excludes forks by default) */
  repos: OrgFixtureRepo[];
  /** Public members (only those with public membership) */
  members: OrgFixtureMember[];
  /** Open pull requests across all public repos */
  openPullRequests: OrgFixturePullRequest[];
}

// ── GitHub API helpers ──
// Mirrors the pagination approach in packages/backend/src/services/app-github.ts

const API_BASE = "https://api.github.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "foundry-pull-org-data/1.0",
  };
  if (GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
  }
  return headers;
}

async function githubGet<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status}: ${url}\n${body.slice(0, 500)}`);
  }
  return (await response.json()) as T;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const [urlPart, relPart] = part.split(";").map((v) => v.trim());
    if (urlPart && relPart?.includes('rel="next"')) {
      return urlPart.replace(/^<|>$/g, "");
    }
  }
  return null;
}

async function githubPaginate<T>(path: string): Promise<T[]> {
  let url: string | null = `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const items: T[] = [];

  while (url) {
    const response = await fetch(url, { headers: authHeaders() });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GitHub API ${response.status}: ${url}\n${body.slice(0, 500)}`);
    }
    const page = (await response.json()) as T[];
    items.push(...page);
    url = parseNextLink(response.headers.get("link"));
  }

  return items;
}

// ── Main ──

async function pullOrgData(orgLogin: string): Promise<OrgFixture> {
  console.log(`Fetching organization: ${orgLogin}`);

  // 1. Fetch org profile
  // Backend equivalent: getViewer() + listOrganizations() derive org identity
  const org = await githubGet<{
    id: number;
    login: string;
    name: string | null;
    description: string | null;
    email: string | null;
    blog: string | null;
    avatar_url: string;
    public_repos: number;
    public_members_url: string;
  }>(`${API_BASE}/orgs/${orgLogin}`);

  console.log(`  ${org.name ?? org.login} — ${org.public_repos} public repos`);

  // 2. Fetch public repos (non-fork, non-archived)
  // Backend equivalent: listInstallationRepositories() or listUserRepositories()
  // Key difference: we only fetch public repos here (type=public)
  const rawRepos = await githubPaginate<{
    full_name: string;
    clone_url: string;
    description: string | null;
    language: string | null;
    stargazers_count: number;
    updated_at: string;
    fork: boolean;
    archived: boolean;
    private: boolean;
  }>(`/orgs/${orgLogin}/repos?per_page=100&type=public&sort=updated`);

  const repos: OrgFixtureRepo[] = rawRepos
    .filter((r) => !r.fork && !r.archived && !r.private)
    .map((r) => ({
      fullName: r.full_name,
      cloneUrl: r.clone_url,
      description: r.description,
      language: r.language,
      stars: r.stargazers_count,
      updatedAt: r.updated_at,
    }))
    .sort((a, b) => b.stars - a.stars);

  console.log(`  ${repos.length} public repos (excluding forks/archived)`);

  // 3. Fetch public members
  // Backend equivalent: members are derived from the OAuth user + org membership
  // Here we can only see members with public membership visibility
  const rawMembers = await githubPaginate<{
    id: number;
    login: string;
    avatar_url: string;
  }>(`/orgs/${orgLogin}/members?per_page=100`);

  const members: OrgFixtureMember[] = rawMembers.map((m) => ({
    id: String(m.id),
    login: m.login,
    avatarUrl: m.avatar_url,
    role: "member" as const,
  }));

  console.log(`  ${members.length} public members`);

  // 4. Fetch open PRs across all public repos
  // Backend equivalent: open PR metadata is pulled from GitHub and merged into
  // the organization/repository projections used by the UI.
  const openPullRequests: OrgFixturePullRequest[] = [];
  for (const repo of repos) {
    const rawPrs = await githubPaginate<{
      number: number;
      title: string;
      state: string;
      draft: boolean;
      head: { ref: string };
      user: { login: string } | null;
      updated_at: string;
    }>(`/repos/${repo.fullName}/pulls?state=open&per_page=100`);

    for (const pr of rawPrs) {
      openPullRequests.push({
        number: pr.number,
        title: pr.title,
        state: "open",
        draft: pr.draft,
        headRefName: pr.head.ref,
        author: pr.user?.login ?? "unknown",
        repoFullName: repo.fullName,
        updatedAt: pr.updated_at,
      });
    }

    if (rawPrs.length > 0) {
      console.log(`  ${repo.fullName}: ${rawPrs.length} open PRs`);
    }
  }

  console.log(`  ${openPullRequests.length} total open PRs`);

  return {
    pulledAt: new Date().toISOString(),
    login: org.login,
    id: org.id,
    name: org.name,
    description: org.description,
    email: org.email,
    blog: org.blog,
    avatarUrl: org.avatar_url,
    repos,
    members,
    openPullRequests,
  };
}

// ── CLI ──

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    out: { type: "string", short: "o" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help || positionals.length === 0) {
  console.log("Usage: bun foundry/scripts/pull-org-data.ts <org-login> [--out <path>]");
  console.log("");
  console.log("Pulls public GitHub organization data into a JSON fixture file.");
  console.log("Set GITHUB_TOKEN or GH_TOKEN to avoid rate limits.");
  process.exit(positionals.length === 0 && !values.help ? 1 : 0);
}

const orgLogin = positionals[0]!;
const defaultOutDir = resolve(import.meta.dirname ?? ".", "data");
const outPath = values.out ?? resolve(defaultOutDir, `${orgLogin}.json`);

try {
  const data = await pullOrgData(orgLogin);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");

  console.log(`\nWrote ${outPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
