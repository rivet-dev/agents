# Auth & Identity Simplification: Adopt BetterAuth + Extract User Model

Read `00-end-to-end-async-realtime-plan.md` first for the governing migration order, runtime constraints, and realtime client model this brief assumes.

## Problem

Authentication and user identity are conflated into a single `appSessions` table that serves as the session store, user record, OAuth credential store, navigation state, and onboarding tracker simultaneously. There is no canonical user record — identity fields are denormalized into every session row. BetterAuth env vars exist (`BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`) but the library is not used; all OAuth and session handling is hand-rolled.

### Specific issues

1. **No user table.** Same GitHub user in two browsers = two independent copies of identity fields with no shared record. Org membership, onboarding state, and role are per-session instead of per-user.
2. **Unsigned session tokens.** Session IDs are plain UUIDs in `localStorage`, sent via `x-foundry-session` header. The backend trusts them at face value — no signature verification.
3. **Unstable user IDs.** User ID is `user-${slugify(viewer.login)}` which breaks on GitHub username renames. GitHub numeric `id` is available from the API but not used as the stable key.
4. **Dead BetterAuth references.** `BETTER_AUTH_URL` is used as a URL alias in `app-shell-runtime.ts:65`. `BETTER_AUTH_SECRET` is documented but never read. This creates confusion about what auth system is actually in use.
5. **Overloaded session row.** `appSessions` has 15+ columns mixing auth credentials, user identity, org navigation, onboarding state, and transient OAuth flow state.

## Current Code Context

- Custom OAuth flow: `foundry/packages/backend/src/services/app-github.ts` (`buildAuthorizeUrl`, `exchangeCode`, `getViewer`)
- Session + identity management: `foundry/packages/backend/src/actors/organization/app-shell.ts` (`ensureAppSession`, `updateAppSession`, `initGithubSession`, `syncGithubOrganizations`)
- Session schema: `foundry/packages/backend/src/actors/organization/db/schema.ts` (`appSessions` table)
- Shared types: `foundry/packages/shared/src/app-shell.ts` (`FoundryUser`, `FoundryAppSnapshot`)
- HTTP routes: `foundry/packages/backend/src/index.ts` (`resolveSessionId`, `/v1/auth/github/*`, all `/v1/app/*` routes)
- Frontend session persistence: `foundry/packages/client/src/backend-client.ts` (`persistAppSessionId`, `x-foundry-session` header, `foundrySession` URL param extraction)
- Runtime config: `foundry/packages/backend/src/services/app-shell-runtime.ts` (`BETTER_AUTH_URL` fallback)
- Compose config: `foundry/compose.dev.yaml` (`BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` env vars)
- Self-hosting docs: `docs/deploy/foundry-self-hosting.mdx` (documents both env vars)

## Target State

### BetterAuth owns auth plumbing

- BetterAuth handles GitHub OAuth (authorize URL, code exchange, CSRF state, token storage).
- BetterAuth manages session lifecycle (signed tokens, expiration, revocation).
- BetterAuth creates and maintains `user`, `session`, and `account` tables with proper FKs.
- `BETTER_AUTH_SECRET` is actually used for session signing.
- `BETTER_AUTH_URL` is actually used as the auth callback base URL.

### Custom actor-routed adapter

- BetterAuth uses a custom adapter that routes all DB operations through RivetKit actors.
- Each user has their own actor. BetterAuth's `user`, `session`, and `account` tables live in the per-user actor's SQLite via `c.db`.
- The adapter resolves which actor to target based on the primary key BetterAuth passes for each operation (user ID, session ID, account ID).
- A lightweight **session index** on the app-shell organization actor maps session tokens → user actor identity, so inbound requests can be routed to the correct user actor without knowing the user ID upfront.

### Canonical user record

- Users are identified by GitHub numeric account ID (immutable across renames).
- BetterAuth's `user` table in the per-user actor is the single source of truth for identity.
- App-specific user fields (`eligibleOrganizationIds`, `starterRepoStatus`, `roleLabel`) live in a `userProfiles` table in the same per-user actor, keyed by user ID, not duplicated per session.

### Thin sessions

- Sessions reference a user ID (FK) instead of duplicating identity fields.
- App-specific session state (`activeOrganizationId`) lives in a `sessionState` table in the per-user actor or as BetterAuth session additional fields.
- Transient OAuth flow state (`oauthState`, `oauthStateExpiresAt`) is handled by BetterAuth internally.

