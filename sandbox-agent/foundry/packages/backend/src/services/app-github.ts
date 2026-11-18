import { createHmac, createPrivateKey, createSign, timingSafeEqual } from "node:crypto";
import { logger } from "../logging.js";

export class GitHubAppError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "GitHubAppError";
    this.status = status;
  }
}

export interface GitHubOAuthSession {
  accessToken: string;
  scopes: string[];
}

export interface GitHubViewerIdentity {
  id: string;
  login: string;
  name: string;
  email: string | null;
}

export interface GitHubOrgIdentity {
  id: string;
  login: string;
  name: string | null;
}

export interface GitHubInstallationRecord {
  id: number;
  accountLogin: string;
}

export interface GitHubRepositoryRecord {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  defaultBranch: string;
}

export interface GitHubMemberRecord {
  id: string;
  login: string;
  name: string;
  email: string | null;
  role: string | null;
  state: string;
}

export interface GitHubPullRequestRecord {
  repoFullName: string;
  cloneUrl: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  authorLogin: string | null;
  isDraft: boolean;
  merged: boolean;
}

interface GitHubTokenResponse {
  access_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GitHubPageResponse<T> {
  items: T[];
  nextUrl: string | null;
}

const githubOAuthLogger = logger.child({
  scope: "github-oauth",
});

export interface GitHubWebhookEvent {
  action?: string;
  organization?: { login?: string; id?: number };
  installation?: { id: number; account?: { login?: string; type?: string; id?: number } | null };
  repositories_added?: Array<{ id: number; full_name: string; private: boolean }>;
  repositories_removed?: Array<{ id: number; full_name: string }>;
  repository?: { id: number; full_name: string; clone_url?: string; private?: boolean; owner?: { login?: string } };
  pull_request?: {
    number: number;
    title?: string;
    body?: string | null;
    state?: string;
    html_url?: string;
    draft?: boolean;
    merged?: boolean;
    user?: { login?: string } | null;
    head?: { ref?: string };
    base?: { ref?: string };
  };
  sender?: { login?: string; id?: number };
  [key: string]: unknown;
}

export interface GitHubAppClientOptions {
  apiBaseUrl?: string;
  authBaseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  appId?: string;
  appPrivateKey?: string;
  webhookSecret?: string;
}

function normalizePem(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }

  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

export class GitHubAppClient {
  private readonly apiBaseUrl: string;
  private readonly authBaseUrl: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly redirectUri?: string;
  private readonly appId?: string;
  private readonly appPrivateKey?: string;
  private readonly webhookSecret?: string;

  constructor(options: GitHubAppClientOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.authBaseUrl = (options.authBaseUrl ?? "https://github.com").replace(/\/$/, "");
    this.clientId = options.clientId ?? process.env.GITHUB_CLIENT_ID;
    this.clientSecret = options.clientSecret ?? process.env.GITHUB_CLIENT_SECRET;
    this.redirectUri = options.redirectUri ?? process.env.GITHUB_REDIRECT_URI;
    this.appId = options.appId ?? process.env.GITHUB_APP_ID;
    this.appPrivateKey = normalizePem(options.appPrivateKey ?? process.env.GITHUB_APP_PRIVATE_KEY);
    this.webhookSecret = options.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET;
  }

  isOauthConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  isAppConfigured(): boolean {
    return Boolean(this.appId && this.appPrivateKey);
  }

  isWebhookConfigured(): boolean {
    return Boolean(this.webhookSecret);
  }

