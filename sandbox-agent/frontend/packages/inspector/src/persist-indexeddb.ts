import type { ListEventsRequest, ListPage, ListPageRequest, SessionEvent, SessionPersistDriver, SessionRecord } from "sandbox-agent";

const DEFAULT_DB_NAME = "sandbox-agent-session-store";
const DEFAULT_DB_VERSION = 2;
const SESSIONS_STORE = "sessions";
const EVENTS_STORE = "events";
const EVENTS_BY_SESSION_INDEX = "by_session_index";
const DEFAULT_LIST_LIMIT = 100;

export interface IndexedDbSessionPersistDriverOptions {
  databaseName?: string;
  databaseVersion?: number;
  indexedDb?: IDBFactory;
}

export class IndexedDbSessionPersistDriver implements SessionPersistDriver {
  private readonly indexedDb: IDBFactory;
  private readonly dbName: string;
  private readonly dbVersion: number;
  private readonly dbPromise: Promise<IDBDatabase>;

  constructor(options: IndexedDbSessionPersistDriverOptions = {}) {
    const indexedDb = options.indexedDb ?? globalThis.indexedDB;
    if (!indexedDb) {
      throw new Error("IndexedDB is not available in this runtime.");
    }

    this.indexedDb = indexedDb;
    this.dbName = options.databaseName ?? DEFAULT_DB_NAME;
    this.dbVersion = options.databaseVersion ?? DEFAULT_DB_VERSION;
    this.dbPromise = this.openDatabase();
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const db = await this.dbPromise;
    const row = await requestToPromise<IDBValidKey | SessionRow | undefined>(db.transaction(SESSIONS_STORE, "readonly").objectStore(SESSIONS_STORE).get(id));
    if (!row || typeof row !== "object") {
      return undefined;
    }
    return decodeSessionRow(row as SessionRow);
  }

  async listSessions(request: ListPageRequest = {}): Promise<ListPage<SessionRecord>> {
    const db = await this.dbPromise;
    const rows = await getAllRows<SessionRow>(db, SESSIONS_STORE);

    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt;
      }
      return a.id.localeCompare(b.id);
    });

    const offset = parseCursor(request.cursor);
    const limit = normalizeLimit(request.limit);
    const slice = rows.slice(offset, offset + limit).map(decodeSessionRow);
    const nextOffset = offset + slice.length;

    return {
      items: slice,
      nextCursor: nextOffset < rows.length ? String(nextOffset) : undefined,
    };
  }

  async updateSession(session: SessionRecord): Promise<void> {
    const db = await this.dbPromise;
    await transactionPromise(db, [SESSIONS_STORE], "readwrite", (tx) => {
      tx.objectStore(SESSIONS_STORE).put(encodeSessionRow(session));
    });
  }

  async listEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>> {
    const db = await this.dbPromise;
    const rows = (await getAllRows<EventRow>(db, EVENTS_STORE)).filter((row) => row.sessionId === request.sessionId).sort(compareEventRowsByOrder);

    const offset = parseCursor(request.cursor);
    const limit = normalizeLimit(request.limit);
    const slice = rows.slice(offset, offset + limit).map(decodeEventRow);
    const nextOffset = offset + slice.length;

    return {
      items: slice,
      nextCursor: nextOffset < rows.length ? String(nextOffset) : undefined,
    };
  }

  async insertEvent(_sessionId: string, event: SessionEvent): Promise<void> {
    const db = await this.dbPromise;
    await transactionPromise(db, [EVENTS_STORE], "readwrite", (tx) => {
      tx.objectStore(EVENTS_STORE).put(encodeEventRow(event));
    });
  }

  async close(): Promise<void> {
    const db = await this.dbPromise;
    db.close();
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.indexedDb.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
          db.createObjectStore(SESSIONS_STORE, { keyPath: "id" });
        }

        if (!db.objectStoreNames.contains(EVENTS_STORE)) {
          const events = db.createObjectStore(EVENTS_STORE, { keyPath: "id" });
          events.createIndex(EVENTS_BY_SESSION_INDEX, ["sessionId", "eventIndex", "id"], {
            unique: false,
          });
        } else {
          const tx = request.transaction;
          if (!tx) {
            return;
          }
          const events = tx.objectStore(EVENTS_STORE);
          if (!events.indexNames.contains(EVENTS_BY_SESSION_INDEX)) {
            events.createIndex(EVENTS_BY_SESSION_INDEX, ["sessionId", "eventIndex", "id"], {
              unique: false,
            });
          }
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB"));
    });
  }
}

