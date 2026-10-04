import { asc, count as sqlCount, desc } from "drizzle-orm";
import { applyJoinToRow, applyJoinToRows, buildWhere, columnFor, materializeRow, persistInput, persistPatch, tableFor } from "../query-helpers.js";

// Exception to the CLAUDE.md queue-for-mutations rule: Better Auth adapter operations
// use direct actions even for mutations. Better Auth runs during OAuth callbacks on the
// HTTP request path, not through the normal organization lifecycle. Routing through the
// queue adds multiple sequential round-trips (each with actor wake-up + step overhead)
// that cause 30-second OAuth callbacks and proxy retry storms. These mutations are simple
// SQLite upserts/deletes with no cross-actor coordination or broadcast side effects.
export const betterAuthActions = {
  // --- Mutation actions ---
  async betterAuthCreateRecord(c, input: { model: string; data: Record<string, unknown> }) {
    const table = tableFor(input.model);
    const persisted = persistInput(input.model, input.data);
    await c.db
      .insert(table)
      .values(persisted as any)
      .run();
    const row = await c.db
      .select()
      .from(table)
      .where(buildWhere(table, [{ field: "id", value: input.data.id }])!)
      .get();
    return materializeRow(input.model, row);
  },

  async betterAuthUpdateRecord(c, input: { model: string; where: any[]; update: Record<string, unknown> }) {
    const table = tableFor(input.model);
    const predicate = buildWhere(table, input.where);
    if (!predicate) throw new Error("betterAuthUpdateRecord requires a where clause");
    await c.db
      .update(table)
      .set(persistPatch(input.model, input.update) as any)
      .where(predicate)
      .run();
    return materializeRow(input.model, await c.db.select().from(table).where(predicate).get());
  },

  async betterAuthUpdateManyRecords(c, input: { model: string; where: any[]; update: Record<string, unknown> }) {
    const table = tableFor(input.model);
    const predicate = buildWhere(table, input.where);
    if (!predicate) throw new Error("betterAuthUpdateManyRecords requires a where clause");
    await c.db
      .update(table)
      .set(persistPatch(input.model, input.update) as any)
      .where(predicate)
      .run();
    const row = await c.db.select({ value: sqlCount() }).from(table).where(predicate).get();
    return row?.value ?? 0;
  },

  async betterAuthDeleteRecord(c, input: { model: string; where: any[] }) {
    const table = tableFor(input.model);
    const predicate = buildWhere(table, input.where);
    if (!predicate) throw new Error("betterAuthDeleteRecord requires a where clause");
    await c.db.delete(table).where(predicate).run();
  },

  async betterAuthDeleteManyRecords(c, input: { model: string; where: any[] }) {
    const table = tableFor(input.model);
    const predicate = buildWhere(table, input.where);
    if (!predicate) throw new Error("betterAuthDeleteManyRecords requires a where clause");
    const rows = await c.db.select().from(table).where(predicate).all();
    await c.db.delete(table).where(predicate).run();
    return rows.length;
  },

  // --- Read actions ---
  async betterAuthFindOneRecord(c, input: { model: string; where: any[]; join?: any }) {
    const table = tableFor(input.model);
    const predicate = buildWhere(table, input.where);
    const row = predicate ? await c.db.select().from(table).where(predicate).get() : await c.db.select().from(table).get();
    return await applyJoinToRow(c, input.model, row ?? null, input.join);
  },

  async betterAuthFindManyRecords(c, input: { model: string; where?: any[]; limit?: number; offset?: number; sortBy?: any; join?: any }) {
    const table = tableFor(input.model);
    const predicate = buildWhere(table, input.where);
    let query: any = c.db.select().from(table);
    if (predicate) {
      query = query.where(predicate);
    }
    if (input.sortBy?.field) {
      const column = columnFor(input.model, table, input.sortBy.field);
      query = query.orderBy(input.sortBy.direction === "asc" ? asc(column) : desc(column));
    }
    if (typeof input.limit === "number") {
      query = query.limit(input.limit);
    }
    if (typeof input.offset === "number") {
      query = query.offset(input.offset);
    }
    const rows = await query.all();
    return await applyJoinToRows(c, input.model, rows, input.join);
  },

  async betterAuthCountRecords(c, input: { model: string; where?: any[] }) {
    const table = tableFor(input.model);
    const predicate = buildWhere(table, input.where);
    const row = predicate
      ? await c.db.select({ value: sqlCount() }).from(table).where(predicate).get()
      : await c.db.select({ value: sqlCount() }).from(table).get();
    return row?.value ?? 0;
  },
};