  verifyWebhookEvent(payload: string, signatureHeader: string | null, eventHeader: string | null): { event: string; body: GitHubWebhookEvent } {
    if (!this.webhookSecret) {
      throw new GitHubAppError("GitHub webhook secret is not configured", 500);
    }
    if (!signatureHeader) {
      throw new GitHubAppError("Missing GitHub signature header", 400);
    }
    if (!eventHeader) {
      throw new GitHubAppError("Missing GitHub event header", 400);
    }

    const expectedSignature = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : null;
    if (!expectedSignature) {
      throw new GitHubAppError("Malformed GitHub signature header", 400);
    }

    const computed = createHmac("sha256", this.webhookSecret).update(payload).digest("hex");
    const computedBuffer = Buffer.from(computed, "utf8");
    const expectedBuffer = Buffer.from(expectedSignature, "utf8");
    if (computedBuffer.length !== expectedBuffer.length || !timingSafeEqual(computedBuffer, expectedBuffer)) {
      throw new GitHubAppError("GitHub webhook signature verification failed", 400);
    }

    return {
      event: eventHeader,
      body: JSON.parse(payload) as GitHubWebhookEvent,
    };
  }

  buildAuthorizeUrl(state: string): string {
    if (!this.clientId || !this.redirectUri) {
      throw new GitHubAppError("GitHub OAuth is not configured", 500);
    }

    const url = new URL(`${this.authBaseUrl}/login/oauth/authorize`);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", "read:user user:email read:org repo");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<GitHubOAuthSession> {
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      throw new GitHubAppError("GitHub OAuth is not configured", 500);
    }

    const exchangeBody = {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri,
    };
    githubOAuthLogger.debug(
      {
        url: `${this.authBaseUrl}/login/oauth/access_token`,
        clientId: this.clientId,
        redirectUri: this.redirectUri,
        codeLength: code.length,
        codePrefix: code.slice(0, 6),
      },
      "exchange_code_request",
    );

