import { and, asc, count as sqlCount, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, notInArray, or } from "drizzle-orm";
import { authAccountIndex, authEmailIndex, authSessionIndex, authVerification } from "../db/schema.js";
import { APP_SHELL_ORGANIZATION_ID } from "../constants.js";

function assertAppOrganization(c: any): void {
  if (c.state.organizationId !== APP_SHELL_ORGANIZATION_ID) {
    throw new Error(`App shell action requires organization ${APP_SHELL_ORGANIZATION_ID}, got ${c.state.organizationId}`);
  }
}

function organizationAuthColumn(table: any, field: string): any {
  const column = table[field];
  if (!column) {
    throw new Error(`Unknown auth table field: ${field}`);
  }
  return column;
}

function normalizeAuthValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeAuthValue(entry));
  }
  return value;
}

function organizationAuthClause(table: any, clause: { field: string; value: unknown; operator?: string }): any {
  const column = organizationAuthColumn(table, clause.field);
  const value = normalizeAuthValue(clause.value);
  switch (clause.operator) {
    case "ne":
      return value === null ? isNotNull(column) : ne(column, value as any);
    case "lt":
      return lt(column, value as any);
    case "lte":
      return lte(column, value as any);
    case "gt":
      return gt(column, value as any);
    case "gte":
      return gte(column, value as any);
    case "in":
      return inArray(column, Array.isArray(value) ? (value as any[]) : [value as any]);
    case "not_in":
      return notInArray(column, Array.isArray(value) ? (value as any[]) : [value as any]);
    case "contains":
      return like(column, `%${String(value ?? "")}%`);
    case "starts_with":
      return like(column, `${String(value ?? "")}%`);
    case "ends_with":
      return like(column, `%${String(value ?? "")}`);
    case "eq":
    default:
      return value === null ? isNull(column) : eq(column, value as any);
  }
}

function organizationBetterAuthWhere(table: any, clauses: any[] | undefined): any {
  if (!clauses || clauses.length === 0) {
    return undefined;
  }
  let expr = organizationAuthClause(table, clauses[0]);
  for (const clause of clauses.slice(1)) {
    const next = organizationAuthClause(table, clause);
    expr = clause.connector === "OR" ? or(expr, next) : and(expr, next);
  }
  return expr;
}

export async function betterAuthUpsertSessionIndexMutation(c: any, input: { sessionId: string; sessionToken: string; userId: string }) {
  assertAppOrganization(c);

  const now = Date.now();
  await c.db
    .insert(authSessionIndex)
    .values({
      sessionId: input.sessionId,
      sessionToken: input.sessionToken,
      userId: input.userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: authSessionIndex.sessionId,
      set: {
        sessionToken: input.sessionToken,
        userId: input.userId,
        updatedAt: now,
      },
    })
    .run();
  return await c.db.select().from(authSessionIndex).where(eq(authSessionIndex.sessionId, input.sessionId)).get();
}

export async function betterAuthDeleteSessionIndexMutation(c: any, input: { sessionId?: string; sessionToken?: string }) {
  assertAppOrganization(c);

  const clauses = [
    ...(input.sessionId ? [{ field: "sessionId", value: input.sessionId }] : []),
    ...(input.sessionToken ? [{ field: "sessionToken", value: input.sessionToken }] : []),
  ];
  if (clauses.length === 0) {
    return;
  }
  const predicate = organizationBetterAuthWhere(authSessionIndex, clauses);
  await c.db.delete(authSessionIndex).where(predicate!).run();
}

export async function betterAuthUpsertEmailIndexMutation(c: any, input: { email: string; userId: string }) {
  assertAppOrganization(c);

  const now = Date.now();
  await c.db
    .insert(authEmailIndex)
    .values({
      email: input.email,
      userId: input.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: authEmailIndex.email,
      set: {
        userId: input.userId,
        updatedAt: now,
      },
    })
    .run();
  return await c.db.select().from(authEmailIndex).where(eq(authEmailIndex.email, input.email)).get();
}

export async function betterAuthDeleteEmailIndexMutation(c: any, input: { email: string }) {
  assertAppOrganization(c);
  await c.db.delete(authEmailIndex).where(eq(authEmailIndex.email, input.email)).run();
}

