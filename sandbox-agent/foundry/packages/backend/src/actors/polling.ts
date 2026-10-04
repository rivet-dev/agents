import { Loop } from "rivetkit/workflow";
import { normalizeMessages } from "../services/queue.js";

export interface PollingControlState {
  intervalMs: number;
  running: boolean;
}

export interface PollingControlQueueNames {
  start: string;
  stop: string;
  setInterval: string;
  force: string;
}

export interface PollingQueueMessage {
  name: string;
  body: unknown;
  complete(response: unknown): Promise<void>;
}

interface PollingActorContext<TState extends PollingControlState> {
  state: TState;
  abortSignal: AbortSignal;
  queue: {
    nextBatch(options: { names: readonly string[]; timeout: number; count: number; completable: true }): Promise<PollingQueueMessage[]>;
  };
}

interface RunPollingOptions<TState extends PollingControlState> {
  control: PollingControlQueueNames;
  onPoll(c: PollingActorContext<TState>): Promise<void>;
}

export async function runPollingControlLoop<TState extends PollingControlState>(
  c: PollingActorContext<TState>,
  options: RunPollingOptions<TState>,
): Promise<void> {
  while (!c.abortSignal.aborted) {
    const messages = normalizeMessages(
      await c.queue.nextBatch({
        names: [options.control.start, options.control.stop, options.control.setInterval, options.control.force],
        timeout: Math.max(500, c.state.intervalMs),
        count: 16,
        completable: true,
      }),
    ) as PollingQueueMessage[];

    if (messages.length === 0) {
      if (!c.state.running) {
        continue;
      }
      await options.onPoll(c);
      continue;
    }

    for (const msg of messages) {
      if (msg.name === options.control.start) {
        c.state.running = true;
        await msg.complete({ ok: true });
        continue;
      }

      if (msg.name === options.control.stop) {
        c.state.running = false;
        await msg.complete({ ok: true });
        continue;
      }

      if (msg.name === options.control.setInterval) {
        const intervalMs = Number((msg.body as { intervalMs?: unknown })?.intervalMs);
        c.state.intervalMs = Number.isFinite(intervalMs) ? Math.max(500, intervalMs) : c.state.intervalMs;
        await msg.complete({ ok: true });
        continue;
      }

      if (msg.name === options.control.force) {
        await options.onPoll(c);
        await msg.complete({ ok: true });
      }
    }
  }
}

interface WorkflowPollingActorContext<TState extends PollingControlState> {
  state: TState;
  loop(config: { name: string; historyEvery: number; historyKeep: number; run(ctx: WorkflowPollingActorContext<TState>): Promise<unknown> }): Promise<void>;
}

interface WorkflowPollingQueueMessage extends PollingQueueMessage {}

interface WorkflowPollingLoopContext<TState extends PollingControlState> {
  state: TState;
  queue: {
    nextBatch(
      name: string,
      options: {
        names: readonly string[];
        timeout: number;
        count: number;
        completable: true;
      },
    ): Promise<WorkflowPollingQueueMessage[]>;
  };
  step<T>(
    nameOrConfig:
      | string
      | {
          name: string;
          timeout?: number;
          run: () => Promise<T>;
        },
    run?: () => Promise<T>,
  ): Promise<T>;
}

export async function runWorkflowPollingLoop<TState extends PollingControlState>(
  ctx: any,
  options: RunPollingOptions<TState> & { loopName: string },
): Promise<void> {
  await ctx.loop(options.loopName, async (loopCtx: WorkflowPollingLoopContext<TState>) => {
    const control = await loopCtx.step("read-control-state", async () => ({
      intervalMs: Math.max(500, Number(loopCtx.state.intervalMs) || 500),
      running: Boolean(loopCtx.state.running),
    }));

    const messages = normalizeMessages(
      await loopCtx.queue.nextBatch("next-polling-control-batch", {
        names: [options.control.start, options.control.stop, options.control.setInterval, options.control.force],
        timeout: control.running ? control.intervalMs : 60_000,
        count: 16,
        completable: true,
      }),
    ) as WorkflowPollingQueueMessage[];

    if (messages.length === 0) {
      if (control.running) {
        await loopCtx.step({
          name: "poll-tick",
          timeout: 5 * 60_000,
          run: async () => {
            await options.onPoll(loopCtx as unknown as PollingActorContext<TState>);
          },
        });
      }
      return Loop.continue(undefined);
    }

    for (const msg of messages) {
      if (msg.name === options.control.start) {
        await loopCtx.step("control-start", async () => {
          loopCtx.state.running = true;
        });
        await msg.complete({ ok: true });
        continue;
      }

      if (msg.name === options.control.stop) {
        await loopCtx.step("control-stop", async () => {
          loopCtx.state.running = false;
        });
        await msg.complete({ ok: true });
        continue;
      }

      if (msg.name === options.control.setInterval) {
        await loopCtx.step("control-set-interval", async () => {
          const intervalMs = Number((msg.body as { intervalMs?: unknown })?.intervalMs);
          loopCtx.state.intervalMs = Number.isFinite(intervalMs) ? Math.max(500, intervalMs) : loopCtx.state.intervalMs;
        });
        await msg.complete({ ok: true });
        continue;
      }

      if (msg.name === options.control.force) {
        await loopCtx.step({
          name: "control-force",
          timeout: 5 * 60_000,
          run: async () => {
            await options.onPoll(loopCtx as unknown as PollingActorContext<TState>);
          },
        });
        await msg.complete({ ok: true });
      }
    }

    return Loop.continue(undefined);
  });
}
