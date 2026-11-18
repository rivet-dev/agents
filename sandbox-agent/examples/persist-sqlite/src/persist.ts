import Database from "better-sqlite3";
import type { ListEventsRequest, ListPage, ListPageRequest, SessionEvent, SessionPersistDriver, SessionRecord } from "sandbox-agent";

const DEFAULT_LIST_LIMIT = 100;

export interface SQLiteSessionPersistDriverOptions {
  filename?: string;
}

export class SQLiteSessionPersistDriver implements SessionPersistDriver {
  private readonly db: Database.Database;

  constructor(options: SQLiteSessionPersistDriverOptions = {}) {
    this.db = new Database(options.filename ?? ":memory:");
    this.initialize();
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT id, agent, agent_session_id, last_connection_id, created_at, destroyed_at, sandbox_id, session_init_json, config_options_json, modes_json
         FROM sessions WHERE id = ?`,
      )
      .get(id) as SessionRow | undefined;

    if (!row) {
      return undefined;
    }

    return decodeSessionRow(row);
  }

  async listSessions(request: ListPageRequest = {}): Promise<ListPage<SessionRecord>> {
    const offset = parseCursor(request.cursor);
    const limit = normalizeLimit(request.limit);

    const rows = this.db
      .prepare(
        `SELECT id, agent, agent_session_id, last_connection_id, created_at, destroyed_at, sandbox_id, session_init_json, config_options_json, modes_json
         FROM sessions
         ORDER BY created_at ASC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as SessionRow[];

    const countRow = this.db.prepare(`SELECT COUNT(*) as count FROM sessions`).get() as { count: number };
    const nextOffset = offset + rows.length;

    return {
      items: rows.map(decodeSessionRow),
      nextCursor: nextOffset < countRow.count ? String(nextOffset) : undefined,
    };
  }

  async updateSession(session: SessionRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, agent, agent_session_id, last_connection_id, created_at, destroyed_at, sandbox_id, session_init_json, config_options_json, modes_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          agent = excluded.agent,
          agent_session_id = excluded.agent_session_id,
          last_connection_id = excluded.last_connection_id,
          created_at = excluded.created_at,
          destroyed_at = excluded.destroyed_at,
          sandbox_id = excluded.sandbox_id,
          session_init_json = excluded.session_init_json,
          config_options_json = excluded.config_options_json,
          modes_json = excluded.modes_json`,
      )
      .run(
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
      );
  }

  async listEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>> {
    const offset = parseCursor(request.cursor);
    const limit = normalizeLimit(request.limit);

    const rows = this.db
      .prepare(
        `SELECT id, event_index, session_id, created_at, connection_id, sender, payload_json
         FROM events
         WHERE session_id = ?
         ORDER BY event_index ASC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(request.sessionId, limit, offset) as EventRow[];

    const countRow = this.db.prepare(`SELECT COUNT(*) as count FROM events WHERE session_id = ?`).get(request.sessionId) as { count: number };

    const nextOffset = offset + rows.length;

    return {
      items: rows.map(decodeEventRow),
      nextCursor: nextOffset < countRow.count ? String(nextOffset) : undefined,
    };
  }

  async insertEvent(_sessionId: string, event: SessionEvent): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO events (
          id, event_index, session_id, created_at, connection_id, sender, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          event_index = excluded.event_index,
          session_id = excluded.session_id,
          created_at = excluded.created_at,
          connection_id = excluded.connection_id,
          sender = excluded.sender,
          payload_json = excluded.payload_json`,
      )
      .run(event.id, event.eventIndex, event.sessionId, event.createdAt, event.connectionId, event.sender, JSON.stringify(event.payload));
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        last_connection_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        destroyed_at INTEGER,
        sandbox_id TEXT,
        session_init_json TEXT,
        config_options_json TEXT,
        modes_json TEXT
      )
    `);

    const sessionColumns = this.db.prepare(`PRAGMA table_info(sessions)`).all() as TableInfoRow[];
    if (!sessionColumns.some((column) => column.name === "sandbox_id")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN sandbox_id TEXT`);
    }
    if (!sessionColumns.some((column) => column.name === "config_options_json")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN config_options_json TEXT`);
    }
    if (!sessionColumns.some((column) => column.name === "modes_json")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN modes_json TEXT`);
    }

    this.ensureEventsTable();
  }

  private ensureEventsTable(): void {
    const tableInfo = this.db.prepare(`PRAGMA table_info(events)`).all() as TableInfoRow[];
    if (tableInfo.length === 0) {
      this.createEventsTable();
      return;
    }

    const idColumn = tableInfo.find((column) => column.name === "id");
    const hasEventIndex = tableInfo.some((column) => column.name === "event_index");
    const idType = (idColumn?.type ?? "").trim().toUpperCase();
    const idIsText = idType === "TEXT";

    if (!idIsText || !hasEventIndex) {
      this.rebuildEventsTable(hasEventIndex);
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_session_order
      ON events(session_id, event_index, id)
    `);
  }

  private createEventsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        event_index INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        connection_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_order
      ON events(session_id, event_index, id)
    `);
  }

  private rebuildEventsTable(hasEventIndex: boolean): void {
    this.db.exec(`
      ALTER TABLE events RENAME TO events_legacy;
    `);

    this.createEventsTable();

    if (hasEventIndex) {
      this.db.exec(`
        INSERT INTO events (id, event_index, session_id, created_at, connection_id, sender, payload_json)
        SELECT
          CAST(id AS TEXT),
          COALESCE(event_index, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at ASC, id ASC)),
          session_id,
          created_at,
          connection_id,
          sender,
          payload_json
        FROM events_legacy
      `);
    } else {
      this.db.exec(`
        INSERT INTO events (id, event_index, session_id, created_at, connection_id, sender, payload_json)
        SELECT
          CAST(id AS TEXT),
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at ASC, id ASC),
          session_id,
          created_at,
          connection_id,
          sender,
          payload_json
        FROM events_legacy
      `);
    }

    this.db.exec(`DROP TABLE events_legacy`);
  }
}

type SessionRow = {
  id: string;
  agent: string;
  agent_session_id: string;
  last_connection_id: string;
  created_at: number;
  destroyed_at: number | null;
  sandbox_id: string | null;
  session_init_json: string | null;
  config_options_json: string | null;
  modes_json: string | null;
};

type EventRow = {
  id: string;
  event_index: number;
  session_id: string;
  created_at: number;
  connection_id: string;
  sender: "client" | "agent";
  payload_json: string;
};

type TableInfoRow = {
  name: string;
  type: string;
};

function decodeSessionRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    agent: row.agent,
    agentSessionId: row.agent_session_id,
    lastConnectionId: row.last_connection_id,
    createdAt: row.created_at,
    destroyedAt: row.destroyed_at ?? undefined,
    sandboxId: row.sandbox_id ?? undefined,
    sessionInit: row.session_init_json ? (JSON.parse(row.session_init_json) as SessionRecord["sessionInit"]) : undefined,
    configOptions: row.config_options_json ? (JSON.parse(row.config_options_json) as SessionRecord["configOptions"]) : undefined,
    modes: row.modes_json ? (JSON.parse(row.modes_json) as SessionRecord["modes"]) : undefined,
  };
}

function decodeEventRow(row: EventRow): SessionEvent {
  return {
    id: row.id,
    eventIndex: row.event_index,
    sessionId: row.session_id,
    createdAt: row.created_at,
    connectionId: row.connection_id,
    sender: row.sender,
    payload: JSON.parse(row.payload_json),
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
