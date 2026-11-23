// Imports the store recorder inventory (config/store-cameras.json) into vms.stores and vms.devices.
//
//   npm run estate:import                 dry run: reads the database, prints what would change, writes nothing
//   npm run estate:import -- --apply      writes the changes in one transaction
//   npm run estate:import -- --offline    plan from the JSON only (no database; .env is optional)
//   npm run estate:import -- --file <path>  use another inventory file
//
// Idempotent: stores are matched by name, then by their existing code; recorders by (store, serial),
// then (store, host), then (store, name). Running it twice changes nothing the second time.
// The import never makes a recorder Live: recorders with an address are PENDING_NETWORK (CLOUD_ONLY
// without one), because a private store IP can also answer from another LAN. An administrator
// confirms the recorder and switches it to Live on the Recorders page.
// Two recorders of one store can never share an address: such rows are reported as "conflict".
// Cameras are NOT created (channel counts are unknown until a recorder is reachable).
// Recorders that are already Live (DIRECT / RELAY) keep their address, mode, vendor and credentials.
// Passwords are encrypted with src/lib/crypto.ts and are never printed; usernames are not printed either.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ConnectionMode, Device, DeviceKind, Store } from "../src/db/schema";
import { DEVICE_VENDOR_OPTIONS, vendorOf, type DeviceVendorValue } from "../src/lib/vendors";

// ---------------------------------------------------------------------------------------------
// Input

interface SheetRow {
  name?: string | null;
  email?: string | null;
  vendor?: string | null;
  ip?: string | null;
  username?: string | null;
  /** Secret. Only ever passed to encryptSecret / compared, never printed. */
  password?: string | null;
  serial?: string | null;
  reachable?: boolean | null;
  note?: string | null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "true";
}

const APPLY = arg("apply") === "true";
const OFFLINE = arg("offline") === "true";
const FILE = path.resolve(process.cwd(), arg("file") ?? "config/store-cameras.json");
const ACTOR = "estate-import";

// ---------------------------------------------------------------------------------------------
// Normalisation

const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
const nameKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const shortHash = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 3).toUpperCase();

/** "Lajpat Nagar 1 (device 2)" -> { store: "Lajpat Nagar 1", deviceNo: 2 } */
function splitDeviceSuffix(raw: string): { store: string; deviceNo: number | null } {
  const m = /^(.*?)\s*\(\s*device\s*(\d+)\s*\)\s*$/i.exec(raw);
  if (!m) return { store: raw, deviceNo: null };
  return { store: clean(m[1]), deviceNo: Number(m[2]) };
}

function baseCode(storeName: string): string {
  const s = storeName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  return s.length >= 2 ? s : `ST${s}`.padEnd(2, "X");
}
const hashedCode = (storeName: string): string => `${baseCode(storeName).slice(0, 8)}-${shortHash(nameKey(storeName))}`;

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function parseIp(raw: string | null | undefined): { host: string; flag: string | null } {
  const v = clean(raw).replace(/\/\d{1,2}$/, "");
  if (!v) return { host: "", flag: null };
  if (!IPV4.test(v)) return { host: "", flag: "INVALID IP" };
  const last = Number(v.split(".")[3]);
  if (last === 0 || last === 255) return { host: "", flag: "INVALID IP (network/broadcast address)" };
  return { host: v, flag: null };
}

function mapVendor(raw: string | null | undefined): DeviceVendorValue {
  const id = vendorOf(raw);
  const v = (raw ?? "").toLowerCase();
  if (id === "honeywell") return v.includes("hik") ? "honeywell-hikvision" : v.includes("dahua") ? "honeywell-dahua" : "honeywell";
  if (id === "onvif") return "generic";
  return id;
}

const HIK_MODEL = /^(i?DS-\d{4}[A-Z]+-[A-Z]\d)/i;

/** Splits the sheet's serial column into serial / model and data-quality flags. */
function parseSerial(raw: string | null | undefined, note: string): { serial: string | null; model: string | null; placeholder: string | null; flags: string[] } {
  const v = clean(raw);
  if (!v) return { serial: null, model: null, placeholder: null, flags: ["NO SERIAL"] };
  if (/0{8,}$/.test(v) || /placeholder/i.test(note)) {
    return { serial: null, model: null, placeholder: v, flags: ["PLACEHOLDER SERIAL"] };
  }
  const parts = v.split(/\s*\/\s*/);
  const head = parts[0] ?? v;
  const model = HIK_MODEL.exec(head)?.[1]?.toUpperCase() ?? null;
  // "DS-7632NXI-K2" alone is a model number, not a serial (several stores share it).
  if (model && head.length <= model.length + 1 && parts.length === 1) {
    return { serial: null, model, placeholder: null, flags: ["SERIAL IS A MODEL NUMBER"] };
  }
  return { serial: v, model, placeholder: null, flags: [] };
}

