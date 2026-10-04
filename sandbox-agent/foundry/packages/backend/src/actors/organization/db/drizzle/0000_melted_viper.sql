CREATE TABLE `app_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`current_user_id` text,
	`current_user_name` text,
	`current_user_email` text,
	`current_user_github_login` text,
	`current_user_role_label` text,
	`eligible_organization_ids_json` text NOT NULL,
	`active_organization_id` text,
	`github_access_token` text,
	`github_scope` text NOT NULL,
	`starter_repo_status` text NOT NULL,
	`starter_repo_starred_at` integer,
	`starter_repo_skipped_at` integer,
	`oauth_state` text,
	`oauth_state_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`issued_at` text NOT NULL,
	`amount_usd` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `organization_members` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `organization_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`github_account_id` text NOT NULL,
	`github_login` text NOT NULL,
	`github_account_type` text NOT NULL,
	`display_name` text NOT NULL,
	`slug` text NOT NULL,
	`primary_domain` text NOT NULL,
	`default_model` text NOT NULL,
	`auto_import_repos` integer NOT NULL,
	`repo_import_status` text NOT NULL,
	`github_connected_account` text NOT NULL,
	`github_installation_status` text NOT NULL,
	`github_sync_status` text NOT NULL,
	`github_installation_id` integer,
	`github_last_sync_label` text NOT NULL,
	`github_last_sync_at` integer,
	`github_last_webhook_at` integer,
	`github_last_webhook_event` text,
	`github_sync_generation` integer NOT NULL,
	`github_sync_phase` text,
	`github_processed_repository_count` integer NOT NULL,
	`github_total_repository_count` integer NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`stripe_price_id` text,
	`billing_plan_id` text NOT NULL,
	`billing_status` text NOT NULL,
	`billing_seats_included` integer NOT NULL,
	`billing_trial_ends_at` text,
	`billing_renewal_at` text,
	`billing_payment_method_label` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `repos` (
	`repo_id` text PRIMARY KEY NOT NULL,
	`remote_url` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `seat_assignments` (
	`email` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stripe_lookup` (
	`lookup_key` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`updated_at` integer NOT NULL
);