### Snapshot projection unchanged

- `FoundryAppSnapshot` and `FoundryUser` types remain the same — they're already the right shape.
- The snapshot builder reads from the user actor's BetterAuth tables + `userProfiles` instead of reading everything from `appSessions`.

## Architecture: Custom Actor-Routed BetterAuth Adapter

### Why a custom adapter

BetterAuth expects a single database. Foundry uses per-actor SQLite — each actor instance gets its own `c.db`. Users each have their own actor, so BetterAuth's `user`, `session`, and `account` records must live inside the correct user actor's database. The adapter must route each BetterAuth DB operation to the right actor based on the primary key.

### Routing challenge: session → user actor

When an HTTP request arrives, the backend has a session token but doesn't know the user ID yet. BetterAuth calls adapter methods like `findSession(sessionId)` to resolve this. But which actor holds that session row?

**Solution: session index on the app-shell organization actor.**

The app-shell organization actor (which already handles auth routing) maintains a lightweight index table:

```
sessionIndex
├── sessionId (text, PK)
├── userActorKey (text) — actor key for the user actor that owns this session
├── createdAt (integer)
```

The adapter flow for session lookup:
1. BetterAuth calls `findSession(sessionId)`.
2. Adapter queries `sessionIndex` on the organization actor to resolve `userActorKey`.
3. Adapter gets the user actor handle and queries BetterAuth's `session` table in that actor's `c.db`.

The adapter flow for user creation (OAuth callback):
1. BetterAuth calls `createUser(userData)`.
2. Adapter resolves the GitHub numeric ID from the user data.
3. Adapter creates/gets the user actor keyed by GitHub ID.
4. Adapter inserts into BetterAuth's `user` table in that actor's `c.db`.
5. When `createSession` follows, adapter writes to the user actor's `session` table AND inserts into the organization actor's `sessionIndex`.

### User actor shape

```text
UserActor (key: ["ws", organizationId, "user", githubNumericId])
├── BetterAuth tables: user, session, account (managed by BetterAuth schema)
├── userProfiles (app-specific: eligibleOrganizationIds, starterRepoStatus, roleLabel)
└── sessionState (app-specific: activeOrganizationId per session)
```

### BetterAuth adapter interface (concrete)

BetterAuth uses `createAdapterFactory` from `"better-auth/adapters"`. The adapter is **model-based, not entity-based** — it receives a `model` string (`"user"`, `"session"`, `"account"`, `"verification"`) and generic CRUD parameters. All methods are **async** and return Promises. The adapter can do arbitrary async work including actor handle resolution and cross-actor messages.

```typescript
// Adapter methods (all async, all receive model name + generic params):
create:     ({ model, data, select? }) => Promise<T>
findOne:    ({ model, where, select?, join? }) => Promise<T | null>
findMany:   ({ model, where, limit?, offset?, sortBy?, join? }) => Promise<T[]>
update:     ({ model, where, update }) => Promise<T | null>
updateMany: ({ model, where, update }) => Promise<number>
delete:     ({ model, where }) => Promise<void>
deleteMany: ({ model, where }) => Promise<number>
count:      ({ model, where }) => Promise<number>
```

The `where` clauses use `{ field, value, operator?, connector? }` objects (operators: `eq`, `ne`, `in`, `contains`, etc.).

#### Routing logic inside the adapter

The adapter must inspect `model` and `where` to determine the target actor:

| Model | Routing strategy |
|-------|-----------------|
| `user` (by id) | User actor key derived directly from user ID |
| `user` (by email) | `emailIndex` on organization actor → user actor key |
| `session` (by token) | `sessionIndex` on organization actor → user actor key |
| `session` (by id) | `sessionIndex` on organization actor → user actor key |
| `session` (by userId) | User actor key derived directly from userId |
| `account` | Always has `userId` in where or data → user actor key |
| `verification` | Organization actor (not user-scoped — used for email verification, password reset) |

On `create` for `session` model: write to user actor's `session` table AND insert into organization actor's `sessionIndex`.
On `delete` for `session` model: delete from user actor's `session` table AND remove from organization actor's `sessionIndex`.

#### Adapter construction

The adapter is instantiated at BetterAuth init time with a closure over the RivetKit registry. It does **not** depend on an ambient actor context — it resolves actor handles on demand via the registry.