function kindOf(vendorRaw: string, model: string | null): DeviceKind {
  if (/\bdvr\b/i.test(vendorRaw)) return "DVR";
  // Hikvision DS-7xxxH* / iDS-7xxxH* are Turbo HD DVRs; DS-7xxxN* are NVRs.
  if (model && /^i?DS-\d{4}H/i.test(model)) return "DVR";
  return "NVR";
}

function cloudPlatformFor(vendor: DeviceVendorValue, raw: string, note: string): { platform: string | null; assumed: boolean } {
  if (/ih ?view/i.test(raw) || /ih ?view/i.test(note)) return { platform: "IH View", assumed: false };
  if (/instaon/i.test(raw) || /instaon/i.test(note)) return { platform: "InstaOnCloud", assumed: false };
  if (/hik-?connect/i.test(raw) || /hik-?connect/i.test(note)) return { platform: "Hik-Connect", assumed: false };
  if (vendor === "cpplus") return { platform: "InstaOnCloud", assumed: true };
  if (vendor === "hikvision" || vendor === "honeywell-hikvision") return { platform: "Hik-Connect", assumed: true };
  return { platform: null, assumed: false };
}

const vendorShort = (v: DeviceVendorValue): string =>
  v === "unknown" ? "" : (DEVICE_VENDOR_OPTIONS.find((o) => o.value === v)?.label ?? v).replace(/\s*\(.*\)$/, "");

// ---------------------------------------------------------------------------------------------
// Plan

interface PlannedDevice {
  row: number;
  storeName: string;
  storeKey: string;
  name: string;
  kind: DeviceKind;
  vendor: DeviceVendorValue;
  host: string;
  connectionMode: ConnectionMode;
  cloudPlatform: string | null;
  serialNumber: string | null;
  model: string | null;
  username: string | null;
  password: string;
  flags: string[];
  importNotes: string[];
  /** "(device N)" number from the sheet, used for stable names. */
  deviceNo: number | null;
}

interface PlannedStore {
  key: string;
  name: string;
  code: string;
  email: string | null;
  devices: PlannedDevice[];
}

interface Skipped {
  row: number;
  name: string;
  reason: string;
}

const IMPORT_PREFIXES = ["Import:", "Data quality:", "Sheet note:", "Sheet serial:"];

