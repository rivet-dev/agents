export const ORGANIZATION_QUEUE_NAMES = [
  "organization.command.createTask",
  "organization.command.materializeTask",
  "organization.command.applyTaskSummaryUpdate",
  "organization.command.removeTaskSummary",
  "organization.command.refreshTaskSummaryForBranch",
  "organization.command.snapshot.broadcast",
  "organization.command.syncGithubSession",
  "organization.command.github.organization_shell.sync_from_github",
  "organization.command.github.sync_progress.apply",
  "organization.command.github.webhook_receipt.record",
  "organization.command.shell.sync_started.mark",
  "organization.command.billing.stripe_customer.apply",
  "organization.command.billing.stripe_subscription.apply",
  "organization.command.billing.free_plan.apply",
  "organization.command.billing.payment_method.set",
  "organization.command.billing.status.set",
  "organization.command.billing.invoice.upsert",
  "organization.command.billing.seat_usage.record",
] as const;

export type OrganizationQueueName = (typeof ORGANIZATION_QUEUE_NAMES)[number];

export function organizationWorkflowQueueName(name: OrganizationQueueName): OrganizationQueueName {
  return name;
}
