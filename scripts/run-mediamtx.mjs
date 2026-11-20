// Starts the bundled MediaMTX streaming server with the VMS configuration.
// Usage: npm run mediamtx
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./env.mjs";

loadEnv();

const root = process.cwd();
const binDir = path.join(root, "mediamtx", "bin");
const binary = path.join(binDir, process.platform === "win32" ? "mediamtx.exe" : "mediamtx");
const config = path.join(root, "mediamtx", "mediamtx.yml");

if (!process.env.MEDIAMTX_AUTH_SECRET) {
  console.error("MEDIAMTX_AUTH_SECRET is not set in .env");
  process.exit(1);
}

if (!fs.existsSync(binary)) {
  console.error(`MediaMTX binary not found at ${binary}\nRun: npm run mediamtx:download`);
  process.exit(1);
}

const port = process.env.PORT ?? "3000";
const recordingRoot = path.resolve(root, process.env.RECORDING_ROOT ?? "./recordings");
fs.mkdirSync(recordingRoot, { recursive: true });

const recordPattern = path
  .join(recordingRoot, "%path", "%Y-%m-%d_%H-%M-%S-%f_%z")
  .replace(/\\/g, "/");

const env = {
  ...process.env,
  // The app authenticates every MediaMTX action.
  // The secret proves the caller is MediaMTX (the hook rejects requests without it).
  MTX_AUTHHTTPADDRESS: `${process.env.MEDIAMTX_AUTH_URL ?? `http://127.0.0.1:${port}/api/internal/mediamtx-auth`}?k=${encodeURIComponent(process.env.MEDIAMTX_AUTH_SECRET ?? "")}`,
  MTX_PATHDEFAULTS_RECORDPATH: recordPattern,
  MTX_PATHDEFAULTS_RECORDSEGMENTDURATION: `${process.env.RECORD_SEGMENT_MINUTES ?? "15"}m`,
};

console.log(`[mediamtx] binary: ${binary}`);
console.log(`[mediamtx] config: ${config}`);
console.log(`[mediamtx] auth:   ${env.MTX_AUTHHTTPADDRESS.replace(/\?k=.*/, "?k=***")}`);
console.log(`[mediamtx] record: ${recordingRoot}`);

const child = spawn(binary, [config], { stdio: "inherit", env, cwd: root });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill());
}