function buildPlan(rows: SheetRow[], sheetDate: string): { stores: PlannedStore[]; skipped: Skipped[] } {
  const skipped: Skipped[] = [];
  const candidates: Array<{ i: number; r: SheetRow; storeName: string; deviceNo: number | null; note: string }> = [];

  rows.forEach((r, i) => {
    const raw = clean(r.name);
    const note = clean(r.note);
    if (!raw) {
      skipped.push({ row: i, name: "(no name)", reason: "row has no store name" });
      return;
    }
    const { store, deviceNo } = splitDeviceSuffix(raw);
    if (/\bhold\b/i.test(note)) {
      skipped.push({ row: i, name: raw, reason: "marked Hold in the sheet (not a live site)" });
      return;
    }
    if (/\bmarked NA\b|^NA$/i.test(note)) {
      skipped.push({ row: i, name: raw, reason: "marked NA in the sheet (undocumented second device)" });
      return;
    }
    if (!clean(r.vendor) && !clean(r.ip) && !clean(r.username) && !clean(r.serial)) {
      skipped.push({ row: i, name: raw, reason: "no vendor, address, serial or login: nothing to import" });
      return;
    }
    candidates.push({ i, r, storeName: store, deviceNo, note });
  });

  // Duplicate addresses across the estate (store LANs reuse 192.168.1.x).
  const byIp = new Map<string, Set<string>>();
  for (const c of candidates) {
    const { host } = parseIp(c.r.ip);
    if (!host) continue;
    const set = byIp.get(host) ?? new Set<string>();
    set.add(clean(c.r.name));
    byIp.set(host, set);
  }

  const stores = new Map<string, PlannedStore>();
  for (const c of candidates) {
    const key = nameKey(c.storeName);
    let store = stores.get(key);
    if (!store) {
      store = { key, name: c.storeName, code: "", email: null, devices: [] };
      stores.set(key, store);
    }
    const email = clean(c.r.email).toLowerCase();
    if (!store.email && email.includes("@")) store.email = email;

    const vendorRaw = clean(c.r.vendor);
    const vendor = mapVendor(vendorRaw);
    const ip = parseIp(c.r.ip);
    const serial = parseSerial(c.r.serial, c.note);
    const kind = kindOf(vendorRaw, serial.model);
    const cloud = cloudPlatformFor(vendor, vendorRaw, c.note);
    const password = c.r.password ?? "";
    const username = clean(c.r.username) || null;

    const flags: string[] = [];
    if (!vendorRaw) flags.push("VENDOR MISSING");
    if (ip.flag) flags.push(ip.flag);
    else if (!ip.host) flags.push("NO IP");
    const others = ip.host ? [...(byIp.get(ip.host) ?? [])].filter((n) => n !== clean(c.r.name)) : [];
    if (others.length) flags.push(`DUPLICATE IP (also ${others.join(", ")})`);
    flags.push(...serial.flags);
    if (!username || !password) flags.push("NO CREDENTIALS");
    // Never DIRECT: "reachable" in the sheet only means something answered at that private address.
    const connectionMode: ConnectionMode = ip.host || ip.flag ? "PENDING_NETWORK" : "CLOUD_ONLY";

    const importNotes = [`Import: store sheet ${sheetDate} (config/store-cameras.json)`];
    if (flags.length) importNotes.push(`Data quality: ${flags.join("; ")}`);
    if (cloud.assumed && cloud.platform) importNotes.push(`Import: cloud platform ${cloud.platform} assumed from vendor, confirm with the store`);
    if (serial.placeholder) importNotes.push(`Sheet serial: ${serial.placeholder}`);
    if (c.note) importNotes.push(`Sheet note: ${c.note}`);
    if (ip.host && c.r.reachable === true) {
      importNotes.push("Import: the address answered when the sheet was tested. Confirm it is this recorder (model/serial on its web page), then switch it to Live.");
    }

    store.devices.push({
      row: c.i,
      storeName: c.storeName,
      storeKey: key,
      name: "",
      kind,
      vendor,
      host: ip.host,
      connectionMode,
      cloudPlatform: cloud.platform,
      serialNumber: serial.serial,
      model: serial.model,
      username,
      password,
      flags,
      importNotes,
      deviceNo: c.deviceNo,
    });
  }

  // Stable recorder names: "CP Plus NVR", "Hikvision NVR 2" when a store has several.
  for (const s of stores.values()) {
    s.devices.forEach((d, idx) => {
      const n = d.deviceNo ?? idx + 1;
      const label = [vendorShort(d.vendor), d.kind].filter(Boolean).join(" ") || "Recorder";
      d.name = s.devices.length > 1 ? `${label} ${n}` : label;
    });
  }

  // Codes: readable base, hashed when two different stores would share it.
  const bases = new Map<string, number>();
  for (const s of stores.values()) bases.set(baseCode(s.name), (bases.get(baseCode(s.name)) ?? 0) + 1);
  for (const s of stores.values()) s.code = (bases.get(baseCode(s.name)) ?? 0) > 1 ? hashedCode(s.name) : baseCode(s.name);

  return { stores: [...stores.values()], skipped };
}

function mergeNotes(existing: string | null, importNotes: string[]): string | null {
  const kept = (existing ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !IMPORT_PREFIXES.some((p) => l.trim().startsWith(p)));
  const out = [...importNotes, ...kept].join("\n").trim();
  return out ? out.slice(0, 1000) : null;
}

// ---------------------------------------------------------------------------------------------
// Output

type Action = "create" | "update" | "unchanged" | "kept-live" | "conflict" | "plan";

interface ReportLine {
  store: string;
  code: string;
  device: string;
  vendor: string;
  kind: string;
  mode: string;
  host: string;
  creds: string;
  action: Action;
  flags: string;
}