    const response = await fetch(`${this.authBaseUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(exchangeBody),
    });

    const responseText = await response.text();
    githubOAuthLogger.debug(
      {
        status: response.status,
        bodyPreview: responseText.slice(0, 300),
      },
      "exchange_code_response",
    );
    let payload: GitHubTokenResponse;
    try {
      payload = JSON.parse(responseText) as GitHubTokenResponse;
    } catch {
      // GitHub may return URL-encoded responses despite Accept: application/json
      const params = new URLSearchParams(responseText);
      if (params.has("access_token")) {
        payload = {
          access_token: params.get("access_token")!,
          scope: params.get("scope") ?? "",
        };
      } else {
        throw new GitHubAppError(
          params.get("error_description") ?? params.get("error") ?? `GitHub token exchange failed: ${responseText.slice(0, 200)}`,
          response.status || 502,
        );
      }
    }
    if (!response.ok || !payload.access_token) {
      throw new GitHubAppError(payload.error_description ?? payload.error ?? `GitHub token exchange failed with ${response.status}`, response.status);
    }

    return {
      accessToken: payload.access_token,
      scopes:
        payload.scope
          ?.split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0) ?? [],
    };
  }

  async getViewer(accessToken: string): Promise<GitHubViewerIdentity> {
    const user = await this.requestJson<{
      id: number;
      login: string;
      name?: string | null;
      email?: string | null;
    }>("/user", accessToken);

    let email = user.email ?? null;
    if (!email) {
      try {
        const emails = await this.requestJson<Array<{ email: string; primary?: boolean; verified?: boolean }>>("/user/emails", accessToken);
        const primary = emails.find((candidate) => candidate.primary && candidate.verified) ?? emails[0] ?? null;
        email = primary?.email ?? null;
      } catch (error) {
        if (!(error instanceof GitHubAppError) || error.status !== 404) {
          throw error;
        }
      }
    }

    return {
      id: String(user.id),
      login: user.login,
      name: user.name?.trim() || user.login,
      email,
    };
  }

  async listOrganizations(accessToken: string): Promise<GitHubOrgIdentity[]> {
    const organizations = await this.paginate<{ id: number; login: string; name?: string | null }>("/user/orgs?per_page=100", accessToken);
    return organizations.map((organization) => ({
      id: String(organization.id),
      login: organization.login,
      name: organization.name?.trim() || organization.login,
    }));
  }

  async listInstallations(accessToken: string): Promise<GitHubInstallationRecord[]> {
    if (!this.isAppConfigured()) {
      return [];
    }
    try {
      const payload = await this.requestJson<{
        installations?: Array<{ id: number; account?: { login?: string } | null }>;
      }>("/user/installations", accessToken);

      return (payload.installations ?? [])
        .map((installation) => ({
          id: installation.id,
          accountLogin: installation.account?.login?.trim() ?? "",
        }))
        .filter((installation) => installation.accountLogin.length > 0);
    } catch (error) {
      if (!(error instanceof GitHubAppError) || (error.status !== 401 && error.status !== 403)) {
        throw error;
      }
    }

    const installations = await this.paginateApp<{ id: number; account?: { login?: string } | null }>("/app/installations?per_page=100");
    return installations
      .map((installation) => ({
        id: installation.id,
        accountLogin: installation.account?.login?.trim() ?? "",
      }))
      .filter((installation) => installation.accountLogin.length > 0);
  }

  async listUserRepositories(accessToken: string): Promise<GitHubRepositoryRecord[]> {
    const repositories = await this.paginate<{
      full_name: string;
      clone_url: string;
      private: boolean;
      default_branch: string;
    }>("/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated", accessToken);

    return repositories.map((repository) => ({
      fullName: repository.full_name,
      cloneUrl: repository.clone_url,
      private: repository.private,
      defaultBranch: repository.default_branch,
    }));
  }

  async listInstallationRepositories(installationId: number): Promise<GitHubRepositoryRecord[]> {
    const accessToken = await this.createInstallationAccessToken(installationId);
    const repositories = await this.paginate<{
      full_name: string;
      clone_url: string;
      private: boolean;
      default_branch: string;
    }>("/installation/repositories?per_page=100", accessToken);

    return repositories.map((repository) => ({
      fullName: repository.full_name,
      cloneUrl: repository.clone_url,
      private: repository.private,
      defaultBranch: repository.default_branch,
    }));
  }

  async getUserRepository(accessToken: string, fullName: string): Promise<GitHubRepositoryRecord | null> {
    try {
      const repository = await this.requestJson<{
        full_name: string;
        clone_url: string;
        private: boolean;
        default_branch: string;
      }>(`/repos/${fullName}`, accessToken);
      return {
        fullName: repository.full_name,
        cloneUrl: repository.clone_url,
        private: repository.private,
        defaultBranch: repository.default_branch,
      };
    } catch (error) {
      if (error instanceof GitHubAppError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async getInstallationRepository(installationId: number, fullName: string): Promise<GitHubRepositoryRecord | null> {
    const accessToken = await this.createInstallationAccessToken(installationId);
    return await this.getUserRepository(accessToken, fullName);
  }

  async listOrganizationMembers(accessToken: string, organizationLogin: string): Promise<GitHubMemberRecord[]> {
    const members = await this.paginate<{
      id: number;
      login: string;
      role?: string | null;
    }>(`/orgs/${organizationLogin}/members?per_page=100&role=all`, accessToken);

    const detailedMembers = await Promise.all(
      members.map(async (member) => {
        try {
          const detail = await this.requestJson<{
            id: number;
            login: string;
            name?: string | null;
            email?: string | null;
          }>(`/users/${member.login}`, accessToken);
          return {
            id: String(detail.id),
            login: detail.login,
            name: detail.name?.trim() || detail.login,
            email: detail.email ?? null,
            role: member.role ?? null,
            state: "active",
          };
        } catch {
          return {
            id: String(member.id),
            login: member.login,
            name: member.login,
            email: null,
            role: member.role ?? null,
            state: "active",
          };
        }
      }),
    );

    return detailedMembers;
  }

  async listInstallationMembers(installationId: number, organizationLogin: string): Promise<GitHubMemberRecord[]> {
    const accessToken = await this.createInstallationAccessToken(installationId);
    return await this.listOrganizationMembers(accessToken, organizationLogin);
  }

  async listPullRequestsForUserRepositories(accessToken: string, repositories: GitHubRepositoryRecord[]): Promise<GitHubPullRequestRecord[]> {
    return (await Promise.all(repositories.map((repository) => this.listRepositoryPullRequests(accessToken, repository.fullName, repository.cloneUrl)))).flat();
  }

  async listInstallationPullRequestsForRepositories(installationId: number, repositories: GitHubRepositoryRecord[]): Promise<GitHubPullRequestRecord[]> {
    const accessToken = await this.createInstallationAccessToken(installationId);
    return await this.listPullRequestsForUserRepositories(accessToken, repositories);
  }

  async getUserPullRequest(accessToken: string, fullName: string, prNumber: number): Promise<GitHubPullRequestRecord | null> {
    try {
      const pullRequest = await this.requestJson<{
        number: number;
        title: string;
        body?: string | null;
        state: string;
        html_url: string;
        draft?: boolean;
        merged?: boolean;
        user?: { login?: string } | null;
        head?: { ref?: string } | null;
        base?: { ref?: string } | null;
      }>(`/repos/${fullName}/pulls/${prNumber}`, accessToken);
      const repository = await this.getUserRepository(accessToken, fullName);
      if (!repository) {
        return null;
      }
      return {
        repoFullName: fullName,
        cloneUrl: repository.cloneUrl,
        number: pullRequest.number,
        title: pullRequest.title,
        body: pullRequest.body ?? null,
        state: pullRequest.state,
        url: pullRequest.html_url,
        headRefName: pullRequest.head?.ref?.trim() ?? "",
        baseRefName: pullRequest.base?.ref?.trim() ?? "",
        authorLogin: pullRequest.user?.login?.trim() ?? null,
        isDraft: Boolean(pullRequest.draft),
        merged: Boolean(pullRequest.merged),
      };
    } catch (error) {
      if (error instanceof GitHubAppError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async getInstallationPullRequest(installationId: number, fullName: string, prNumber: number): Promise<GitHubPullRequestRecord | null> {
    const accessToken = await this.createInstallationAccessToken(installationId);
    return await this.getUserPullRequest(accessToken, fullName, prNumber);
  }

  async buildInstallationUrl(organizationLogin: string, state: string): Promise<string> {
    if (!this.isAppConfigured()) {
      throw new GitHubAppError("GitHub App is not configured", 500);
    }
    const app = await this.requestAppJson<{ slug?: string }>("/app");
    if (!app.slug) {
      throw new GitHubAppError("GitHub App slug is unavailable", 500);
    }
    const url = new URL(`${this.authBaseUrl}/apps/${app.slug}/installations/new`);
    url.searchParams.set("state", state);
    void organizationLogin;
    return url.toString();
  }

  private async createInstallationAccessToken(installationId: number): Promise<string> {
    if (!this.appId || !this.appPrivateKey) {
      throw new GitHubAppError("GitHub App is not configured", 500);
    }

    const response = await fetch(`${this.apiBaseUrl}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.createAppJwt()}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    const payload = (await response.json()) as { token?: string; message?: string };
    if (!response.ok || !payload.token) {
      throw new GitHubAppError(payload.message ?? "Unable to mint GitHub installation token", response.status);
    }
    return payload.token;
  }