type SessionRow = {
  id: string;
  agent: string;
  agentSessionId: string;
  lastConnectionId: string;
  createdAt: number;
  destroyedAt?: number;
  sandboxId?: string;
  sessionInit?: SessionRecord["sessionInit"];
  configOptions?: SessionRecord["configOptions"];
  modes?: SessionRecord["modes"];
};

type EventRow = {
  id: number | string;
  eventIndex?: number;
  sessionId: string;
  createdAt: number;
  connectionId: string;
  sender: "client" | "agent";
  payload: unknown;
};

function encodeSessionRow(session: SessionRecord): SessionRow {
  return {
    id: session.id,
    agent: session.agent,
    agentSessionId: session.agentSessionId,
    lastConnectionId: session.lastConnectionId,
    createdAt: session.createdAt,
    destroyedAt: session.destroyedAt,
    sandboxId: session.sandboxId,
    sessionInit: session.sessionInit,
    configOptions: session.configOptions,
    modes: session.modes,
  };
}

function decodeSessionRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    agent: row.agent,
    agentSessionId: row.agentSessionId,
    lastConnectionId: row.lastConnectionId,
    createdAt: row.createdAt,
    destroyedAt: row.destroyedAt,
    sandboxId: row.sandboxId,
    sessionInit: row.sessionInit,
    configOptions: row.configOptions,
    modes: row.modes,
  };
}

function encodeEventRow(event: SessionEvent): EventRow {
  return {
    id: event.id,
    eventIndex: event.eventIndex,
    sessionId: event.sessionId,
    createdAt: event.createdAt,
    connectionId: event.connectionId,
    sender: event.sender,
    payload: event.payload,
  };
}

function decodeEventRow(row: EventRow): SessionEvent {
  return {
    id: String(row.id),
    eventIndex: parseEventIndex(row.eventIndex, row.id),
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    connectionId: row.connectionId,
    sender: row.sender,
    payload: row.payload as SessionEvent["payload"],
  };
}

async function getAllRows<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return await transactionPromise<T[]>(db, [storeName], "readonly", async (tx) => {
    const request = tx.objectStore(storeName).getAll();
    return (await requestToPromise(request)) as T[];
  });
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

function compareEventRowsByOrder(a: EventRow, b: EventRow): number {
  const indexA = parseEventIndex(a.eventIndex, a.id);
  const indexB = parseEventIndex(b.eventIndex, b.id);
  if (indexA !== indexB) {
    return indexA - indexB;
  }
  return String(a.id).localeCompare(String(b.id));
}

function parseEventIndex(value: number | undefined, fallback: number | string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  const parsed = Number.parseInt(String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionPromise<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => T | Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let settled = false;
    let resultValue: T | undefined;
    let runCompleted = false;
    let txCompleted = false;

    function tryResolve() {
      if (settled || !runCompleted || !txCompleted) {
        return;
      }
      settled = true;
      resolve(resultValue as T);
    }

    tx.oncomplete = () => {
      txCompleted = true;
      tryResolve();
    };

    tx.onerror = () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    };

    tx.onabort = () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    };

    Promise.resolve(run(tx))
      .then((value) => {
        resultValue = value;
        runCompleted = true;
        tryResolve();
      })
      .catch((error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        try {
          tx.abort();
        } catch {
          // no-op
        }
      });
  });
}
