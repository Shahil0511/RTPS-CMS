// Downloads the MediaMTX release that matches this OS/CPU into mediamtx/bin.
// Usage: npm run mediamtx:download
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const VERSION = "v1.21.3";
const root = process.cwd();
const binDir = path.join(root, "mediamtx", "bin");
fs.mkdirSync(binDir, { recursive: true });

const platform = { win32: "windows", linux: "linux", darwin: "darwin" }[process.platform];
const arch = { x64: "amd64", arm64: "arm64", arm: "armv7" }[process.arch];
if (!platform || !arch) {
  console.error(`Unsupported platform ${process.platform}/${process.arch}`);
  process.exit(1);
}
const ext = platform === "windows" ? "zip" : "tar.gz";
const asset = `mediamtx_${VERSION}_${platform}_${arch}.${ext}`;
const url = `https://github.com/bluenviron/mediamtx/releases/download/${VERSION}/${asset}`;
const tmp = path.join(os.tmpdir(), asset);

console.log(`Downloading ${url}`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status}`);
  process.exit(1);
}
fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));

if (ext === "zip") {
  const ps = `Expand-Archive -Force -LiteralPath "${tmp}" -DestinationPath "${binDir}"`;
  execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: "inherit" });
} else {
  execSync(`tar -xzf "${tmp}" -C "${binDir}"`, { stdio: "inherit" });
  fs.chmodSync(path.join(binDir, "mediamtx"), 0o755);
}
// The archive ships its own mediamtx.yml; the VMS uses ../mediamtx.yml instead.
const shippedConfig = path.join(binDir, "mediamtx.yml");
if (fs.existsSync(shippedConfig)) fs.rmSync(shippedConfig);
fs.rmSync(tmp, { force: true });
console.log(`MediaMTX ${VERSION} installed in ${binDir}`);
