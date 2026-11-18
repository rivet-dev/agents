import { z } from "zod";

export const AgentEnumSchema = z.enum(["claude", "codex"]);

export const NotifyBackendSchema = z.enum(["openclaw", "macos-osascript", "linux-notify-send", "terminal"]);

export const ConfigSchema = z.object({
  theme: z.string().min(1).optional(),
  auto_submit: z.boolean().default(false),
  default_agent: AgentEnumSchema.default("codex"),
  model: z
    .object({
      provider: z.string(),
      model: z.string(),
    })
    .optional(),
  notify: z.array(NotifyBackendSchema).default(["terminal"]),
  organization: z
    .object({
      default: z.string().min(1).default("default"),
    })
    .default({ default: "default" }),
  backend: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(7741),
      dbPath: z.string().default("~/.local/share/foundry/task.db"),
      opencode_poll_interval: z.number().default(2),
      github_poll_interval: z.number().default(30),
      backup_interval_secs: z.number().default(3600),
      backup_retention_days: z.number().default(7),
    })
    .default({
      host: "127.0.0.1",
      port: 7741,
      dbPath: "~/.local/share/foundry/task.db",
      opencode_poll_interval: 2,
      github_poll_interval: 30,
      backup_interval_secs: 3600,
      backup_retention_days: 7,
    }),
  sandboxProviders: z
    .object({
      local: z
        .object({
          image: z.string().optional(),
        })
        .default({}),
      e2b: z
        .object({
          apiKey: z.string().optional(),
          template: z.string().optional(),
        })
        .default({}),
    })
    .default({ local: {}, e2b: {} }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
