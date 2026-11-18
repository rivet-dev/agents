interface GithubAuthOptions {
  githubToken?: string | null;
  baseBranch?: string | null;
}

function authHeaders(options?: GithubAuthOptions): HeadersInit {
  const token = options?.githubToken?.trim();
  if (!token) {
    throw new Error("GitHub token is required for this operation");
  }
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubRequest(path: string, init: RequestInit, options?: GithubAuthOptions): Promise<Response> {
  return await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...authHeaders(options),
      ...(init.headers ?? {}),
    },
  });
}

export async function createPr(
  repoFullName: string,
  headBranch: string,
  title: string,
  body?: string,
  options?: GithubAuthOptions,
): Promise<{ number: number; url: string }> {
  const baseBranch = options?.baseBranch?.trim() || "main";
  const response = await githubRequest(
    `/repos/${repoFullName}/pulls`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        head: headBranch,
        base: baseBranch,
        body: body ?? "",
      }),
    },
    options,
  );

  const payload = (await response.json()) as { number?: number; html_url?: string; message?: string };
  if (!response.ok || !payload.number || !payload.html_url) {
    throw new Error(payload.message ?? `Failed to create pull request for ${repoFullName}`);
  }

  return {
    number: payload.number,
    url: payload.html_url,
  };
}

export async function starRepository(repoFullName: string, options?: GithubAuthOptions): Promise<void> {
  const response = await githubRequest(
    `/user/starred/${repoFullName}`,
    {
      method: "PUT",
      headers: {
        "Content-Length": "0",
      },
    },
    options,
  );

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? `Failed to star GitHub repository ${repoFullName}`);
  }
}
