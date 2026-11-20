// Wipes the Turbopack dev cache. Used by `npm run dev:clean` before starting dev.
// The cache can get out of sync (e.g. after `next build` ran alongside `next dev`),
// which makes every open page reload in a loop. It is safe to rebuild.
import fs from "node:fs";
import path from "node:path";

for (const dir of [".next/dev", ".next-alt"]) {
  const full = path.resolve(process.cwd(), dir);
  if (fs.existsSync(full)) {
    fs.rmSync(full, { recursive: true, force: true });
    console.log(`[dev] removed ${dir}`);
  }
}
