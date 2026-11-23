import type { ConnectionMode } from "@/db/schema";

/**
 * Vendor catalogue and connection-mode helpers.
 *
 * Pure data with no secrets or server dependencies, so it is safe to import from
 * client components (badges, forms, capability tables). Vendor adapters that talk
 * to recorders belong in their own server-only modules next to this file
 * (see ./adapters.ts).
 */

export type VendorId = "hikvision" | "tyco" | "cpplus" | "dahua" | "honeywell" | "onvif" | "unknown";

export type CapabilityLevel = "verified" | "supported" | "unverified" | "unsupported";

/**
 * Wire protocol the server speaks to a recorder, independent of the brand on the box.
 *  isapi    - Hikvision ISAPI + /Streaming/Unicast/channels/<ch>0<1|2> (Hikvision, Tyco Holis, Hikvision-OEM Honeywell)
 *  dahua    - Dahua RTSP /cam/realmonitor?channel=<n>&subtype=<0|1> (CP Plus, Dahua, Dahua-OEM Honeywell)
 *  template - user-supplied RTSP path template with {channel}/{stream} placeholders (ONVIF / generic)
 */
export type ProtocolFamily = "isapi" | "dahua" | "template";

export interface VendorInfo {
  label: string;
  /** Integration protocol the server uses with this vendor. */
  protocol: string;
  /** Default protocol family. Honeywell is decided per device (see protocolFamilyOf). */
  family: ProtocolFamily;
  live: CapabilityLevel;
  playback: CapabilityLevel;
  download: CapabilityLevel;
  health: CapabilityLevel;
  notes: string;
}

export const VENDORS: Record<VendorId, VendorInfo> = {
  hikvision: {
    label: "Hikvision",
    protocol: "ISAPI + RTSP",
    family: "isapi",
    live: "verified",
    playback: "verified",
    download: "verified",
    health: "verified",
    notes: "Channel import, recorder playback, clip download and disk/clock health via ISAPI. Accounts lock after repeated bad logins, so failed logins back off for 30 minutes.",
  },
  tyco: {
    label: "Tyco Holis",
    protocol: "Hikvision ISAPI + RTSP",
    family: "isapi",
    live: "verified",
    playback: "verified",
    download: "verified",
    health: "verified",
    notes: "Holis HRN recorders are Hikvision OEM and use the same ISAPI integration (verified on two HRN-64081S-R units, 115 channels).",
  },
  cpplus: {
    label: "CP Plus",
    protocol: "Dahua-compatible RTSP",
    family: "dahua",
    live: "unverified",
    playback: "unverified",
    download: "unverified",
    health: "supported",
    notes:
      "Dahua OEM. Live uses /cam/realmonitor, playback uses /cam/playback with starttime/endtime. Not yet tested against a real unit: every CP Plus recorder is on a private store LAN with no route from the server. Cloud-only (InstaOnCloud) units have no API the server can use.",
  },
  dahua: {
    label: "Dahua",
    protocol: "Dahua RTSP",
    family: "dahua",
    live: "unverified",
    playback: "unverified",
    download: "unverified",
    health: "supported",
    notes: "Same protocol family as CP Plus. Not yet tested against a real unit.",
  },
  honeywell: {
    label: "Honeywell",
    protocol: "Hikvision ISAPI, Dahua RTSP or ONVIF (model dependent)",
    family: "template",
    live: "unverified",
    playback: "unverified",
    download: "unverified",
    health: "supported",
    notes:
      "Most Honeywell recorders are Hikvision or Dahua OEM. Pick the protocol family on the recorder (Hikvision OEM / Dahua OEM), or give an RTSP path template. Not yet tested against a real unit.",
  },
  onvif: {
    label: "Generic ONVIF / RTSP",
    protocol: "RTSP path template",
    family: "template",
    live: "supported",
    playback: "unsupported",
    download: "unsupported",
    health: "supported",
    notes: "Any recorder or camera that serves RTSP. Give the channel path as a template, for example /stream{stream}/ch{channel}. Playback is not available without a vendor API.",
  },
  unknown: {
    label: "Unknown",
    protocol: "RTSP",
    family: "template",
    live: "unverified",
    playback: "unsupported",
    download: "unsupported",
    health: "supported",
    notes: "Vendor not recorded. Reachability can still be monitored over TCP once the recorder has a network route.",
  },
};

/** Normalises free-text vendor/brand names (from forms, imports or the stored column) to a VendorId. */
export function vendorOf(raw: string | null | undefined): VendorId {
  const v = (raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!v) return "unknown";
  if (v.includes("tyco") || v.includes("holis")) return "tyco";
  // Checked before "hik": "honeywell-hikvision" is a Honeywell box that speaks ISAPI.
  if (v.includes("honeywell")) return "honeywell";
  if (v.includes("hik") || v.includes("ezviz") || v.includes("prama")) return "hikvision";
  if (v.includes("cpplus") || v === "cp" || v.includes("instaon")) return "cpplus";
  if (v.includes("dahua") || v.includes("imou")) return "dahua";
  if (v.includes("onvif") || v === "generic" || v === "rtsp") return "onvif";
  return "unknown";
}

