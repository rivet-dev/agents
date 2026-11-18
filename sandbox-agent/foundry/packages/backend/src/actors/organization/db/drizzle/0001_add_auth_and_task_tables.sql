CREATE TABLE IF NOT EXISTS `auth_session_index` (
	`session_id` text PRIMARY KEY NOT NULL,
	`session_token` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `auth_email_index` (
	`email` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `auth_account_index` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `auth_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_index` (
	`task_id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`branch_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_summaries` (
	`task_id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`repo_name` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`branch` text,
	`pull_request_json` text,
	`sessions_summary_json` text DEFAULT '[]' NOT NULL
);