  private createAppJwt(): string {
    if (!this.appId || !this.appPrivateKey) {
      throw new GitHubAppError("GitHub App is not configured", 500);
    }

    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const now = Math.floor(Date.now() / 1000);
    const payload = base64UrlEncode(
      JSON.stringify({
        iat: now - 60,
        exp: now + 540,
        iss: this.appId,
      }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    signer.end();
    const key = createPrivateKey(this.appPrivateKey);
    const signature = signer.sign(key);
    return `${header}.${payload}.${base64UrlEncode(signature)}`;
  }

  private async requestAppJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.createAppJwt()}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    const payload = (await response.json()) as T | { message?: string };
    if (!response.ok) {
      throw new GitHubAppError(
        typeof payload === "object" && payload && "message" in payload ? (payload.message ?? "GitHub request failed") : "GitHub request failed",
        response.status,
      );
    }
    return payload as T;
  }

  private async paginateApp<T>(path: string): Promise<T[]> {
    let nextUrl = `${this.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const items: T[] = [];

    while (nextUrl) {
      const page = await this.requestAppPage<T>(nextUrl);
      items.push(...page.items);
      nextUrl = page.nextUrl ?? "";
    }

    return items;
  }

  private async requestJson<T>(path: string, accessToken: string): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    const payload = (await response.json()) as T | { message?: string };
    if (!response.ok) {
      throw new GitHubAppError(
        typeof payload === "object" && payload && "message" in payload ? (payload.message ?? "GitHub request failed") : "GitHub request failed",
        response.status,
      );
    }
    return payload as T;
  }

  private async listRepositoryPullRequests(accessToken: string, fullName: string, cloneUrl: string): Promise<GitHubPullRequestRecord[]> {
    const pullRequests = await this.paginate<{
      number: number;
      title: string;
      body?: string | null;
      state: string;
      html_url: string;
      draft?: boolean;
      merged?: boolean;
      user?: { login?: string } | null;
      head?: { ref?: string } | null;
      base?: { ref?: string } | null;
    }>(`/repos/${fullName}/pulls?state=open&per_page=100&sort=updated&direction=desc`, accessToken);

    return pullRequests.map((pullRequest) => ({
      repoFullName: fullName,
      cloneUrl,
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body ?? null,
      state: pullRequest.state,
      url: pullRequest.html_url,
      headRefName: pullRequest.head?.ref?.trim() ?? "",
      baseRefName: pullRequest.base?.ref?.trim() ?? "",
      authorLogin: pullRequest.user?.login?.trim() ?? null,
      isDraft: Boolean(pullRequest.draft),
      merged: Boolean(pullRequest.merged),
    }));
  }

  private async paginate<T>(path: string, accessToken: string): Promise<T[]> {
    let nextUrl = `${this.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const items: T[] = [];

    while (nextUrl) {
      const page = await this.requestPage<T>(nextUrl, accessToken);
      items.push(...page.items);
      nextUrl = page.nextUrl ?? "";
    }

    return items;
  }

  private async requestPage<T>(url: string, accessToken: string): Promise<GitHubPageResponse<T>> {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    const payload = (await response.json()) as T[] | { repositories?: T[]; message?: string };
    if (!response.ok) {
      throw new GitHubAppError(
        typeof payload === "object" && payload && "message" in payload ? (payload.message ?? "GitHub request failed") : "GitHub request failed",
        response.status,
      );
    }

    const items = Array.isArray(payload) ? payload : (payload.repositories ?? []);
    return {
      items,
      nextUrl: parseNextLink(response.headers.get("link")),
    };
  }

  private async requestAppPage<T>(url: string): Promise<GitHubPageResponse<T>> {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.createAppJwt()}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    const payload = (await response.json()) as T[] | { installations?: T[]; message?: string };
    if (!response.ok) {
      throw new GitHubAppError(
        typeof payload === "object" && payload && "message" in payload ? (payload.message ?? "GitHub request failed") : "GitHub request failed",
        response.status,
      );
    }

    const items = Array.isArray(payload) ? payload : (payload.installations ?? []);
    return {
      items,
      nextUrl: parseNextLink(response.headers.get("link")),
    };
  }
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const part of linkHeader.split(",")) {
    const [urlPart, relPart] = part.split(";").map((value) => value.trim());
    if (!urlPart || !relPart || !relPart.includes('rel="next"')) {
      continue;
    }
    return urlPart.replace(/^<|>$/g, "");
  }

  return null;
}

function base64UrlEncode(value: string | Buffer): string {
  const source = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return source.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
