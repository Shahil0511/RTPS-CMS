// Applies pending migrations to the application schema. Usage: npm run db:migrate
import { pool, runMigrations } from "../src/db";

async function main() {
  await runMigrations();
  console.log("Migrations applied.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
