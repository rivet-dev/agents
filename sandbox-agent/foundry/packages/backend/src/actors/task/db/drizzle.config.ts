import { defineConfig } from "rivetkit/db/drizzle";

export default defineConfig({
  out: "./src/actors/task/db/drizzle",
  schema: "./src/actors/task/db/schema.ts",
});
