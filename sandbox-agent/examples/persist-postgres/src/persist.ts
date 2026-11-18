import { Pool, type PoolConfig } from "pg";
import type { ListEventsRequest, ListPage, ListPageRequest, SessionEvent, SessionPersistDriver, SessionRecord } from "sandbox-agent";

const DEFAULT_LIST_LIMIT = 100;

export interface PostgresSessionPersistDriverOptions {
  connectionString?: string;
  pool?: Pool;
  poolConfig?: PoolConfig;
  schema?: string;
}

export class PostgresSessionPersistDriver implements SessionPersistDriver {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly schema: string;
  private readonly initialized: Promise<void>;

  constructor(options: PostgresSessionPersistDriverOptions = {}) {
    this.schema = normalizeSchema(options.schema ?? "public");

    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool({
        connectionString: options.connectionString,
        ...options.poolConfig,
      });
      this.ownsPool = true;
    }

    this.initialized = this.initialize();
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    await this.ready();

    const result = await this.pool.query<SessionRow>(
      `SELECT id, agent, agent_session_id, last_connection_id, created_at, destroyed_at, sandbox_id, session_init_json, config_options_json, modes_json
       FROM ${this.table("sessions")}
       WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      return undefined;
    }

    return decodeSessionRow(result.rows[0]);
  }

  async listSessions(request: ListPageRequest = {}): Promise<ListPage<SessionRecord>> {
    await this.ready();

    const offset = parseCursor(request.cursor);
    const limit = normalizeLimit(request.limit);

    const rowsResult = await this.pool.query<SessionRow>(
      `SELECT id, agent, agent_session_id, last_connection_id, created_at, destroyed_at, sandbox_id, session_init_json, config_options_json, modes_json
       FROM ${this.table("sessions")}
       ORDER BY created_at ASC, id ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    const countResult = await this.pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${this.table("sessions")}`);
    const total = parseInteger(countResult.rows[0]?.count ?? "0");
    const nextOffset = offset + rowsResult.rows.length;

    return {
      items: rowsResult.rows.map(decodeSessionRow),
      nextCursor: nextOffset < total ? String(nextOffset) : undefined,
    };
  }

  async updateSession(session: SessionRecord): Promise<void> {
    await this.ready();

    await this.pool.query(
      `INSERT INTO ${this.table("sessions")} (
        id, agent, agent_session_id, last_connection_id, created_at, destroyed_at, sandbox_id, session_init_json, config_options_json, modes_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT(id) DO UPDATE SET
        agent = EXCLUDED.agent,
        agent_session_id = EXCLUDED.agent_session_id,
        last_connection_id = EXCLUDED.last_connection_id,
        created_at = EXCLUDED.created_at,
        destroyed_at = EXCLUDED.destroyed_at,
        sandbox_id = EXCLUDED.sandbox_id,
        session_init_json = EXCLUDED.session_init_json,
        config_options_json = EXCLUDED.config_options_json,
        modes_json = EXCLUDED.modes_json`,
      [
        session.id,
        session.agent,
        session.agentSessionId,
        session.lastConnectionId,
        session.createdAt,
        session.destroyedAt ?? null,
        session.sandboxId ?? null,
        session.sessionInit ? JSON.stringify(session.sessionInit) : null,
        session.configOptions ? JSON.stringify(session.configOptions) : null,
        session.modes !== undefined ? JSON.stringify(session.modes) : null,
      ],
    );
  }

  async listEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>> {
    await this.ready();

    const offset = parseCursor(request.cursor);
    const limit = normalizeLimit(request.limit);

    const rowsResult = await this.pool.query<EventRow>(
      `SELECT id, event_index, session_id, created_at, connection_id, sender, payload_json
       FROM ${this.table("events")}
       WHERE session_id = $1
       ORDER BY event_index ASC, id ASC
       LIMIT $2 OFFSET $3`,
      [request.sessionId, limit, offset],
    );

    const countResult = await this.pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${this.table("events")} WHERE session_id = $1`, [
      request.sessionId,
    ]);
    const total = parseInteger(countResult.rows[0]?.count ?? "0");
    const nextOffset = offset + rowsResult.rows.length;

    return {
      items: rowsResult.rows.map(decodeEventRow),
      nextCursor: nextOffset < total ? String(nextOffset) : undefined,
    };
  }

