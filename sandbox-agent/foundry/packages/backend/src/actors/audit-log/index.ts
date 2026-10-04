// @ts-nocheck
import { and, desc, eq } from "drizzle-orm";
import { actor, queue } from "rivetkit";
import { workflow, Loop } from "rivetkit/workflow";
import type { AuditLogEvent } from "@sandbox-agent/foundry-shared";
import { selfAuditLog } from "../handles.js";
import { logActorWarning, resolveErrorMessage } from "../logging.js";
import { auditLogDb } from "./db/db.js";
import { events } from "./db/schema.js";

export interface AuditLogInput {
  organizationId: string;
}

export interface AppendAuditLogCommand {
  kind: string;
  repoId?: string;
  taskId?: string;
  branchName?: string;
  payload: Record<string, unknown>;
}

export interface ListAuditLogParams {
  repoId?: string;
  branch?: string;
  taskId?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Queue names
// ---------------------------------------------------------------------------

const AUDIT_LOG_QUEUE_NAMES = ["auditLog.command.append"] as const;

type AuditLogQueueName = (typeof AUDIT_LOG_QUEUE_NAMES)[number];

function auditLogWorkflowQueueName(name: AuditLogQueueName): AuditLogQueueName {
  return name;
}

// ---------------------------------------------------------------------------
// Mutation functions
// ---------------------------------------------------------------------------

async function appendMutation(c: any, body: AppendAuditLogCommand): Promise<{ ok: true }> {
  const now = Date.now();
  await c.db
    .insert(events)
    .values({
      repoId: body.repoId ?? null,
      taskId: body.taskId ?? null,
      branchName: body.branchName ?? null,
      kind: body.kind,
      payloadJson: JSON.stringify(body.payload),
      createdAt: now,
    })
    .run();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Workflow command loop
// ---------------------------------------------------------------------------

type AuditLogWorkflowHandler = (loopCtx: any, body: any) => Promise<any>;

const AUDIT_LOG_COMMAND_HANDLERS: Record<AuditLogQueueName, AuditLogWorkflowHandler> = {
  "auditLog.command.append": async (c, body) => appendMutation(c, body),
};

async function runAuditLogWorkflow(ctx: any): Promise<void> {
  await ctx.loop("audit-log-command-loop", async (loopCtx: any) => {
    const msg = await loopCtx.queue.next("next-audit-log-command", {
      names: [...AUDIT_LOG_QUEUE_NAMES],
      completable: true,
    });

    if (!msg) {
      return Loop.continue(undefined);
    }

    const handler = AUDIT_LOG_COMMAND_HANDLERS[msg.name as AuditLogQueueName];
    if (!handler) {
      logActorWarning("auditLog", "unknown audit-log command", { command: msg.name });
      await msg.complete({ error: `Unknown command: ${msg.name}` }).catch(() => {});
      return Loop.continue(undefined);
    }

    try {
      // Wrap in a step so c.state and c.db are accessible inside mutation functions.
      const result = await loopCtx.step({
        name: msg.name,
        timeout: 60_000,
        run: async () => handler(loopCtx, msg.body),
      });
      await msg.complete(result);
    } catch (error) {
      const message = resolveErrorMessage(error);
      logActorWarning("auditLog", "audit-log workflow command failed", {
        command: msg.name,
        error: message,
      });
      await msg.complete({ error: message }).catch(() => {});
    }

    return Loop.continue(undefined);
  });
}

// ---------------------------------------------------------------------------
// Actor definition
// ---------------------------------------------------------------------------

/**
 * Organization-scoped audit log. One per org, not one per repo.
 *
 * The org is the coordinator for all tasks across repos, and we frequently need
 * to query the full audit trail across repos (e.g. org-wide activity feed,
 * compliance). A per-repo audit log would require fan-out reads every time.
 * Keeping it org-scoped gives us a single queryable feed with optional repoId
 * filtering when callers want a narrower view.
 */
export const auditLog = actor({
  db: auditLogDb,
  queues: Object.fromEntries(AUDIT_LOG_QUEUE_NAMES.map((name) => [name, queue()])),
  options: {
    name: "Audit Log",
    icon: "database",
  },
  createState: (_c, input: AuditLogInput) => ({
    organizationId: input.organizationId,
  }),
  actions: {
    // Mutation — self-send to queue for workflow history
    async append(c: any, body: AppendAuditLogCommand): Promise<{ ok: true }> {
      const self = selfAuditLog(c);
      await self.send(auditLogWorkflowQueueName("auditLog.command.append"), body, { wait: false });
      return { ok: true };
    },

    // Read — direct action (no queue)
    async list(c, params?: ListAuditLogParams): Promise<AuditLogEvent[]> {
      const whereParts = [];
      if (params?.repoId) {
        whereParts.push(eq(events.repoId, params.repoId));
      }
      if (params?.taskId) {
        whereParts.push(eq(events.taskId, params.taskId));
      }
      if (params?.branch) {
        whereParts.push(eq(events.branchName, params.branch));
      }

      const base = c.db
        .select({
          id: events.id,
          repoId: events.repoId,
          taskId: events.taskId,
          branchName: events.branchName,
          kind: events.kind,
          payloadJson: events.payloadJson,
          createdAt: events.createdAt,
        })
        .from(events);

      const rows = await (whereParts.length > 0 ? base.where(and(...whereParts)) : base)
        .orderBy(desc(events.createdAt))
        .limit(params?.limit ?? 100)
        .all();

      return rows.map((row) => ({
        ...row,
        organizationId: c.state.organizationId,
        repoId: row.repoId ?? null,
      }));
    },
  },
  run: workflow(runAuditLogWorkflow),
});