export async function betterAuthUpsertAccountIndexMutation(c: any, input: { id: string; providerId: string; accountId: string; userId: string }) {
  assertAppOrganization(c);

  const now = Date.now();
  await c.db
    .insert(authAccountIndex)
    .values({
      id: input.id,
      providerId: input.providerId,
      accountId: input.accountId,
      userId: input.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: authAccountIndex.id,
      set: {
        providerId: input.providerId,
        accountId: input.accountId,
        userId: input.userId,
        updatedAt: now,
      },
    })
    .run();
  return await c.db.select().from(authAccountIndex).where(eq(authAccountIndex.id, input.id)).get();
}

export async function betterAuthDeleteAccountIndexMutation(c: any, input: { id?: string; providerId?: string; accountId?: string }) {
  assertAppOrganization(c);

  if (input.id) {
    await c.db.delete(authAccountIndex).where(eq(authAccountIndex.id, input.id)).run();
    return;
  }
  if (input.providerId && input.accountId) {
    await c.db
      .delete(authAccountIndex)
      .where(and(eq(authAccountIndex.providerId, input.providerId), eq(authAccountIndex.accountId, input.accountId)))
      .run();
  }
}

export async function betterAuthCreateVerificationMutation(c: any, input: { data: Record<string, unknown> }) {
  assertAppOrganization(c);

  await c.db
    .insert(authVerification)
    .values(input.data as any)
    .run();
  return await c.db
    .select()
    .from(authVerification)
    .where(eq(authVerification.id, input.data.id as string))
    .get();
}

export async function betterAuthUpdateVerificationMutation(c: any, input: { where: any[]; update: Record<string, unknown> }) {
  assertAppOrganization(c);

  const predicate = organizationBetterAuthWhere(authVerification, input.where);
  if (!predicate) {
    return null;
  }
  await c.db
    .update(authVerification)
    .set(input.update as any)
    .where(predicate)
    .run();
  return await c.db.select().from(authVerification).where(predicate).get();
}

export async function betterAuthUpdateManyVerificationMutation(c: any, input: { where: any[]; update: Record<string, unknown> }) {
  assertAppOrganization(c);

  const predicate = organizationBetterAuthWhere(authVerification, input.where);
  if (!predicate) {
    return 0;
  }
  await c.db
    .update(authVerification)
    .set(input.update as any)
    .where(predicate)
    .run();
  const row = await c.db.select({ value: sqlCount() }).from(authVerification).where(predicate).get();
  return row?.value ?? 0;
}

export async function betterAuthDeleteVerificationMutation(c: any, input: { where: any[] }) {
  assertAppOrganization(c);

  const predicate = organizationBetterAuthWhere(authVerification, input.where);
  if (!predicate) {
    return;
  }
  await c.db.delete(authVerification).where(predicate).run();
}

export async function betterAuthDeleteManyVerificationMutation(c: any, input: { where: any[] }) {
  assertAppOrganization(c);

  const predicate = organizationBetterAuthWhere(authVerification, input.where);
  if (!predicate) {
    return 0;
  }
  const rows = await c.db.select().from(authVerification).where(predicate).all();
  await c.db.delete(authVerification).where(predicate).run();
  return rows.length;
}