  async insertEvent(_sessionId: string, event: SessionEvent): Promise<void> {
    await this.ready();

    await this.pool.query(
      `INSERT INTO ${this.table("events")} (
        id, event_index, session_id, created_at, connection_id, sender, payload_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(id) DO UPDATE SET
        event_index = EXCLUDED.event_index,
        session_id = EXCLUDED.session_id,
        created_at = EXCLUDED.created_at,
        connection_id = EXCLUDED.connection_id,
        sender = EXCLUDED.sender,
        payload_json = EXCLUDED.payload_json`,
      [event.id, event.eventIndex, event.sessionId, event.createdAt, event.connectionId, event.sender, event.payload],
    );
  }

  async close(): Promise<void> {
    if (!this.ownsPool) {
      return;
    }
    await this.pool.end();
  }

  private async ready(): Promise<void> {
    await this.initialized;
  }

  private table(name: "sessions" | "events"): string {
    return `"${this.schema}"."${name}"`;
  }

  private async initialize(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("sessions")} (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        last_connection_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        destroyed_at BIGINT,
        sandbox_id TEXT,
        session_init_json JSONB,
        config_options_json JSONB,
        modes_json JSONB
      )
    `);

    await this.pool.query(`
      ALTER TABLE ${this.table("sessions")}
      ADD COLUMN IF NOT EXISTS sandbox_id TEXT
    `);

    await this.pool.query(`
      ALTER TABLE ${this.table("sessions")}
      ADD COLUMN IF NOT EXISTS config_options_json JSONB
    `);

    await this.pool.query(`
      ALTER TABLE ${this.table("sessions")}
      ADD COLUMN IF NOT EXISTS modes_json JSONB
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table("events")} (
        id TEXT PRIMARY KEY,
        event_index BIGINT NOT NULL,
        session_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        connection_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        payload_json JSONB NOT NULL
      )
    `);

    await this.pool.query(`
      ALTER TABLE ${this.table("events")}
      ALTER COLUMN id TYPE TEXT USING id::TEXT
    `);

    await this.pool.query(`
      ALTER TABLE ${this.table("events")}
      ADD COLUMN IF NOT EXISTS event_index BIGINT
    `);

    await this.pool.query(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at ASC, id ASC) AS ranked_index
        FROM ${this.table("events")}
      )
      UPDATE ${this.table("events")} AS current_events
      SET event_index = ranked.ranked_index
      FROM ranked
      WHERE current_events.id = ranked.id
        AND current_events.event_index IS NULL
    `);

    await this.pool.query(`
      ALTER TABLE ${this.table("events")}
      ALTER COLUMN event_index SET NOT NULL
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_events_session_order
      ON ${this.table("events")}(session_id, event_index, id)
    `);
  }
}

type SessionRow = {
  id: string;
  agent: string;
  agent_session_id: string;
  last_connection_id: string;
  created_at: string | number;
  destroyed_at: string | number | null;
  sandbox_id: string | null;
  session_init_json: unknown | null;
  config_options_json: unknown | null;
  modes_json: unknown | null;
};

type EventRow = {
  id: string | number;
  event_index: string | number;
  session_id: string;
  created_at: string | number;
  connection_id: string;
  sender: string;
  payload_json: unknown;
};

function decodeSessionRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    agent: row.agent,
    agentSessionId: row.agent_session_id,
    lastConnectionId: row.last_connection_id,
    createdAt: parseInteger(row.created_at),
    destroyedAt: row.destroyed_at === null ? undefined : parseInteger(row.destroyed_at),
    sandboxId: row.sandbox_id ?? undefined,
    sessionInit: row.session_init_json ? (row.session_init_json as SessionRecord["sessionInit"]) : undefined,
    configOptions: row.config_options_json ? (row.config_options_json as SessionRecord["configOptions"]) : undefined,
    modes: row.modes_json ? (row.modes_json as SessionRecord["modes"]) : undefined,
  };
}

function decodeEventRow(row: EventRow): SessionEvent {
  return {
    id: String(row.id),
    eventIndex: parseInteger(row.event_index),
    sessionId: row.session_id,
    createdAt: parseInteger(row.created_at),
    connectionId: row.connection_id,
    sender: parseSender(row.sender),
    payload: row.payload_json as SessionEvent["payload"],
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit ?? 0) < 1) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.floor(limit as number);
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function parseInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer value returned by postgres: ${String(value)}`);
  }
  return parsed;
}

function parseSender(value: string): SessionEvent["sender"] {
  if (value === "agent" || value === "client") {
    return value;
  }
  throw new Error(`Invalid sender value returned by postgres: ${value}`);
}

function normalizeSchema(schema: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`Invalid schema name '${schema}'. Use letters, numbers, and underscores only.`);
  }
  return schema;
}
