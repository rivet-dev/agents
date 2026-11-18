import type { BackendClient } from "../backend-client.js";
import type { DebugSubscriptionTopic, SubscriptionManager, TopicStatus } from "./manager.js";
import { topicDefinitions, type TopicData, type TopicDefinition, type TopicKey, type TopicParams } from "./topics.js";

const GRACE_PERIOD_MS = 30_000;

/** Initial retry delay in ms. */
const RETRY_BASE_MS = 1_000;
/** Maximum retry delay in ms. */
const RETRY_MAX_MS = 30_000;

/**
 * Remote implementation of SubscriptionManager.
 * Each cache entry owns one actor connection plus one materialized snapshot.
 */
export class RemoteSubscriptionManager implements SubscriptionManager {
  private entries = new Map<string, TopicEntry<any, any, any>>();

  constructor(private readonly backend: BackendClient) {}

  subscribe<K extends TopicKey>(topicKey: K, params: TopicParams<K>, listener: () => void): () => void {
    const definition = topicDefinitions[topicKey] as unknown as TopicDefinition<any, any, any>;
    const cacheKey = definition.key(params as any);
    let entry = this.entries.get(cacheKey);

    if (!entry) {
      entry = new TopicEntry(topicKey, cacheKey, definition, this.backend, params as any);
      this.entries.set(cacheKey, entry);
    }

    entry.cancelTeardown();
    entry.addListener(listener);
    entry.ensureStarted();

    return () => {
      const current = this.entries.get(cacheKey);
      if (!current) {
        return;
      }
      current.removeListener(listener);
      if (current.listenerCount === 0) {
        current.scheduleTeardown(GRACE_PERIOD_MS, () => {
          this.entries.delete(cacheKey);
        });
      }
    };
  }

  getSnapshot<K extends TopicKey>(topicKey: K, params: TopicParams<K>): TopicData<K> | undefined {
    return this.entries.get((topicDefinitions[topicKey] as any).key(params))?.data as TopicData<K> | undefined;
  }

  getStatus<K extends TopicKey>(topicKey: K, params: TopicParams<K>): TopicStatus {
    return this.entries.get((topicDefinitions[topicKey] as any).key(params))?.status ?? "loading";
  }

  getError<K extends TopicKey>(topicKey: K, params: TopicParams<K>): Error | null {
    return this.entries.get((topicDefinitions[topicKey] as any).key(params))?.error ?? null;
  }

  listDebugTopics(): DebugSubscriptionTopic[] {
    return [...this.entries.values()]
      .filter((entry) => entry.listenerCount > 0)
      .map((entry) => entry.getDebugTopic())
      .sort((left, right) => left.cacheKey.localeCompare(right.cacheKey));
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.dispose();
    }
    this.entries.clear();
  }
}

class TopicEntry<TData, TParams, TEvent> {
  data: TData | undefined;
  status: TopicStatus = "loading";
  error: Error | null = null;
  listenerCount = 0;
  lastRefreshAt: number | null = null;

  private readonly listeners = new Set<() => void>();
  private conn: Awaited<ReturnType<TopicDefinition<TData, TParams, TEvent>["connect"]>> | null = null;
  private unsubscribeEvent: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;
  private teardownTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private startPromise: Promise<void> | null = null;
  private eventPromise: Promise<void> = Promise.resolve();
  private started = false;
  private disposed = false;

  constructor(
    private readonly topicKey: TopicKey,
    private readonly cacheKey: string,
    private readonly definition: TopicDefinition<TData, TParams, TEvent>,
    private readonly backend: BackendClient,
    private readonly params: TParams,
  ) {}

  getDebugTopic(): DebugSubscriptionTopic {
    return {
      topicKey: this.topicKey,
      cacheKey: this.cacheKey,
      listenerCount: this.listenerCount,
      status: this.status,
      lastRefreshAt: this.lastRefreshAt,
    };
  }

  addListener(listener: () => void): void {
    this.listeners.add(listener);
    this.listenerCount = this.listeners.size;
  }

  removeListener(listener: () => void): void {
    this.listeners.delete(listener);
    this.listenerCount = this.listeners.size;
  }

  ensureStarted(): void {
    if (this.started || this.startPromise) {
      return;
    }
    this.startPromise = this.start().finally(() => {
      this.startPromise = null;
    });
  }

  scheduleTeardown(ms: number, onTeardown: () => void): void {
    this.teardownTimer = setTimeout(() => {
      this.dispose();
      onTeardown();
    }, ms);
  }

  cancelTeardown(): void {
    if (this.teardownTimer) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTeardown();
    this.cancelRetry();
    this.unsubscribeEvent?.();
    this.unsubscribeError?.();
    if (this.conn) {
      void this.conn.dispose();
    }
    this.conn = null;
    this.data = undefined;
    this.status = "loading";
    this.error = null;
    this.lastRefreshAt = null;
    this.started = false;
    this.retryAttempt = 0;
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Schedules a retry with exponential backoff. Cleans up any existing
   * connection state before reconnecting.
   */
  private scheduleRetry(): void {
    if (this.disposed || this.listenerCount === 0) {
      return;
    }

    const delay = Math.min(RETRY_BASE_MS * 2 ** this.retryAttempt, RETRY_MAX_MS);
    this.retryAttempt++;

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.disposed || this.listenerCount === 0) {
        return;
      }

      // Tear down the old connection before retrying
      this.cleanupConnection();
      this.started = false;
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }, delay);
  }

  /**
   * Cleans up connection resources without resetting data/status/retry state.
   */
  private cleanupConnection(): void {
    this.unsubscribeEvent?.();
    this.unsubscribeError?.();
    this.unsubscribeEvent = null;
    this.unsubscribeError = null;
    if (this.conn) {
      void this.conn.dispose();
    }
    this.conn = null;
  }

  private async start(): Promise<void> {
    this.status = "loading";
    this.error = null;
    this.notify();

    try {
      this.conn = await this.definition.connect(this.backend, this.params);
      this.unsubscribeEvent = this.conn.on(this.definition.event, (event: TEvent) => {
        void this.applyEvent(event);
      });
      this.unsubscribeError = this.conn.onError((error: unknown) => {
        this.status = "error";
        this.error = error instanceof Error ? error : new Error(String(error));
        this.notify();
        this.scheduleRetry();
      });
      this.data = await this.definition.fetchInitial(this.backend, this.params);
      this.status = "connected";
      this.lastRefreshAt = Date.now();
      this.started = true;
      this.retryAttempt = 0;
      this.notify();
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error : new Error(String(error));
      this.started = false;
      this.notify();
      this.scheduleRetry();
    }
  }

  private applyEvent(event: TEvent): Promise<void> {
    this.eventPromise = this.eventPromise
      .then(async () => {
        if (!this.started || this.data === undefined) {
          return;
        }

        const nextData = await this.definition.applyEvent(this.backend, this.params, this.data, event);
        if (!this.started) {
          return;
        }

        this.data = nextData;
        this.status = "connected";
        this.error = null;
        this.lastRefreshAt = Date.now();
        this.notify();
      })
      .catch((error) => {
        this.status = "error";
        this.error = error instanceof Error ? error : new Error(String(error));
        this.notify();
      });

    return this.eventPromise;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
