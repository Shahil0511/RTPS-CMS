import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { env } from "@/env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

declare global {
  // eslint-disable-next-line no-var
  var __vmsDb: { pool: Pool; migrated: Promise<void> | null } | undefined;
}

function open(): { pool: Pool; migrated: Promise<void> | null } {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.PGSSL ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Keep this application inside its own schema; "public" stays read-only fallback for extensions.
    options: `-c search_path=${quoteIdent(schema.SCHEMA_NAME)},public`,
    application_name: "libas-vms",
  });
  pool.on("error", (err) => console.error("[db] idle client error", err));
  return { pool, migrated: null };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const conn = globalThis.__vmsDb ?? (globalThis.__vmsDb = open());

// Only the pool is cached across hot reloads; the query layer is rebuilt so schema changes apply immediately.
export const db: Db = drizzle(conn.pool, { schema });
export const pool: Pool = conn.pool;
export { schema };

/**
 * Applies pending SQL migrations from ./drizzle. The migrations journal is
 * kept inside the application schema as well, so nothing is written to "public".
 * Idempotent and safe to call from several entry points (boot, seed script).
 */
export function runMigrations(): Promise<void> {
  if (!conn.migrated) {
    conn.migrated = (async () => {
      const migrationsFolder = path.resolve(process.cwd(), "drizzle");
      if (!fs.existsSync(migrationsFolder)) {
        console.warn("[db] no migrations folder found; run `npm run db:generate`");
        return;
      }
      await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema.SCHEMA_NAME)}`));
      await migrate(db, {
        migrationsFolder,
        migrationsSchema: schema.SCHEMA_NAME,
        migrationsTable: "__drizzle_migrations",
      });
    })().catch((err) => {
      conn.migrated = null;
      throw err;
    });
  }
  return conn.migrated;
}
