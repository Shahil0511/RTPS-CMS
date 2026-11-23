// Re-tests reachability for every store device in config/store-cameras.json.
// Read-only: a single TCP connect attempt per port, no credentials ever sent.
// Run anytime (e.g. after IT sets up a VPN/relay for a site) with:
//   node scripts/check-store-cameras.mjs
//
// This never writes to the app's database and never prints passwords.
// A store that comes back reachable should then be added through the app's
// own "Add recorder" UI (or `npm run recorder:add`) so its password is
// stored encrypted, the same way the two existing NVRs already are -
// never copy it into this repo's source or into .env.

import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.join(__dirname, "..", "config", "store-cameras.json");

function probe(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    const sock = net.createConnection({ host, port });
    const t = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(t);
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

async function main() {
  const raw = JSON.parse(await readFile(dataPath, "utf8"));
  let reachableCount = 0;

  for (const store of raw.stores) {
    if (!store.ip) {
      console.log(`skip (no IP)      ${store.name}`);
      continue;
    }
    const [p80, p554] = await Promise.all([probe(store.ip, 80), probe(store.ip, 554)]);
    const reachable = p80 || p554;
    store.reachable = reachable;
    if (reachable) reachableCount += 1;
    console.log(`${reachable ? "REACHABLE  " : "unreachable"}     ${store.name.padEnd(32)} ${store.ip}  (80:${p80} 554:${p554})`);
  }

  raw.lastTestedAt = new Date().toISOString().slice(0, 10);
  await writeFile(dataPath, JSON.stringify(raw, null, 2) + "\n", "utf8");

  console.log(`\n${reachableCount} of ${raw.stores.length} store devices are reachable from this machine right now.`);
  if (reachableCount > 0) {
    console.log("Add the reachable ones through the app's own Recorders UI (Add recorder), not by editing this file further.");
  }
}

main();
