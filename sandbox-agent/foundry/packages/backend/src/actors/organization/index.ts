import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import { organizationDb } from "./db/db.js";
import { organizationActions } from "./actions.js";
import { runOrganizationWorkflow } from "./workflow.js";
import { ORGANIZATION_QUEUE_NAMES } from "./queues.js";

export const organization = actor({
  db: organizationDb,
  queues: Object.fromEntries(ORGANIZATION_QUEUE_NAMES.map((name) => [name, queue()])),
  options: {
    name: "Organization",
    icon: "compass",
    actionTimeout: 5 * 60_000,
  },
  createState: (_c, organizationId: string) => ({
    organizationId,
  }),
  actions: {
    ...organizationActions,
  },
  run: workflow(runOrganizationWorkflow),
});