function printTable(lines: ReportLine[]) {
  const cols: Array<[keyof ReportLine, string]> = [
    ["store", "Store"],
    ["code", "Code"],
    ["device", "Recorder"],
    ["vendor", "Vendor"],
    ["kind", "Kind"],
    ["mode", "Mode"],
    ["host", "Host"],
    ["creds", "Login"],
    ["action", "Action"],
    ["flags", "Flags"],
  ];
  const max: Record<string, number> = { store: 32, device: 18, flags: 90 };
  const cut = (k: string, v: string) => (max[k] && v.length > max[k] ? `${v.slice(0, max[k] - 1)}…` : v);
  const width = cols.map(([k, h]) => Math.max(h.length, ...lines.map((l) => cut(k, String(l[k])).length)));
  const fmt = (vals: string[]) => vals.map((v, i) => v.padEnd(width[i] ?? 0)).join("  ");
  console.log(fmt(cols.map(([, h]) => h)));
  console.log(width.map((w) => "-".repeat(w)).join("  "));
  for (const l of lines) console.log(fmt(cols.map(([k]) => cut(k, String(l[k])))));
}

// ---------------------------------------------------------------------------------------------
// Main

async function main() {
  if (!fs.existsSync(FILE)) throw new Error(`Inventory file not found: ${path.relative(process.cwd(), FILE)}`);
  const json = JSON.parse(fs.readFileSync(FILE, "utf8")) as { stores?: SheetRow[]; lastTestedAt?: string };
  if (!Array.isArray(json.stores)) throw new Error("Inventory file has no top-level stores[] array.");
  const sheetDate = clean(json.lastTestedAt) || "unknown date";
  const plan = buildPlan(json.stores, sheetDate);

  console.log(`Estate import from ${path.relative(process.cwd(), FILE)}: ${json.stores.length} rows, ${plan.stores.length} stores, ${plan.stores.reduce((n, s) => n + s.devices.length, 0)} recorders, ${plan.skipped.length} skipped.`);
  console.log(APPLY ? "Mode: APPLY (writing to the database)\n" : OFFLINE ? "Mode: OFFLINE plan (database not read)\n" : "Mode: DRY RUN (database read only, nothing written). Add --apply to write.\n");

  const lines: ReportLine[] = [];
  const line = (s: PlannedStore, code: string, d: PlannedDevice, action: Action): ReportLine => ({
    store: s.name,
    code,
    device: d.name,
    vendor: d.vendor,
    kind: d.kind,
    mode: d.connectionMode,
    host: d.host || "-",
    creds: d.username && d.password ? "yes" : "no",
    action,
    flags: d.flags.join("; ") || "-",
  });

  if (OFFLINE) {
    for (const s of plan.stores) for (const d of s.devices) lines.push(line(s, s.code, d, "plan"));
    printTable(lines);
    printSkipped(plan.skipped);
    printTotals(lines);
    return;
  }

  // Database modules are loaded only here so --offline needs no .env.
  const { and, eq } = await import("drizzle-orm");
  const { db, pool } = await import("../src/db");
  const { auditLogs, devices, stores } = await import("../src/db/schema");
  const { decryptSecret, encryptSecret } = await import("../src/lib/crypto");

  try {
    try {
      await db.select({ id: devices.id, mode: devices.connectionMode }).from(devices).limit(1);
    } catch (e) {
      throw new Error(`Database not ready (${safeMessage(e)}). Run "npm run db:migrate" first.`);
    }

    const existingStores: Store[] = await db.select().from(stores);
    const existingDevices: Device[] = await db.select().from(devices);
    const storeByKey = new Map(existingStores.map((s) => [nameKey(s.name), s]));
    const existingByCode = new Map(existingStores.map((s) => [s.code, s]));
    /** Codes in use: existing stores plus stores this run creates. */
    const storeByCode = new Map(existingStores.map((s) => [s.code, s]));
    /**
     * Address owner per store across the whole run ("host:port" -> device id or "plan:<row>"),
     * starting from the database and updated by every create and host change, so the unique index
     * (store, host, rtsp_port) is never hit: a would-be duplicate is reported as a conflict row.
     */
    const endpoints = new Map<string, Map<string, string>>();
    for (const e of existingDevices) {
      const m = endpoints.get(e.storeId) ?? new Map<string, string>();
      m.set(`${e.host}:${e.rtspPort}`, e.id);
      endpoints.set(e.storeId, m);
    }

    const sameSecret = (enc: string | null, plain: string): boolean => {
      if (!enc) return !plain;
      if (!plain) return true; // nothing to set: keep the stored one
      try {
        return decryptSecret(enc) === plain;
      } catch {
        return false;
      }
    };

    let storesCreated = 0;
    let storesUpdated = 0;
    let devicesCreated = 0;
    let devicesUpdated = 0;

    const run = async (tx: typeof db) => {
      for (const s of plan.stores) {
        // 1. Store: by name, else by its existing code (a store renamed in the UI keeps its code).
        let store = storeByKey.get(s.key) ?? existingByCode.get(s.code);
        let code = store?.code ?? s.code;
        if (!store) {
          const clash = storeByCode.get(code);
          if (clash) code = hashedCode(s.name);
          if (storeByCode.has(code)) throw new Error(`Store code ${code} for "${s.name}" is already used by "${storeByCode.get(code)?.name}". Rename one of them.`);
          if (APPLY) {
            const [row] = await tx.insert(stores).values({ code, name: s.name, kind: "STORE", email: s.email, notes: `Import: store sheet ${sheetDate}` }).returning();
            store = row;
            await tx.insert(auditLogs).values({ actorEmail: ACTOR, action: "store.created", entityType: "store", entityId: row?.id, entityLabel: s.name, details: JSON.stringify({ code, source: "estate-import" }) });
          }
          storesCreated++;
          storeByCode.set(code, store ?? ({ name: s.name } as Store));
        } else if (!store.email && s.email) {
          if (APPLY) {
            await tx.update(stores).set({ email: s.email }).where(eq(stores.id, store.id));
            await tx.insert(auditLogs).values({ actorEmail: ACTOR, action: "store.updated", entityType: "store", entityId: store.id, entityLabel: store.name, details: JSON.stringify({ email: "set from store sheet", source: "estate-import" }) });
          }
          storesUpdated++;
        }

        // 2. Recorders
        const inStore = store ? existingDevices.filter((d) => d.storeId === store.id) : [];
        const claimed = new Set<string>();
        const storeEndpointKey = store?.id ?? `plan:${s.key}`;
        const taken = endpoints.get(storeEndpointKey) ?? new Map<string, string>();
        endpoints.set(storeEndpointKey, taken);
        for (const d of s.devices) {
          const match =
            (d.serialNumber ? inStore.find((e) => !claimed.has(e.id) && e.serialNumber === d.serialNumber) : undefined) ??
            (d.host ? inStore.find((e) => !claimed.has(e.id) && e.host === d.host && e.rtspPort === 554) : undefined) ??
            inStore.find((e) => !claimed.has(e.id) && e.name === d.name);

          if (!match) {
            if (taken.has(`${d.host}:554`)) {
              lines.push(line(s, code, d, "conflict"));
              continue;
            }
            taken.set(`${d.host}:554`, `plan:${d.row}`);
            if (APPLY && store) {
              const [row] = await tx
                .insert(devices)
                .values({
                  storeId: store.id,
                  name: d.name,
                  kind: d.kind,
                  vendor: d.vendor,
                  host: d.host,
                  rtspPort: 554,
                  httpPort: 80,
                  connectionMode: d.connectionMode,
                  cloudPlatform: d.cloudPlatform,
                  serialNumber: d.serialNumber,
                  model: d.model,
                  username: d.username,
                  passwordEnc: d.password ? encryptSecret(d.password) : null,
                  isEnabled: true,
                  notes: mergeNotes(null, d.importNotes),
                })
                .returning({ id: devices.id });
              await tx.insert(auditLogs).values({
                actorEmail: ACTOR,
                action: "device.created",
                entityType: "device",
                entityId: row?.id,
                entityLabel: d.name,
                details: JSON.stringify({ store: code, vendor: d.vendor, connectionMode: d.connectionMode, host: d.host, source: "estate-import" }),
              });
            }
            devicesCreated++;
            lines.push(line(s, code, d, "create"));
            continue;
          }

          claimed.add(match.id);
          const live = match.connectionMode === "DIRECT" || match.connectionMode === "RELAY";
          // Live recorders were configured by hand: only inventory fields and the import notes are refreshed.
          const set: Partial<typeof devices.$inferInsert> = {};
          const notes = mergeNotes(match.notes, d.importNotes);
          if (notes !== match.notes) set.notes = notes;
          if (!match.serialNumber && d.serialNumber) set.serialNumber = d.serialNumber;
          if (!match.model && d.model) set.model = d.model;
          if (!match.cloudPlatform && d.cloudPlatform) set.cloudPlatform = d.cloudPlatform;
          if (!live) {
            if (match.vendor !== d.vendor) set.vendor = d.vendor;
            if (match.kind !== d.kind) set.kind = d.kind;
            // A recorder that keeps its stored address stays PENDING_NETWORK rather than CLOUD_ONLY.
            const mode: ConnectionMode = d.connectionMode === "CLOUD_ONLY" && match.host ? "PENDING_NETWORK" : d.connectionMode;
            if (match.connectionMode !== mode) set.connectionMode = mode;
            if (match.host !== d.host && !(d.host === "" && match.host)) {
              const next = `${d.host}:${match.rtspPort}`;
              const owner = taken.get(next);
              if (owner && owner !== match.id) {
                lines.push(line(s, code, d, "conflict"));
                continue;
              }
              const prev = `${match.host}:${match.rtspPort}`;
              if (taken.get(prev) === match.id) taken.delete(prev);
              taken.set(next, match.id);
              set.host = d.host;
            }
            if (d.username && match.username !== d.username) set.username = d.username;
            if (d.password && !sameSecret(match.passwordEnc, d.password)) set.passwordEnc = encryptSecret(d.password);
          }
          const changed = Object.keys(set);
          if (!changed.length) {
            lines.push(line(s, code, d, live ? "kept-live" : "unchanged"));
            continue;
          }
          if (APPLY) {
            await tx.update(devices).set(set).where(and(eq(devices.id, match.id), eq(devices.storeId, match.storeId)));
            await tx.insert(auditLogs).values({
              actorEmail: ACTOR,
              action: "device.updated",
              entityType: "device",
              entityId: match.id,
              entityLabel: match.name,
              // Field names only: never values of credentials.
              details: JSON.stringify({ store: code, fields: changed.map((k) => (k === "passwordEnc" ? "password" : k)), source: "estate-import" }),
            });
          }
          devicesUpdated++;
          lines.push(line(s, code, d, live ? "kept-live" : "update"));
        }
      }
    };

    if (APPLY) await db.transaction(async (tx) => run(tx as unknown as typeof db));
    else await run(db);

    printTable(lines);
    printSkipped(plan.skipped);
    printTotals(lines);
    console.log(
      `\nStores: ${storesCreated} ${APPLY ? "created" : "to create"}, ${storesUpdated} ${APPLY ? "updated" : "to update"}. Recorders: ${devicesCreated} ${APPLY ? "created" : "to create"}, ${devicesUpdated} ${APPLY ? "updated" : "to update"}.`,
    );
    if (!APPLY) console.log("Dry run only. Re-run with --apply to write these changes.");
  } finally {
    await pool.end();
  }
}

