import { createHash } from "node:crypto";
import { basename, sep } from "node:path";

export function normalizeRemoteUrl(remoteUrl: string): string {
  let value = remoteUrl.trim();
  if (!value) return "";

  // Strip trailing slashes to make hashing stable.
  value = value.replace(/\/+$/, "");

  // GitHub shorthand: owner/repo -> https://github.com/owner/repo.git
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    return `https://github.com/${value}.git`;
  }

  // If a user pastes "github.com/owner/repo", treat it as HTTPS.
  if (/^(?:www\.)?github\.com\/.+/i.test(value)) {
    value = `https://${value.replace(/^www\./i, "")}`;
  }

  // Canonicalize GitHub URLs to the repo clone URL (drop /tree/*, issues, etc).
  // This makes "https://github.com/owner/repo" and ".../tree/main" map to the same repoId.
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      const hostname = url.hostname.replace(/^www\./i, "");
      if (hostname.toLowerCase() === "github.com") {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length >= 2) {
          const owner = parts[0]!;
          const repo = parts[1]!;
          const base = `${url.protocol}//${hostname}/${owner}/${repo.replace(/\.git$/i, "")}.git`;
          return base;
        }
      }
      // Drop query/fragment for stability.
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    // ignore parse failures; fall through to raw value
  }

  return value;
}

export function repoIdFromRemote(remoteUrl: string): string {
  const normalized = normalizeRemoteUrl(remoteUrl);
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

export function repoLabelFromRemote(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return "";
  }

  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith("file:")) {
      const url = new URL(trimmed);
      const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
      if (parts.length >= 2) {
        return `${parts[parts.length - 2]}/${(parts[parts.length - 1] ?? "").replace(/\.git$/i, "")}`;
      }
    } else {
      const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
      const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
      if (parts.length >= 2) {
        return `${parts[0]}/${(parts[1] ?? "").replace(/\.git$/i, "")}`;
      }
    }
  } catch {
    // Fall through to path-based parsing.
  }

  const normalizedPath = trimmed.replace(/\\/g, sep);
  const segments = normalizedPath.split(sep).filter(Boolean);
  if (segments.length >= 2) {
    return `${segments[segments.length - 2]}/${segments[segments.length - 1]!.replace(/\.git$/i, "")}`;
  }

  return basename(trimmed.replace(/\.git$/i, ""));
}

export function githubRepoFullNameFromRemote(remoteUrl: string): string | null {
  const normalized = normalizeRemoteUrl(remoteUrl);
  if (!normalized) {
    return null;
  }

  try {
    const url = new URL(normalized);
    const hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (hostname !== "github.com") {
      return null;
    }
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    const owner = parts[0]?.trim();
    const repo = (parts[1] ?? "").replace(/\.git$/i, "").trim();
    if (!owner || !repo) {
      return null;
    }
    return `${owner}/${repo}`;
  } catch {
    return null;
  }
}
