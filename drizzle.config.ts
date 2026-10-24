import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./core/db/schema/index.ts",
  out: "./core/db/migrations",
  dialect: "postgresql",
});
