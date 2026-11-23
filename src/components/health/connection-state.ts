import type { CameraStatus, ConnectionMode } from "@/db/schema";
import { CONNECTION_MODE_LABELS, VENDORS, isConnectable, vendorOf, type CapabilityLevel, type VendorId } from "@/lib/vendors";

/**
 * What the estate UI says about a recorder. Pure helpers (no server or client deps), shared by the
 * dashboard, stores, recorders and health pages so every page labels recorders the same way.
 *
 *  LIVE     - connectable and online.
 *  OFFLINE  - connectable and the last check failed (the only state that is an outage).
 *  CHECKING - connectable but not checked yet.
 *  PENDING  - known recorder without a network path from the server (never alerted on).
 *  CLOUD    - only reachable through the vendor's cloud app (never alerted on).
 *  DISABLED - switched off by an administrator.
 */
export type LinkState = "LIVE" | "OFFLINE" | "CHECKING" | "PENDING" | "CLOUD" | "DISABLED";

export const LINK_STATES: LinkState[] = ["LIVE", "OFFLINE", "CHECKING", "PENDING", "CLOUD", "DISABLED"];

export type Tone = "success" | "warning" | "neutral" | "danger" | "info" | "accent";

export const LINK_STATE_META: Record<LinkState, { label: string; tone: Tone; description: string }> = {
  LIVE: { label: CONNECTION_MODE_LABELS.DIRECT.label, tone: "success", description: CONNECTION_MODE_LABELS.DIRECT.description },
  OFFLINE: { label: "Offline", tone: "danger", description: "Connected recorder that failed its last health check. Its cameras are down and alerts are sent." },
  CHECKING: { label: "Not checked yet", tone: "info", description: "Connected recorder waiting for its first health check." },
  PENDING: { label: CONNECTION_MODE_LABELS.PENDING_NETWORK.label, tone: "warning", description: CONNECTION_MODE_LABELS.PENDING_NETWORK.description },
  CLOUD: { label: CONNECTION_MODE_LABELS.CLOUD_ONLY.label, tone: "neutral", description: CONNECTION_MODE_LABELS.CLOUD_ONLY.description },
  DISABLED: { label: "Disabled", tone: "neutral", description: "Switched off by an administrator. Not monitored." },
};

export interface LinkInput {
  connectionMode: ConnectionMode | string;
  host: string;
  isEnabled: boolean;
  status: CameraStatus;
}

export function recorderLinkState(d: LinkInput): LinkState {
  if (!d.isEnabled) return "DISABLED";
  if (d.connectionMode === "CLOUD_ONLY") return "CLOUD";
  if (!isConnectable(d)) return "PENDING";
  if (d.status === "ONLINE") return "LIVE";
  if (d.status === "OFFLINE") return "OFFLINE";
  return "CHECKING";
}

/** Store-level summary: an outage wins, then live, then the "not connected yet" states. */
export function summariseLinkStates(states: LinkState[]): LinkState | "NONE" {
  if (states.length === 0) return "NONE";
  for (const s of ["OFFLINE", "LIVE", "CHECKING", "PENDING", "CLOUD", "DISABLED"] as const) if (states.includes(s)) return s;
  return "NONE";
}

/**
 * Vendor of a recorder. Tyco Holis recorders are stored with the Hikvision protocol vendor
 * (they speak ISAPI), so the model or name decides between the two.
 */
export function deviceVendorId(d: { vendor: string | null; model?: string | null; name?: string | null }): VendorId {
  const v = vendorOf(d.vendor);
  if (v === "hikvision" || v === "unknown") {
    const hint = `${d.model ?? ""} ${d.name ?? ""}`;
    if (/holis|tyco|\bHRN-/i.test(hint)) return "tyco";
  }
  return v;
}

/** Buckets used by the "Coverage by OEM" panel and the stores filter. */
export type OemGroup = "cpplus" | "hikvision" | "tyco" | "honeywell" | "other";
export const OEM_GROUPS: Array<{ id: OemGroup; label: string; vendor: VendorId }> = [
  { id: "cpplus", label: VENDORS.cpplus.label, vendor: "cpplus" },
  { id: "hikvision", label: VENDORS.hikvision.label, vendor: "hikvision" },
  { id: "tyco", label: VENDORS.tyco.label, vendor: "tyco" },
  { id: "honeywell", label: VENDORS.honeywell.label, vendor: "honeywell" },
  { id: "other", label: "Other / unknown", vendor: "unknown" },
];

export function oemGroupOf(v: VendorId): OemGroup {
  return v === "cpplus" || v === "hikvision" || v === "tyco" || v === "honeywell" ? v : "other";
}

export function vendorLabel(v: VendorId): string {
  return VENDORS[v]?.label ?? "Unknown";
}

export const CAPABILITY_META: Record<CapabilityLevel | "blocked", { label: string; tone: Tone; description: string }> = {
  verified: { label: "Verified", tone: "success", description: "Working on a real recorder of this make." },
  supported: { label: "Supported", tone: "info", description: "Implemented; not yet proven on site for this make." },
  unverified: { label: "Unverified", tone: "warning", description: "Expected to work through the vendor protocol, not tested yet." },
  unsupported: { label: "Not available", tone: "neutral", description: "The vendor offers no integration for this." },
  blocked: { label: "Blocked", tone: "neutral", description: "No recorder of this make is reachable from the server yet." },
};

/** True when the capability is usable today (implemented and either proven or implemented-in-code). */
export function capabilityUsable(level: CapabilityLevel): boolean {
  return level === "verified" || level === "supported";
}

/** Serial numbers are shown with only their last four characters. */
export function maskSerial(serial: string | null | undefined): string | null {
  const s = (serial ?? "").trim();
  if (!s) return null;
  if (s.length <= 4) return s;
  return `${"•".repeat(Math.min(6, s.length - 4))}${s.slice(-4)}`;
}

export interface DataQualityFlag {
  key: string;
  label: string;
  tone: Tone;
}

/** Data-quality problems recorded in the import notes (duplicate IPs, placeholder serials, …). */
export function dataQualityFlags(notes: string | null | undefined): DataQualityFlag[] {
  const n = notes ?? "";
  if (!n.trim()) return [];
  const flags: DataQualityFlag[] = [];
  const add = (key: string, label: string, tone: Tone = "warning") => {
    if (!flags.some((f) => f.key === key)) flags.push({ key, label, tone });
  };
  if (/duplicate ip/i.test(n)) add("dup-ip", "Duplicate IP");
  if (/placeholder|round number/i.test(n) && /serial/i.test(n)) add("serial", "Placeholder serial");
  if (/network address|not a usable host/i.test(n)) add("address", "Address unclear");
  else if (/\/\d{1,2}\b.*suffix/i.test(n)) add("address", "Address normalised", "neutral");
  if (/vendor and\/or serial missing|vendor missing|serial missing/i.test(n)) add("missing", "Vendor/serial missing");
  if (/\bmarked NA\b|not-yet-documented|undocumented/i.test(n)) add("undocumented", "Undocumented device", "neutral");
  if (/\bhold\b/i.test(n)) add("hold", "Site on hold", "neutral");
  if (flags.length === 0 && /verify|confirm/i.test(n)) add("confirm", "Needs IT confirmation");
  return flags;
}