```typescript
import { createAdapterFactory } from "better-auth/adapters";

const actorRoutedAdapter = (registry: Registry) => {
  return createAdapterFactory({
    config: {
      adapterId: "rivetkit-actor",
      adapterName: "RivetKit Actor Adapter",
      supportsJSON: false,    // SQLite — auto-serialize JSON
      supportsDates: false,   // SQLite — ISO string conversion
      supportsBooleans: false, // SQLite — 0/1 conversion
    },
    adapter: ({ getModelName, transformInput, transformOutput, transformWhereClause }) => ({
      create: async ({ model, data }) => {
        const actorKey = resolveActorKeyForCreate(model, data);
        const actor = await registry.get("user", actorKey);
        // delegate insert to actor's c.db
        // if model === "session", also write sessionIndex
      },
      findOne: async ({ model, where }) => {
        const actorKey = await resolveActorKeyForQuery(model, where);
        // ...
      },
      // ... remaining methods
    }),
  });
};
```

#### BetterAuth session tokens

BetterAuth uses **opaque session tokens** stored in the `session` table's `token` column. By default, the token is set as a cookie (`better-auth.session_token`). On every request, BetterAuth looks up the session in the DB by token and checks `expiresAt`.

**Cookie caching** can be enabled to reduce DB lookups: the session data is signed (HMAC-SHA256) or encrypted (AES-256) and embedded in the cookie. When the cache is fresh (configurable `maxAge`, e.g., 5 minutes), BetterAuth validates the signature locally without hitting the adapter. This **eliminates the hot-path actor lookup for most requests** — the adapter is only called when the cache expires or on write operations.

```typescript
session: {
  cookieCache: {
    enabled: true,
    maxAge: 5 * 60, // 5 minutes — most requests skip the adapter entirely
    strategy: "compact", // HMAC-signed, minimal size
  },
}
```

#### BetterAuth core tables

Four tables, all in the per-user actor's SQLite (except `verification` which goes on organization actor):

**`user`**: `id`, `name`, `email`, `emailVerified`, `image`, `createdAt`, `updatedAt`
**`session`**: `id`, `token`, `userId`, `expiresAt`, `ipAddress?`, `userAgent?`, `createdAt`, `updatedAt`
**`account`**: `id`, `userId`, `accountId` (GitHub numeric ID), `providerId` ("github"), `accessToken?`, `refreshToken?`, `scope?`, `createdAt`, `updatedAt`
**`verification`**: `id`, `identifier`, `value`, `expiresAt`, `createdAt`, `updatedAt`

For `findUserByEmail`, a secondary index (email → user actor key) is needed on the organization actor alongside `sessionIndex`.

## Implementation Plan

### Phase 0: Spike — custom adapter feasibility

Research confirms:
- BetterAuth adapter methods are **fully async** (`Promise`-based). Arbitrary async work (actor handle resolution, cross-actor messages) is allowed.
- The adapter is instantiated at BetterAuth init time and receives no request context — it's a plain object of async functions. This means the adapter can close over a RivetKit registry reference and resolve actor handles on demand.
- Cookie caching (`cookieCache.enabled: true`) eliminates the adapter hot-path for most read requests — the session is validated from the signed cookie, and the adapter is only called when the cache expires or on writes.

**Remaining spike work:**

1. **Prototype the adapter + user actor end-to-end** — wire up `createAdapterFactory` with a minimal actor-routed implementation. Confirm that BetterAuth's GitHub OAuth flow completes successfully with user/session/account records landing in the correct per-user actor's SQLite.
2. **Verify `findOne` for session model** — confirm the `where` clause BetterAuth passes for session lookup includes the `token` field (not just `id`), so the adapter can route via `sessionIndex` keyed by token.
3. **Measure cookie-cached vs uncached request latency** — confirm that with cookie caching enabled, the adapter is not called on every request, and that the uncached fallback (organization actor index → user actor → session table) is acceptable.

### Phase 1: User actor + adapter infrastructure (no behavior change)

1. **Install `better-auth` package** in `packages/backend`.
2. **Define `UserActor`** with actor key `["ws", organizationId, "user", githubNumericId]`. Include BetterAuth's required tables (`user`, `session`, `account`) plus app-specific tables in its schema.
3. **Create `userProfiles` table** in user actor schema:
   ```
   userProfiles
   ├── userId (text, PK) — GitHub numeric account ID (string form)
   ├── githubLogin (text)
   ├── roleLabel (text)
   ├── eligibleOrganizationIdsJson (text)
   ├── starterRepoStatus (text)
   ├── starterRepoStarredAt (integer, nullable)
   ├── starterRepoSkippedAt (integer, nullable)
   ├── createdAt (integer)
   ├── updatedAt (integer)
   ```
