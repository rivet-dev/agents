import { betterAuth } from "better-auth";
import { createAdapterFactory } from "better-auth/adapters";
import { APP_SHELL_ORGANIZATION_ID } from "../actors/organization/constants.js";
import { organizationKey, userKey } from "../actors/keys.js";
import { logger } from "../logging.js";

const AUTH_BASE_PATH = "/v1/auth";
const SESSION_COOKIE = "better-auth.session_token";

let betterAuthService: BetterAuthService | null = null;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function buildCookieHeaders(sessionToken: string): Headers {
  return new Headers({
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
  });
}

async function readJsonSafe(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callAuthEndpoint(auth: any, url: string, init?: RequestInit): Promise<Response> {
  return await auth.handler(new Request(url, init));
}

function resolveRouteUserId(organization: any, resolved: any): string | null {
  if (!resolved) {
    return null;
  }
  if (typeof resolved === "string") {
    return resolved;
  }
  if (typeof resolved.userId === "string" && resolved.userId.length > 0) {
    return resolved.userId;
  }
  if (typeof resolved.id === "string" && resolved.id.length > 0) {
    return resolved.id;
  }
  return null;
}

export interface BetterAuthService {
  auth: any;
  resolveSession(headers: Headers): Promise<{ session: any; user: any } | null>;
  signOut(headers: Headers): Promise<Response>;
  getAuthState(sessionId: string): Promise<any | null>;
  upsertUserProfile(userId: string, patch: Record<string, unknown>): Promise<any>;
  setActiveOrganization(sessionId: string, activeOrganizationId: string | null): Promise<any>;
  getAccessTokenForSession(sessionId: string): Promise<{ accessToken: string; scopes: string[] } | null>;
}

export function initBetterAuthService(actorClient: any, options: { apiUrl: string; appUrl: string }): BetterAuthService {
  if (betterAuthService) {
    return betterAuthService;
  }

  // getOrCreate is intentional here: the adapter runs during Better Auth callbacks
  // which can fire before any explicit create path. The app organization and user
  // actors must exist by the time the adapter needs them.
  const appOrganization = () =>
    actorClient.organization.getOrCreate(organizationKey(APP_SHELL_ORGANIZATION_ID), {
      createWithInput: APP_SHELL_ORGANIZATION_ID,
    });

  // getOrCreate is intentional: Better Auth creates user records during OAuth
  // callbacks, so the user actor must be lazily provisioned on first access.
  const getUser = async (userId: string) =>
    await actorClient.user.getOrCreate(userKey(userId), {
      createWithInput: { userId },
    });

  const adapter = createAdapterFactory({
    config: {
      adapterId: "rivetkit-actor",
      adapterName: "RivetKit Actor Adapter",
      supportsBooleans: false,
      supportsDates: false,
      supportsJSON: false,
    },
    adapter: ({ transformInput, transformOutput, transformWhereClause }) => {
      const resolveUserIdForQuery = async (model: string, where?: any[], data?: Record<string, unknown>): Promise<string | null> => {
        const clauses = where ?? [];
        const direct = (field: string) => clauses.find((entry) => entry.field === field)?.value;

        if (model === "user") {
          const fromId = direct("id") ?? data?.id;
          if (typeof fromId === "string" && fromId.length > 0) {
            return fromId;
          }
          const email = direct("email");
          if (typeof email === "string" && email.length > 0) {
            const organization = await appOrganization();
            const resolved = await organization.betterAuthFindEmailIndex({ email: email.toLowerCase() });
            return resolveRouteUserId(organization, resolved);
          }
          return null;
        }

        if (model === "session") {
          const fromUserId = direct("userId") ?? data?.userId;
          if (typeof fromUserId === "string" && fromUserId.length > 0) {
            return fromUserId;
          }
          const sessionId = direct("id") ?? data?.id;
          const sessionToken = direct("token") ?? data?.token;
          if (typeof sessionId === "string" || typeof sessionToken === "string") {
            const organization = await appOrganization();
            const resolved = await organization.betterAuthFindSessionIndex({
              ...(typeof sessionId === "string" ? { sessionId } : {}),
              ...(typeof sessionToken === "string" ? { sessionToken } : {}),
            });
            return resolveRouteUserId(organization, resolved);
          }
          return null;
        }

        if (model === "account") {
          const fromUserId = direct("userId") ?? data?.userId;
          if (typeof fromUserId === "string" && fromUserId.length > 0) {
            return fromUserId;
          }
          const accountRecordId = direct("id") ?? data?.id;
          const providerId = direct("providerId") ?? data?.providerId;
          const accountId = direct("accountId") ?? data?.accountId;
          const organization = await appOrganization();
          if (typeof accountRecordId === "string" && accountRecordId.length > 0) {
            const resolved = await organization.betterAuthFindAccountIndex({ id: accountRecordId });
            return resolveRouteUserId(organization, resolved);
          }
          if (typeof providerId === "string" && providerId.length > 0 && typeof accountId === "string" && accountId.length > 0) {
            const resolved = await organization.betterAuthFindAccountIndex({ providerId, accountId });
            return resolveRouteUserId(organization, resolved);
          }
          return null;
        }

        return null;
      };

      return {
        options: {
          useDatabaseGeneratedIds: false,
        },

        create: async ({ model, data }) => {
          const transformed = await transformInput(data, model, "create", true);
          if (model === "verification") {
            const organization = await appOrganization();
            return await organization.betterAuthCreateVerification({ data: transformed });
          }

          const userId = await resolveUserIdForQuery(model, undefined, transformed);
          if (!userId) {
            throw new Error(`Unable to resolve auth actor for create(${model})`);
          }

          const userActor = await getUser(userId);
          const created = await userActor.betterAuthCreateRecord({ model, data: transformed });
          const organization = await appOrganization();

          if (model === "user" && typeof transformed.email === "string" && transformed.email.length > 0) {
            await organization.betterAuthUpsertEmailIndex({
              email: transformed.email.toLowerCase(),
              userId,
            });
          }

          if (model === "session") {
            await organization.betterAuthUpsertSessionIndex({
              sessionId: String(created.id),
              sessionToken: String(created.token),
              userId,
            });
          }

          if (model === "account") {
            await organization.betterAuthUpsertAccountIndex({
              id: String(created.id),
              providerId: String(created.providerId),
              accountId: String(created.accountId),
              userId,
            });
          }

          return (await transformOutput(created, model)) as any;
        },

        findOne: async ({ model, where, join }) => {
          const transformedWhere = transformWhereClause({ model, where, action: "findOne" });
          if (model === "verification") {
            const organization = await appOrganization();
            return await organization.betterAuthFindOneVerification({ where: transformedWhere, join });
          }

          const userId = await resolveUserIdForQuery(model, transformedWhere);
          if (!userId) {
            return null;
          }

          const userActor = await getUser(userId);
          const found = await userActor.betterAuthFindOneRecord({ model, where: transformedWhere, join });
          return found ? ((await transformOutput(found, model, undefined, join)) as any) : null;
        },

        findMany: async ({ model, where, limit, sortBy, offset, join }) => {
          const transformedWhere = transformWhereClause({ model, where, action: "findMany" });
          if (model === "verification") {
            const organization = await appOrganization();
            return await organization.betterAuthFindManyVerification({
              where: transformedWhere,
              limit,
              sortBy,
              offset,
              join,
            });
          }

          if (model === "session") {
            const tokenClause = transformedWhere?.find((entry: any) => entry.field === "token" && entry.operator === "in");
            if (tokenClause && Array.isArray(tokenClause.value)) {
              const organization = await appOrganization();
              const resolved = await Promise.all(
                (tokenClause.value as string[]).map(async (sessionToken: string) => ({
                  sessionToken,
                  route: await organization.betterAuthFindSessionIndex({ sessionToken }),
                })),
              );
              const byUser = new Map<string, string[]>();
              for (const item of resolved) {
                if (!item.route?.userId) {
                  continue;
                }
                const tokens = byUser.get(item.route.userId) ?? [];
                tokens.push(item.sessionToken);
                byUser.set(item.route.userId, tokens);
              }

              const rows = [];
              for (const [userId, tokens] of byUser) {
                const userActor = await getUser(userId);
                const scopedWhere = transformedWhere.map((entry: any) =>
                  entry.field === "token" && entry.operator === "in" ? { ...entry, value: tokens } : entry,
                );
                const found = await userActor.betterAuthFindManyRecords({ model, where: scopedWhere, limit, sortBy, offset, join });
                rows.push(...found);
              }
              return await Promise.all(rows.map(async (row: any) => await transformOutput(row, model, undefined, join)));
            }
          }

          const userId = await resolveUserIdForQuery(model, transformedWhere);
          if (!userId) {
            return [];
          }

          const userActor = await getUser(userId);
          const found = await userActor.betterAuthFindManyRecords({ model, where: transformedWhere, limit, sortBy, offset, join });
          return await Promise.all(found.map(async (row: any) => await transformOutput(row, model, undefined, join)));
        },

        update: async ({ model, where, update }) => {
          const transformedWhere = transformWhereClause({ model, where, action: "update" });
          const transformedUpdate = (await transformInput(update as Record<string, unknown>, model, "update", true)) as Record<string, unknown>;
          if (model === "verification") {
            const organization = await appOrganization();
            return await organization.betterAuthUpdateVerification({
              where: transformedWhere,
              update: transformedUpdate,
            });
          }

          const userId = await resolveUserIdForQuery(model, transformedWhere, transformedUpdate);
          if (!userId) {
            return null;
          }

          const userActor = await getUser(userId);
          const before =
            model === "user"
              ? await userActor.betterAuthFindOneRecord({ model, where: transformedWhere })
              : model === "account"
                ? await userActor.betterAuthFindOneRecord({ model, where: transformedWhere })
                : model === "session"
                  ? await userActor.betterAuthFindOneRecord({ model, where: transformedWhere })
                  : null;
          const updated = await userActor.betterAuthUpdateRecord({
            model,
            where: transformedWhere,
            update: transformedUpdate,
          });
          const organization = await appOrganization();

          if (model === "user" && updated) {
            if (before?.email && before.email !== updated.email) {
              await organization.betterAuthDeleteEmailIndex({
                email: before.email.toLowerCase(),
              });
            }
            if (updated.email) {
              await organization.betterAuthUpsertEmailIndex({
                email: updated.email.toLowerCase(),
                userId,
              });
            }
          }

          if (model === "session" && updated) {
            await organization.betterAuthUpsertSessionIndex({
              sessionId: String(updated.id),
              sessionToken: String(updated.token),
              userId,
            });
          }

          if (model === "account" && updated) {
            await organization.betterAuthUpsertAccountIndex({
              id: String(updated.id),
              providerId: String(updated.providerId),
              accountId: String(updated.accountId),
              userId,
            });
          }

          return updated ? ((await transformOutput(updated, model)) as any) : null;
        },

        updateMany: async ({ model, where, update }) => {
          const transformedWhere = transformWhereClause({ model, where, action: "updateMany" });
          const transformedUpdate = (await transformInput(update as Record<string, unknown>, model, "update", true)) as Record<string, unknown>;
          if (model === "verification") {
            const organization = await appOrganization();
            return await organization.betterAuthUpdateManyVerification({
              where: transformedWhere,
              update: transformedUpdate,
            });
          }

          const userId = await resolveUserIdForQuery(model, transformedWhere, transformedUpdate);
          if (!userId) {
            return 0;
          }

          const userActor = await getUser(userId);
          return await userActor.betterAuthUpdateManyRecords({
            model,
            where: transformedWhere,
            update: transformedUpdate,
          });
        },

        delete: async ({ model, where }) => {
          const transformedWhere = transformWhereClause({ model, where, action: "delete" });
          if (model === "verification") {
            const organization = await appOrganization();
            await organization.betterAuthDeleteVerification({ where: transformedWhere });
            return;
          }

          const userId = await resolveUserIdForQuery(model, transformedWhere);
          if (!userId) {
            return;
          }

          const userActor = await getUser(userId);
          const organization = await appOrganization();
          const before = await userActor.betterAuthFindOneRecord({ model, where: transformedWhere });
          await userActor.betterAuthDeleteRecord({ model, where: transformedWhere });

          if (model === "session" && before) {
            await organization.betterAuthDeleteSessionIndex({
              sessionId: before.id,
              sessionToken: before.token,
            });
          }

          if (model === "account" && before) {
            await organization.betterAuthDeleteAccountIndex({
              id: before.id,
              providerId: before.providerId,
              accountId: before.accountId,
            });
          }

          if (model === "user" && before?.email) {
            await organization.betterAuthDeleteEmailIndex({
              email: before.email.toLowerCase(),
            });
          }
        },

        deleteMany: async ({ model, where }) => {
          const transformedWhere = transformWhereClause({ model, where, action: "deleteMany" });
          if (model === "verification") {
            const organization = await appOrganization();
            return await organization.betterAuthDeleteManyVerification({ where: transformedWhere });
          }

          if (model === "session") {
            const userId = await resolveUserIdForQuery(model, transformedWhere);
            if (!userId) {
              return 0;
            }
            const userActor = await getUser(userId);
            const organization = await appOrganization();
            const sessions = await userActor.betterAuthFindManyRecords({ model, where: transformedWhere, limit: 5000 });
            const deleted = await userActor.betterAuthDeleteManyRecords({ model, where: transformedWhere });
            for (const session of sessions) {
              await organization.betterAuthDeleteSessionIndex({
                sessionId: session.id,
                sessionToken: session.token,
              });
            }
            return deleted;
          }

          const userId = await resolveUserIdForQuery(model, transformedWhere);
          if (!userId) {
            return 0;
          }

          const userActor = await getUser(userId);
          return await userActor.betterAuthDeleteManyRecords({ model, where: transformedWhere });
        },

        count: async ({ model, where }) => {
          const transformedWhere = transformWhereClause({ model, where, action: "count" });
          if (model === "verification") {
            const organization = await appOrganization();
            return await organization.betterAuthCountVerification({ where: transformedWhere });
          }

          const userId = await resolveUserIdForQuery(model, transformedWhere);
          if (!userId) {
            return 0;
          }

          const userActor = await getUser(userId);
          return await userActor.betterAuthCountRecords({ model, where: transformedWhere });
        },
      };
    },
  });

  const auth = betterAuth({
    baseURL: stripTrailingSlash(process.env.BETTER_AUTH_URL ?? options.apiUrl),
    basePath: AUTH_BASE_PATH,
    secret: requireEnv("BETTER_AUTH_SECRET"),
    database: adapter,
    trustedOrigins: [stripTrailingSlash(options.appUrl), stripTrailingSlash(options.apiUrl)],
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
        strategy: "compact",
      },
    },
    onAPIError: {
      errorURL: stripTrailingSlash(options.appUrl) + "/signin",
    },
    socialProviders: {
      github: {
        clientId: requireEnv("GITHUB_CLIENT_ID"),
        clientSecret: requireEnv("GITHUB_CLIENT_SECRET"),
        scope: ["read:org", "repo"],
        redirectURI: process.env.GITHUB_REDIRECT_URI || undefined,
      },
    },
  });

  betterAuthService = {
    auth,

    async resolveSession(headers: Headers) {
      return (await auth.api.getSession({ headers })) ?? null;
    },

    async signOut(headers: Headers) {
      return await callAuthEndpoint(auth, `${stripTrailingSlash(process.env.BETTER_AUTH_URL ?? options.apiUrl)}${AUTH_BASE_PATH}/sign-out`, {
        method: "POST",
        headers,
      });
    },

    async getAuthState(sessionId: string) {
      const organization = await appOrganization();
      const route = await organization.betterAuthFindSessionIndex({ sessionId });
      if (!route?.userId) {
        return null;
      }
      const userActor = await getUser(route.userId);
      return await userActor.getAppAuthState({ sessionId });
    },

    async upsertUserProfile(userId: string, patch: Record<string, unknown>) {
      const userActor = await getUser(userId);
      return await userActor.upsertProfile({ userId, patch });
    },

    async setActiveOrganization(sessionId: string, activeOrganizationId: string | null) {
      const authState = await this.getAuthState(sessionId);
      if (!authState?.user?.id) {
        throw new Error(`Unknown auth session ${sessionId}`);
      }
      const userActor = await getUser(authState.user.id);
      return await userActor.upsertSessionState({ sessionId, activeOrganizationId });
    },

    async getAccessTokenForSession(sessionId: string) {
      // Read the GitHub access token directly from the account record stored in the
      // auth user actor. Better Auth's internal /get-access-token endpoint requires
      // session middleware resolution which fails for server-side internal calls (403),
      // so we bypass it and read the stored token from our adapter layer directly.
      const authState = await this.getAuthState(sessionId);
      if (!authState?.user?.id || !authState?.accounts) {
        return null;
      }

      const githubAccount = authState.accounts.find((account: any) => account.providerId === "github");
      if (!githubAccount?.accessToken) {
        logger.warn({ sessionId, userId: authState.user.id }, "get_access_token_no_github_account");
        return null;
      }

      return {
        accessToken: githubAccount.accessToken,
        scopes: githubAccount.scope ? githubAccount.scope.split(/[, ]+/) : [],
      };
    },
  };

  return betterAuthService;
}

export function getBetterAuthService(): BetterAuthService {
  if (!betterAuthService) {
    throw new Error("BetterAuth service is not initialized");
  }
  return betterAuthService;
}
