import { defineConfig } from "rivetkit/db/drizzle";

export default defineConfig({
  out: "./src/actors/organization/db/drizzle",
  schema: "./src/actors/organization/db/schema.ts",
});