4. **Create `sessionState` table** in user actor schema:
   ```
   sessionState
   ├── sessionId (text, PK) — references BetterAuth session ID
   ├── activeOrganizationId (text, nullable)
   ├── createdAt (integer)
   ├── updatedAt (integer)
   ```
5. **Create `sessionIndex` and `emailIndex` tables** on the app-shell organization actor:
   ```
   sessionIndex
   ├── sessionId (text, PK)
   ├── userActorKey (text)
   ├── createdAt (integer)

   emailIndex
   ├── email (text, PK)
   ├── userActorKey (text)
   ├── updatedAt (integer)
   ```
6. **Implement the custom BetterAuth adapter** that routes operations through the index tables and user actors.
7. **Configure BetterAuth** with GitHub OAuth provider using existing `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` env vars. Wire `BETTER_AUTH_SECRET` for session signing and `BETTER_AUTH_URL` as the auth base URL.
8. **Keep `appSessions` table operational** — no reads/writes change yet.

### Phase 2: Migrate OAuth flow to BetterAuth

1. **Replace `startAppGithubAuth`** — delegate to BetterAuth's GitHub OAuth initiation instead of hand-rolling `buildAuthorizeUrl` + `oauthState` + `oauthStateExpiresAt`.
2. **Replace `completeAppGithubAuth`** — delegate to BetterAuth's callback handler. BetterAuth creates/updates the user record in the user actor and creates a signed session. The adapter writes to `sessionIndex` on the organization actor.
3. **After BetterAuth callback completes**, populate `userProfiles` in the user actor with app-specific fields and enqueue the slow org sync (same background workflow pattern as today).
4. **Replace `signOutApp`** — delegate to BetterAuth session invalidation. Adapter removes entry from `sessionIndex`.
5. **Update `resolveSessionId`** in `index.ts` — validate the session via BetterAuth (which routes through the adapter → `sessionIndex` → user actor). BetterAuth verifies the signature and checks expiration.
6. **Keep `bootstrapAppGithubSession`** (dev-only) — adapt it to create a BetterAuth session from a raw token for local development.

### Phase 3: Migrate reads to new tables

