// @ts-nocheck
/**
 * Organization workflow — queue-based command loop.
 *
 * Mutations are dispatched through named queues and processed inside workflow
 * steps so that every command appears in the RivetKit inspector's workflow
 * history. Read actions remain direct (no queue).
 *
 * Callers send commands directly via `.send()` to the appropriate queue name.
 */
import { Loop } from "rivetkit/workflow";
import { logActorWarning, resolveErrorMessage } from "../logging.js";
import { ORGANIZATION_QUEUE_NAMES, type OrganizationQueueName } from "./queues.js";

import { applyGithubSyncProgressMutation, recordGithubWebhookReceiptMutation, refreshOrganizationSnapshotMutation } from "./actions.js";
import {
  applyTaskSummaryUpdateMutation,
  createTaskMutation,
  refreshTaskSummaryForBranchMutation,
  removeTaskSummaryMutation,
} from "./actions/task-mutations.js";
import {
  applyOrganizationFreePlanMutation,
  applyOrganizationStripeCustomerMutation,
  applyOrganizationStripeSubscriptionMutation,
  markOrganizationSyncStartedMutation,
  recordOrganizationSeatUsageMutation,
  setOrganizationBillingPaymentMethodMutation,
  setOrganizationBillingStatusMutation,
  syncOrganizationShellFromGithubMutation,
  upsertOrganizationInvoiceMutation,
} from "./app-shell.js";

// ---------------------------------------------------------------------------
// Workflow command loop — runs inside `run: workflow(runOrganizationWorkflow)`
// ---------------------------------------------------------------------------

type WorkflowHandler = (loopCtx: any, body: any) => Promise<any>;

/**
 * Maps queue names to their mutation handlers.
 * Each handler receives the workflow loop context and the message body,
 * executes the mutation, and returns the result (which is sent back via
 * msg.complete).
 */
const COMMAND_HANDLERS: Record<OrganizationQueueName, WorkflowHandler> = {
  // Task mutations
  "organization.command.createTask": async (c, body) => createTaskMutation(c, body),
  "organization.command.materializeTask": async (c, body) => createTaskMutation(c, body),
  "organization.command.applyTaskSummaryUpdate": async (c, body) => {
    await applyTaskSummaryUpdateMutation(c, body);
    return { ok: true };
  },
  "organization.command.removeTaskSummary": async (c, body) => {
    await removeTaskSummaryMutation(c, body);
    return { ok: true };
  },
  "organization.command.refreshTaskSummaryForBranch": async (c, body) => {
    await refreshTaskSummaryForBranchMutation(c, body);
    return { ok: true };
  },
  "organization.command.snapshot.broadcast": async (c, _body) => {
    await refreshOrganizationSnapshotMutation(c);
    return { ok: true };
  },
  "organization.command.syncGithubSession": async (c, body) => {
    const { syncGithubOrganizations } = await import("./app-shell.js");
    await syncGithubOrganizations(c, body);
    return { ok: true };
  },

  // GitHub organization shell sync (stays on queue)
  "organization.command.github.organization_shell.sync_from_github": async (c, body) => syncOrganizationShellFromGithubMutation(c, body),

  // GitHub sync progress + webhook receipt
  "organization.command.github.sync_progress.apply": async (c, body) => {
    await applyGithubSyncProgressMutation(c, body);
    return { ok: true };
  },
  "organization.command.github.webhook_receipt.record": async (c, body) => {
    await recordGithubWebhookReceiptMutation(c, body);
    return { ok: true };
  },
  "organization.command.shell.sync_started.mark": async (c, body) => {
    await markOrganizationSyncStartedMutation(c, body);
    return { ok: true };
  },

  // Billing mutations
  "organization.command.billing.stripe_customer.apply": async (c, body) => {
    await applyOrganizationStripeCustomerMutation(c, body);
    return { ok: true };
  },
  "organization.command.billing.stripe_subscription.apply": async (c, body) => {
    await applyOrganizationStripeSubscriptionMutation(c, body);
    return { ok: true };
  },
  "organization.command.billing.free_plan.apply": async (c, body) => {
    await applyOrganizationFreePlanMutation(c, body);
    return { ok: true };
  },
  "organization.command.billing.payment_method.set": async (c, body) => {
    await setOrganizationBillingPaymentMethodMutation(c, body);
    return { ok: true };
  },
  "organization.command.billing.status.set": async (c, body) => {
    await setOrganizationBillingStatusMutation(c, body);
    return { ok: true };
  },
  "organization.command.billing.invoice.upsert": async (c, body) => {
    await upsertOrganizationInvoiceMutation(c, body);
    return { ok: true };
  },
  "organization.command.billing.seat_usage.record": async (c, body) => {
    await recordOrganizationSeatUsageMutation(c, body);
    return { ok: true };
  },
};

export async function runOrganizationWorkflow(ctx: any): Promise<void> {
  await ctx.loop("organization-command-loop", async (loopCtx: any) => {
    const msg = await loopCtx.queue.next("next-organization-command", {
      names: [...ORGANIZATION_QUEUE_NAMES],
      completable: true,
    });

    if (!msg) {
      return Loop.continue(undefined);
    }

    const handler = COMMAND_HANDLERS[msg.name as OrganizationQueueName];
    if (!handler) {
      logActorWarning("organization", "unknown organization command", { command: msg.name });
      await msg.complete({ error: `Unknown command: ${msg.name}` }).catch(() => {});
      return Loop.continue(undefined);
    }

    try {
      // Wrap in a step so c.state and c.db are accessible inside mutation functions.
      const result = await loopCtx.step({
        name: msg.name,
        timeout: 10 * 60_000,
        run: async () => handler(loopCtx, msg.body),
      });
      try {
        await msg.complete(result);
      } catch (completeError) {
        logActorWarning("organization", "organization workflow failed completing response", {
          command: msg.name,
          error: resolveErrorMessage(completeError),
        });
      }
    } catch (error) {
      const message = resolveErrorMessage(error);
      logActorWarning("organization", "organization workflow command failed", {
        command: msg.name,
        error: message,
      });
      await msg.complete({ error: message }).catch(() => {});
    }

    return Loop.continue(undefined);
  });
}