/**
 * Protocol the server must speak to this recorder. The stored vendor value can carry
 * the OEM family for Honeywell ("honeywell-hikvision", "honeywell-dahua").
 */
export function protocolFamilyOf(raw: string | null | undefined): ProtocolFamily {
  const v = (raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const id = vendorOf(raw);
  if (id === "honeywell") {
    if (v.includes("hik")) return "isapi";
    if (v.includes("dahua")) return "dahua";
    return "template";
  }
  return VENDORS[id].family;
}

/** True for recorders that speak Hikvision ISAPI (channel import, recording search, clip download, disk/clock health). */
export function isIsapiVendor(raw: string | null | undefined): boolean {
  return protocolFamilyOf(raw) === "isapi";
}

/** Display name for a stored vendor value, including the Honeywell OEM family. */
export function vendorLabel(raw: string | null | undefined): string {
  const option = DEVICE_VENDOR_OPTIONS.find((o) => o.value === raw);
  if (option) return option.label;
  return VENDORS[vendorOf(raw)].label;
}

/** Stored `devices.vendor` values offered by the recorder form. Legacy values ("generic") stay valid. */
export const DEVICE_VENDOR_VALUES = ["hikvision", "tyco", "cpplus", "dahua", "honeywell-hikvision", "honeywell-dahua", "honeywell", "generic", "unknown"] as const;
export type DeviceVendorValue = (typeof DEVICE_VENDOR_VALUES)[number];

export const DEVICE_VENDOR_OPTIONS: ReadonlyArray<{ value: DeviceVendorValue; label: string; family: ProtocolFamily; hint: string }> = [
  { value: "hikvision", label: "Hikvision", family: "isapi", hint: "ISAPI: channel import, recorder playback, download and disk health." },
  { value: "tyco", label: "Tyco Holis", family: "isapi", hint: "Hikvision OEM: same ISAPI integration as Hikvision." },
  { value: "cpplus", label: "CP Plus", family: "dahua", hint: "Dahua-compatible RTSP. Unverified until a unit is reachable." },
  { value: "dahua", label: "Dahua", family: "dahua", hint: "Dahua RTSP. Unverified until a unit is reachable." },
  { value: "honeywell-hikvision", label: "Honeywell (Hikvision OEM)", family: "isapi", hint: "Honeywell box that speaks Hikvision ISAPI. Unverified." },
  { value: "honeywell-dahua", label: "Honeywell (Dahua OEM)", family: "dahua", hint: "Honeywell box that speaks Dahua RTSP. Unverified." },
  { value: "honeywell", label: "Honeywell (other / ONVIF)", family: "template", hint: "Give an RTSP path template below." },
  { value: "generic", label: "Generic ONVIF / RTSP", family: "template", hint: "Give an RTSP path template below." },
  { value: "unknown", label: "Unknown / not recorded", family: "template", hint: "Listed for inventory. Give an RTSP path template once the brand is known." },
];

export const CONNECTION_MODE_LABELS: Record<
  ConnectionMode,
  { label: string; tone: "success" | "warning" | "neutral" | "danger"; description: string }
> = {
  DIRECT: {
    label: "Live",
    tone: "success",
    description: "Reachable from the server on its own address. Live view, playback and health checks run directly.",
  },
  RELAY: {
    label: "Live (relay)",
    tone: "success",
    description: "Reachable through a relay or tunnel. Live view, playback and health checks run through it.",
  },
  PENDING_NETWORK: {
    label: "Pending network",
    tone: "warning",
    description: "Known recorder that the server cannot reach yet (private store IP, no route). Not monitored and never alerted on.",
  },
  CLOUD_ONLY: {
    label: "Cloud-only (no API)",
    tone: "neutral",
    description: "Only reachable through the vendor's cloud app. The vendor offers no API for this server, so it is listed but not monitored.",
  },
};

/** Modes whose recorder may have no address yet (host stored as ""). */
export function hostOptionalFor(mode: string): boolean {
  return mode === "PENDING_NETWORK" || mode === "CLOUD_ONLY";
}

/** Vendor cloud platforms seen in the estate (free text is still allowed). */
export const CLOUD_PLATFORMS = ["InstaOnCloud", "Hik-Connect", "IH View", "DMSS", "EZVIZ"] as const;

/** True when the server should probe, stream from and alert on this recorder. */
export function isConnectable(d: { connectionMode: string; host: string; isEnabled?: boolean }): boolean {
  if (d.isEnabled === false) return false;
  if (d.connectionMode !== "DIRECT" && d.connectionMode !== "RELAY") return false;
  return d.host.trim().length > 0;
}

export {
  applyRtspTemplate,
  buildLiveRtspUrlPath,
  canBuildChannelPath,
  channelFromRtspPath,
  dahuaLivePath,
  dahuaPlaybackPath,
  formatDahuaTime,
  hikvisionLivePath,
  isAutoHikvisionPath,
  RTSP_TEMPLATE_MARKER,
  RTSP_TEMPLATE_PLACEHOLDERS,
  rtspTemplateFromNotes,
  stripRtspTemplate,
  validateRtspTemplate,
  withRtspTemplate,
  type PathDevice,
} from "./rtsp-paths";