1. **Update `getAppSnapshot`** — read user identity from BetterAuth's user table in the user actor, app-specific fields from `userProfiles`, and active org from `sessionState`.
2. **Update `selectOrganization`** — write to `sessionState` in the user actor instead of `appSessions`.
3. **Update `syncGithubOrganizations`** — write `eligibleOrganizationIds` to `userProfiles` in the user actor instead of `appSessions`. This fixes the multi-session divergence bug.
4. **Update onboarding actions** (`skipAppStarterRepo`, `starAppStarterRepo`) — write to `userProfiles` in the user actor instead of `appSessions`.
5. **Update `FoundryUser.id`** — use GitHub numeric ID (from BetterAuth's `account.providerAccountId`) instead of `user-${slugify(login)}`.

### Phase 4: Frontend migration

1. **Replace `x-foundry-session` header** with BetterAuth's session mechanism (likely a signed cookie or Authorization header, depending on BetterAuth config).
2. **Remove `foundrySession` URL param extraction** from `backend-client.ts` — BetterAuth handles post-OAuth session establishment via cookies.
3. **Remove `localStorage` session persistence** — BetterAuth manages this via HTTP-only cookies.
4. **Update `signInWithGithub`** — redirect to BetterAuth's auth endpoint instead of `/v1/auth/github/start`.

### Phase 5: Cleanup

1. **Drop `appSessions` table** (migration).
2. **Remove hand-rolled OAuth functions** from `app-shell.ts`: `ensureAppSession`, `updateAppSession`, `initGithubSession`, `encodeOauthState`, `decodeOauthState`, `requireAppSessionRow`, `requireSignedInSession`.
3. **Remove `buildAuthorizeUrl` and `exchangeCode`** from `GitHubAppClient` (keep `getViewer`, installation token methods, webhook verification).
4. **Update `foundry-self-hosting.mdx`** — document `BETTER_AUTH_SECRET` as required for session signing (already documented, now actually true).
5. **Remove `BETTER_AUTH_URL` fallback** from `app-shell-runtime.ts` — BetterAuth reads it directly.

## Constraints

- **Actor-routed adapter.** BetterAuth does not natively support per-user actor databases. The custom adapter must route every DB operation to the correct actor. This adds a layer of indirection and latency (actor handle resolution + message) on adapter calls.
- **Session index cost is mitigated by cookie caching.** With `cookieCache` enabled, BetterAuth validates sessions from a signed cookie on most requests — the adapter (and thus the `sessionIndex` lookup + user actor round-trip) is only called when the cache expires or on writes. Without caching, every authenticated request would hit the organization actor's `sessionIndex` table then the user actor.
- **Two-actor write on session create/destroy.** Creating or destroying a session requires writing to both the user actor (BetterAuth's `session` table) and the organization actor (`sessionIndex`). These must be consistent — if the user actor write succeeds but the index write fails, the session exists but is unreachable.
- **Background org sync pattern must be preserved.** The fast-path/slow-path split (`initGithubSession` returns immediately, `syncGithubOrganizations` runs in workflow queue) is critical for avoiding proxy timeout retries. BetterAuth handles the OAuth exchange, but the org sync stays as a background workflow.
- **`GitHubAppClient` is still needed.** BetterAuth replaces the OAuth user-auth flow, but installation tokens, webhook verification, repo listing, and org listing are GitHub App operations that BetterAuth does not cover.
- **User ID migration.** Changing user IDs from `user-${slugify(login)}` to GitHub numeric IDs affects `organizationMembers`, `seatAssignments`, and any cross-actor references to user IDs. Existing data needs a migration path.
- **`findUserByEmail` requires a secondary index.** BetterAuth sometimes looks up users by email (e.g., account linking). An `emailIndex` table on the organization actor is needed. This must be kept in sync with the user actor's email field.

## Risk Assessment

- **Adapter call context — RESOLVED.** Research confirms BetterAuth adapter methods are plain async functions with no request context dependency. The adapter closes over the RivetKit registry at init time and resolves actor handles on demand. No ambient `c` context needed.
- **Hot-path latency — MITIGATED.** Cookie caching (`cookieCache` with `strategy: "compact"`) means most authenticated requests validate the session from a signed cookie without calling the adapter at all. The adapter (and thus the actor round-trip) is only hit when the cache expires (configurable, e.g., every 5 minutes) or on writes. This makes the session index + user actor lookup acceptable.
- **Two-actor consistency.** Session create/destroy touches two actors (user actor + organization index). If either write fails, the system is in an inconsistent state. Recommended: write index first, then user actor. A dangling index entry pointing to a nonexistent session is benign — BetterAuth treats it as "session not found" and the user just re-authenticates.
- **Cookie vs header auth.** BetterAuth defaults to HTTP-only cookies (`better-auth.session_token`). The current system uses a custom `x-foundry-session` header with `localStorage`. BetterAuth supports `bearer` token mode for programmatic clients via its `bearer` plugin. Enable both for browser + API access.
- **Dev bootstrap flow.** `bootstrapAppGithubSession` bypasses the normal OAuth flow for local development. BetterAuth supports programmatic session creation via its internal adapter — the dev path can call the adapter's `create` method directly for the `session` and `account` models.
- **Actor lifecycle for users.** User actors are long-lived but low-traffic. RivetKit will idle/unload them. With cookie caching, cold-start only happens when the cache expires — not on every request. Acceptable.

## Suggested Implementation Order

1. **Phase 0 spike** — confirm adapter feasibility (go/no-go gate)
2. Phase 1 (user actor + adapter infrastructure, no behavior change)
3. Phase 2 (OAuth migration)
4. Phase 3 (read path migration)
5. Phase 4 (frontend migration)
6. Phase 5 (cleanup)

Phases 2-4 can be deployed incrementally. Each phase should leave the system fully functional — no big-bang cutover.

## Alternative: Fix Without BetterAuth

If the BetterAuth + actor SQLite spike fails, the same goals can be achieved without BetterAuth:

1. Extract `userProfiles` and `sessionState` tables (same as Phase 1).
2. Sign session tokens with HMAC using `BETTER_AUTH_SECRET` (rename to `SESSION_SECRET`).
3. Use GitHub numeric ID as user PK.
4. Keep the custom OAuth flow but thin it out.
5. Drop `appSessions` once migration is complete.

This is more code to maintain but avoids the BetterAuth integration risk.
