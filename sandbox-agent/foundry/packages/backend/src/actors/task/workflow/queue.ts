export const TASK_QUEUE_NAMES = [
  "task.command.initialize",
  "task.command.provision",
  "task.command.attach",
  "task.command.switch",
  "task.command.push",
  "task.command.sync",
  "task.command.merge",
  "task.command.archive",
  "task.command.kill",
  "task.command.workspace.create_session",
  "task.command.workspace.create_session_and_send",
  "task.command.workspace.ensure_session",
  "task.command.workspace.send_message",
  "task.command.workspace.stop_session",
  "task.command.workspace.close_session",
  "task.command.workspace.publish_pr",
  "task.command.workspace.revert_file",
  "task.command.workspace.change_owner",
] as const;

export type TaskQueueName = (typeof TASK_QUEUE_NAMES)[number];

export function taskWorkflowQueueName(name: string): string {
  return name;
}
