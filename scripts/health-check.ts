// Runs one recorder + camera health check and prints a summary. Usage: npm run health:run
import { pool, runMigrations } from "../src/db";
import { runHealthCheck } from "../src/lib/health/monitor";
import { registerHikvisionProvider } from "../src/lib/hikvision/provider";

async function main() {
  await runMigrations();
  registerHikvisionProvider();
  const r = await runHealthCheck();
  console.log(`Recorders: ${r.devicesOnline} online, ${r.devicesOffline} offline`);
  console.log(`Cameras:   ${r.online} online, ${r.offline} offline, ${r.unknown} unknown (of ${r.total})`);
  console.log(`Streaming server: ${r.mediamtxReachable ? "reachable" : "unreachable"}`);
  for (const t of r.deviceTransitions) console.log(`  recorder ${t.name}: ${t.from} -> ${t.to}`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
