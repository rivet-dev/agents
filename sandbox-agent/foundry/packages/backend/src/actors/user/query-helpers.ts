import { and, eq, inArray, isNotNull, isNull, like, lt, lte, gt, gte, ne, notInArray, or } from "drizzle-orm";
import { authAccounts, authSessions, authUsers, sessionState, userProfiles, userTaskState } from "./db/schema.js";

export const userTables = {
  user: authUsers,
  session: authSessions,
  account: authAccounts,
  userProfiles,
  sessionState,
  userTaskState,
} as const;

export function tableFor(model: string) {
  const table = userTables[model as keyof typeof userTables];
  if (!table) {
    throw new Error(`Unsupported user model: ${model}`);
  }
  return table as any;
}

function dbFieldFor(model: string, field: string): string {
  if (model === "user" && field === "id") {
    return "authUserId";
  }
  return field;
}

export function materializeRow(model: string, row: any) {
  if (!row || model !== "user") {
    return row;
  }

  const { id: _singletonId, authUserId, ...rest } = row;
  return {
    id: authUserId,
    ...rest,
  };
}

export function persistInput(model: string, data: Record<string, unknown>) {
  if (model !== "user") {
    return data;
  }

  const { id, ...rest } = data;
  return {
    id: 1,
    authUserId: id,
    ...rest,
  };
}

export function persistPatch(model: string, data: Record<string, unknown>) {
  if (model !== "user") {
    return data;
  }

  const { id, ...rest } = data;
  return {
    ...(id !== undefined ? { authUserId: id } : {}),
    ...rest,
  };
}

export function columnFor(model: string, table: any, field: string) {
  const column = table[dbFieldFor(model, field)];
  if (!column) {
    throw new Error(`Unsupported user field: ${model}.${field}`);
  }
  return column;
}

export function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry));
  }
  return value;
}

export function clauseToExpr(table: any, clause: any) {
  const model = table === authUsers ? "user" : table === authSessions ? "session" : table === authAccounts ? "account" : "";
  const column = columnFor(model, table, clause.field);
  const value = normalizeValue(clause.value);

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

export function buildWhere(table: any, where: any[] | undefined) {
  if (!where || where.length === 0) {
    return undefined;
  }

  let expr = clauseToExpr(table, where[0]);
  for (const clause of where.slice(1)) {
    const next = clauseToExpr(table, clause);
    expr = clause.connector === "OR" ? or(expr, next) : and(expr, next);
  }
  return expr;
}

export function applyJoinToRow(c: any, model: string, row: any, join: any) {
  const materialized = materializeRow(model, row);
  if (!materialized || !join) {
    return materialized;
  }

  if (model === "session" && join.user) {
    return c.db
      .select()
      .from(authUsers)
      .where(eq(authUsers.authUserId, materialized.userId))
      .get()
      .then((user: any) => ({ ...materialized, user: materializeRow("user", user) ?? null }));
  }

  if (model === "account" && join.user) {
    return c.db
      .select()
      .from(authUsers)
      .where(eq(authUsers.authUserId, materialized.userId))
      .get()
      .then((user: any) => ({ ...materialized, user: materializeRow("user", user) ?? null }));
  }

  if (model === "user" && join.account) {
    return c.db
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.userId, materialized.id))
      .all()
      .then((accounts: any[]) => ({ ...materialized, account: accounts }));
  }

  return Promise.resolve(materialized);
}

export async function applyJoinToRows(c: any, model: string, rows: any[], join: any) {
  if (!join || rows.length === 0) {
    return rows.map((row) => materializeRow(model, row));
  }

  if (model === "session" && join.user) {
    const userIds = [...new Set(rows.map((row) => row.userId).filter(Boolean))];
    const users = userIds.length > 0 ? await c.db.select().from(authUsers).where(inArray(authUsers.authUserId, userIds)).all() : [];
    const userMap = new Map(users.map((user: any) => [user.authUserId, materializeRow("user", user)]));
    return rows.map((row) => ({ ...row, user: userMap.get(row.userId) ?? null }));
  }

  if (model === "account" && join.user) {
    const userIds = [...new Set(rows.map((row) => row.userId).filter(Boolean))];
    const users = userIds.length > 0 ? await c.db.select().from(authUsers).where(inArray(authUsers.authUserId, userIds)).all() : [];
    const userMap = new Map(users.map((user: any) => [user.authUserId, materializeRow("user", user)]));
    return rows.map((row) => ({ ...row, user: userMap.get(row.userId) ?? null }));
  }

  if (model === "user" && join.account) {
    const materializedRows = rows.map((row) => materializeRow("user", row));
    const userIds = materializedRows.map((row) => row.id);
    const accounts = userIds.length > 0 ? await c.db.select().from(authAccounts).where(inArray(authAccounts.userId, userIds)).all() : [];
    const accountsByUserId = new Map<string, any[]>();
    for (const account of accounts) {
      const entries = accountsByUserId.get(account.userId) ?? [];
      entries.push(account);
      accountsByUserId.set(account.userId, entries);
    }
    return materializedRows.map((row) => ({ ...row, account: accountsByUserId.get(row.id) ?? [] }));
  }

  return rows.map((row) => materializeRow(model, row));
}