// Exception to the CLAUDE.md queue-for-mutations rule: Better Auth adapter operations
// use direct actions even for mutations. Better Auth runs during OAuth callbacks on the
// HTTP request path, not through the normal organization lifecycle. Routing through the
// queue adds multiple sequential round-trips (each with actor wake-up + step overhead)
// that cause 30-second OAuth callbacks and proxy retry storms. These mutations are simple
// SQLite upserts/deletes with no cross-actor coordination or broadcast side effects.
export const organizationBetterAuthActions = {
  // --- Mutation actions (called by the Better Auth adapter in better-auth.ts) ---
  async betterAuthUpsertSessionIndex(c: any, input: { sessionId: string; sessionToken: string; userId: string }) {
    return await betterAuthUpsertSessionIndexMutation(c, input);
  },
  async betterAuthDeleteSessionIndex(c: any, input: { sessionId?: string; sessionToken?: string }) {
    await betterAuthDeleteSessionIndexMutation(c, input);
  },
  async betterAuthUpsertEmailIndex(c: any, input: { email: string; userId: string }) {
    return await betterAuthUpsertEmailIndexMutation(c, input);
  },
  async betterAuthDeleteEmailIndex(c: any, input: { email: string }) {
    await betterAuthDeleteEmailIndexMutation(c, input);
  },
  async betterAuthUpsertAccountIndex(c: any, input: { id: string; providerId: string; accountId: string; userId: string }) {
    return await betterAuthUpsertAccountIndexMutation(c, input);
  },
  async betterAuthDeleteAccountIndex(c: any, input: { id?: string; providerId?: string; accountId?: string }) {
    await betterAuthDeleteAccountIndexMutation(c, input);
  },
  async betterAuthCreateVerification(c: any, input: { data: Record<string, unknown> }) {
    return await betterAuthCreateVerificationMutation(c, input);
  },
  async betterAuthUpdateVerification(c: any, input: { where: any[]; update: Record<string, unknown> }) {
    return await betterAuthUpdateVerificationMutation(c, input);
  },
  async betterAuthUpdateManyVerification(c: any, input: { where: any[]; update: Record<string, unknown> }) {
    return await betterAuthUpdateManyVerificationMutation(c, input);
  },
  async betterAuthDeleteVerification(c: any, input: { where: any[] }) {
    await betterAuthDeleteVerificationMutation(c, input);
  },
  async betterAuthDeleteManyVerification(c: any, input: { where: any[] }) {
    return await betterAuthDeleteManyVerificationMutation(c, input);
  },

  // --- Read actions ---
  async betterAuthFindSessionIndex(c: any, input: { sessionId?: string; sessionToken?: string }) {
    assertAppOrganization(c);

    const clauses = [
      ...(input.sessionId ? [{ field: "sessionId", value: input.sessionId }] : []),
      ...(input.sessionToken ? [{ field: "sessionToken", value: input.sessionToken }] : []),
    ];
    if (clauses.length === 0) {
      return null;
    }
    const predicate = organizationBetterAuthWhere(authSessionIndex, clauses);
    return await c.db.select().from(authSessionIndex).where(predicate!).get();
  },

  async betterAuthFindEmailIndex(c: any, input: { email: string }) {
    assertAppOrganization(c);
    return await c.db.select().from(authEmailIndex).where(eq(authEmailIndex.email, input.email)).get();
  },

  async betterAuthFindAccountIndex(c: any, input: { id?: string; providerId?: string; accountId?: string }) {
    assertAppOrganization(c);

    if (input.id) {
      return await c.db.select().from(authAccountIndex).where(eq(authAccountIndex.id, input.id)).get();
    }
    if (!input.providerId || !input.accountId) {
      return null;
    }
    return await c.db
      .select()
      .from(authAccountIndex)
      .where(and(eq(authAccountIndex.providerId, input.providerId), eq(authAccountIndex.accountId, input.accountId)))
      .get();
  },

  async betterAuthFindOneVerification(c: any, input: { where: any[] }) {
    assertAppOrganization(c);

    const predicate = organizationBetterAuthWhere(authVerification, input.where);
    return predicate ? await c.db.select().from(authVerification).where(predicate).get() : null;
  },

  async betterAuthFindManyVerification(c: any, input: { where?: any[]; limit?: number; sortBy?: any; offset?: number }) {
    assertAppOrganization(c);

    const predicate = organizationBetterAuthWhere(authVerification, input.where);
    let query = c.db.select().from(authVerification);
    if (predicate) {
      query = query.where(predicate);
    }
    if (input.sortBy?.field) {
      const column = organizationAuthColumn(authVerification, input.sortBy.field);
      query = query.orderBy(input.sortBy.direction === "asc" ? asc(column) : desc(column));
    }
    if (typeof input.limit === "number") {
      query = query.limit(input.limit);
    }
    if (typeof input.offset === "number") {
      query = query.offset(input.offset);
    }
    return await query.all();
  },

  async betterAuthCountVerification(c: any, input: { where?: any[] }) {
    assertAppOrganization(c);

    const predicate = organizationBetterAuthWhere(authVerification, input.where);
    const row = predicate
      ? await c.db.select({ value: sqlCount() }).from(authVerification).where(predicate).get()
      : await c.db.select({ value: sqlCount() }).from(authVerification).get();
    return row?.value ?? 0;
  },
};
