import type { RepoRecord } from "@sandbox-agent/foundry-shared";
import type { BackendClient } from "../../src/backend-client.js";

function normalizeRepoSelector(value: string): string {
  let normalized = value.trim();
  if (!normalized) {
    return "";
  }

  normalized = normalized.replace(/\/+$/, "");
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    return `https://github.com/${normalized}.git`;
  }

  if (/^(?:www\.)?github\.com\/.+/i.test(normalized)) {
    normalized = `https://${normalized.replace(/^www\./i, "")}`;
  }

  try {
    if (/^https?:\/\//i.test(normalized)) {
      const url = new URL(normalized);
      const hostname = url.hostname.replace(/^www\./i, "");
      if (hostname.toLowerCase() === "github.com") {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length >= 2) {
          return `${url.protocol}//${hostname}/${parts[0]}/${(parts[1] ?? "").replace(/\.git$/i, "")}.git`;
        }
      }
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    // Keep the selector as-is for matching below.
  }

  return normalized;
}

function githubRepoFullNameFromSelector(value: string): string | null {
  const normalized = normalizeRepoSelector(value);
  try {
    const url = new URL(normalized);
    if (url.hostname.replace(/^www\./i, "").toLowerCase() !== "github.com") {
      return null;
    }
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    return `${parts[0]}/${(parts[1] ?? "").replace(/\.git$/i, "")}`;
  } catch {
    return null;
  }
}

export async function requireImportedRepo(client: BackendClient, organizationId: string, repoSelector: string): Promise<RepoRecord> {
  const selector = repoSelector.trim();
  if (!selector) {
    throw new Error("Missing repo selector");
  }

  const normalizedSelector = normalizeRepoSelector(selector);
  const selectorFullName = githubRepoFullNameFromSelector(selector);
  const repos = await client.listRepos(organizationId);
  const match = repos.find((repo) => {
    if (repo.repoId === selector) {
      return true;
    }
    if (normalizeRepoSelector(repo.remoteUrl) === normalizedSelector) {
      return true;
    }
    const repoFullName = githubRepoFullNameFromSelector(repo.remoteUrl);
    return Boolean(selectorFullName && repoFullName && repoFullName === selectorFullName);
  });

  if (!match) {
    throw new Error(
      `Repo not available in organization ${organizationId}: ${repoSelector}. Create it in GitHub first, then sync repos in Foundry before running this test.`,
    );
  }

  return match;
}
