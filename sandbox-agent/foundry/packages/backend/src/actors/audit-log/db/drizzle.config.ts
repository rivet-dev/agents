import { defineConfig } from "rivetkit/db/drizzle";

export default defineConfig({
  out: "./src/actors/audit-log/db/drizzle",
  schema: "./src/actors/audit-log/db/schema.ts",
});
