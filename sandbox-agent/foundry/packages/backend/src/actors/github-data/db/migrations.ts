const journal = {
  entries: [
    {
      idx: 0,
      when: 1773446400000,
      tag: "0000_github_data",
      breakpoints: true,
    },
    {
      idx: 1,
      when: 1773810002000,
      tag: "0001_default_branch",
      breakpoints: true,
    },
    {
      idx: 2,
      when: 1773810300000,
      tag: "0002_github_branches",
      breakpoints: true,
    },
    {
      idx: 3,
      when: 1773907200000,
      tag: "0003_sync_progress",
      breakpoints: true,
    },
    {
      idx: 4,
      when: 1773993600000,
      tag: "0004_drop_github_branches",
      breakpoints: true,
    },
  ],
} as const;

export default {
  journal,
  migrations: {
    m0000: `CREATE TABLE \`github_meta\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`connected_account\` text NOT NULL,
	\`installation_status\` text NOT NULL,
	\`sync_status\` text NOT NULL,
	\`installation_id\` integer,
	\`last_sync_label\` text NOT NULL,
	\`last_sync_at\` integer,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT \`github_meta_singleton_id_check\` CHECK(\`id\` = 1)
);
--> statement-breakpoint
CREATE TABLE \`github_repositories\` (
	\`repo_id\` text PRIMARY KEY NOT NULL,
	\`full_name\` text NOT NULL,
	\`clone_url\` text NOT NULL,
	\`private\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`github_members\` (
	\`member_id\` text PRIMARY KEY NOT NULL,
	\`login\` text NOT NULL,
	\`display_name\` text NOT NULL,
	\`email\` text,
	\`role\` text,
	\`state\` text NOT NULL,
	\`updated_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`github_pull_requests\` (
	\`pr_id\` text PRIMARY KEY NOT NULL,
	\`repo_id\` text NOT NULL,
	\`repo_full_name\` text NOT NULL,
	\`number\` integer NOT NULL,
	\`title\` text NOT NULL,
	\`body\` text,
	\`state\` text NOT NULL,
	\`url\` text NOT NULL,
	\`head_ref_name\` text NOT NULL,
	\`base_ref_name\` text NOT NULL,
	\`author_login\` text,
	\`is_draft\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);
`,
    m0001: `ALTER TABLE \`github_repositories\` ADD \`default_branch\` text NOT NULL DEFAULT 'main';
`,
    m0002: `CREATE TABLE \`github_branches\` (
	\`branch_id\` text PRIMARY KEY NOT NULL,
	\`repo_id\` text NOT NULL,
	\`branch_name\` text NOT NULL,
	\`commit_sha\` text NOT NULL,
	\`updated_at\` integer NOT NULL
);
`,
    m0003: `ALTER TABLE \`github_meta\` ADD \`sync_generation\` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE \`github_meta\` ADD \`sync_phase\` text;
--> statement-breakpoint
ALTER TABLE \`github_meta\` ADD \`processed_repository_count\` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE \`github_meta\` ADD \`total_repository_count\` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE \`github_repositories\` ADD \`sync_generation\` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE \`github_members\` ADD \`sync_generation\` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE \`github_pull_requests\` ADD \`sync_generation\` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE \`github_branches\` ADD \`sync_generation\` integer NOT NULL DEFAULT 0;
`,
    m0004: `DROP TABLE IF EXISTS \`github_branches\`;
`,
  } as const,
};