function printSkipped(skipped: Skipped[]) {
  if (!skipped.length) return;
  console.log(`\nSkipped rows (${skipped.length}):`);
  for (const s of skipped) console.log(`  row ${s.row + 1}: ${s.name} - ${s.reason}`);
}

function printTotals(lines: ReportLine[]) {
  const count = (f: (l: ReportLine) => string) => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(f(l), (m.get(f(l)) ?? 0) + 1);
    return [...m.entries()].map(([k, n]) => `${k} ${n}`).join(", ");
  };
  console.log(`\nBy vendor: ${count((l) => l.vendor)}`);
  console.log(`By mode:   ${count((l) => l.mode)}`);
  console.log(`By action: ${count((l) => l.action)}`);
  const flagged = lines.filter((l) => l.flags !== "-").length;
  console.log(`With data-quality flags: ${flagged} of ${lines.length}`);
}

/** Error text without query parameters (drizzle appends them, and they hold encrypted secrets and usernames). */
function safeMessage(e: unknown): string {
  const err = e as Error & { cause?: Error };
  const own = String(err?.message ?? e).split(/\r?\nparams:/)[0] ?? "";
  const cause = err?.cause?.message ? ` (${String(err.cause.message).split(/\r?\nparams:/)[0]})` : "";
  return `${own.slice(0, 500)}${cause}`;
}

main().catch((e) => {
  console.error(`estate:import failed: ${safeMessage(e)}`);
  process.exit(1);
});
