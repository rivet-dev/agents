CREATE TABLE `task` (
	`id` integer PRIMARY KEY NOT NULL,
	`branch_name` text,
	`title` text,
	`task` text NOT NULL,
	`sandbox_provider_id` text NOT NULL,
	`status` text NOT NULL,
	`pull_request_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "task_singleton_id_check" CHECK("task"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `task_runtime` (
	`id` integer PRIMARY KEY NOT NULL,
	`active_sandbox_id` text,
	`active_switch_target` text,
	`active_cwd` text,
	`git_state_json` text,
	`git_state_updated_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "task_runtime_singleton_id_check" CHECK("task_runtime"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `task_sandboxes` (
	`sandbox_id` text PRIMARY KEY NOT NULL,
	`sandbox_provider_id` text NOT NULL,
	`sandbox_actor_id` text,
	`switch_target` text NOT NULL,
	`cwd` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_workspace_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`sandbox_session_id` text,
	`session_name` text NOT NULL,
	`model` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`error_message` text,
	`transcript_json` text DEFAULT '[]' NOT NULL,
	`transcript_updated_at` integer,
	`created` integer DEFAULT 1 NOT NULL,
	`closed` integer DEFAULT 0 NOT NULL,
	`thinking_since_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
