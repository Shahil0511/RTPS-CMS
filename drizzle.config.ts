import { defineConfig } from "drizzle-kit";

const schemaName = process.env.DATABASE_SCHEMA?.trim() || "vms";

/**
 * drizzle-kit is scoped to the application schema only (schemaFilter), so
 * generate/push/studio never read or modify other schemas in the shared database.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
  },
  schemaFilter: [schemaName],
  migrations: {
    schema: schemaName,
    table: "__drizzle_migrations",
  },
  strict: true,
  verbose: true,
});
