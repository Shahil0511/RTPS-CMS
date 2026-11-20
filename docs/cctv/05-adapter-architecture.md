# Phase 5A — Multi-Vendor Adapter Architecture Design

This document details the architectural design for decoupling camera/recorder brands from their underlying communication protocols in **Libas VMS**.

---

## 1. Core Principle: Brand vs. Protocol Separation

Today, the database records `vendor = "hikvision"` for both Tyco Holis NVRs (`HRN-64081S-R`), because the codebase conflates the **display brand** with the **protocol implementation** `[REPO: src/lib/hikvision/isapi.ts]`.

In this multi-vendor architecture:
- **`brand`**: The physical manufacturer or product line seen by users in the UI (e.g., `Hikvision`, `Tyco / Holis`, `CP Plus`, `Honeywell`, `Generic / Other`).
- **`adapter`**: The protocol driver that communicates with the hardware over the network (e.g., `hikvision-isapi`, `cp-plus-dahua`, `onvif`, `generic-rtsp`).

Multiple brands can share a single adapter (e.g. Tyco Holis and Hikvision both use `hikvision-isapi`), and single brands may support multiple adapters (e.g. CP Plus via `cp-plus-dahua` or standard `onvif`).

---

## 2. Adapter Contract (`src/lib/vendors/types.ts`)

Every vendor adapter implements a common contract. Beyond `id`, `label`, `capabilities`, and `liveRtspPath`, all methods are optional and strictly gated by capability flags.

```ts
import type { Device } from "@/db/schema";

export interface AdapterCapabilities {
  deviceInfo: boolean;        // System facts, storage status, firmware
  channelImport: boolean;     // Automated channel discovery/naming
  channelStatus: boolean;     // Real-time per-channel online/offline from recorder
  subStream: boolean;         // Dual-streaming (sub-stream for grids)
  snapshot: boolean;          // Single-frame still capture from device/recorder
  ptz: boolean;               // Pan-tilt-zoom control
  recordingSearch: boolean;   // Query recorder edge index for recorded spans
  rtspPlayback: boolean;      // Stream recorded video directly from recorder over RTSP
  playbackScale: boolean;     // Fast-forward / scale on RTSP playback
  recordingDownload: boolean; // Direct file or range download from recorder
  downloadRange: boolean;     // HTTP Range support on recorded file download
  clock: boolean;             // Device clock query and drift measurement
}

export interface ChannelInfo {
  channel: number;
  name: string;
  ipAddress?: string | null;
}

export interface ChannelStatus {
  online: boolean;
  detail?: string | null;
  ipAddress?: string | null;
}

export interface RecordingSegment {
  start: Date;
  end: Date;
  playbackUri: string | null;
}

export interface DeviceInfo {
  model?: string | null;
  serialNumber?: string | null;
  firmware?: string | null;
  channelCount?: number | null;
  storageStatus?: string | null;
  storageTotalMb?: number | null;
  storageFreeMb?: number | null;
  infoCheckedAt?: Date;
  clockDriftSeconds?: number | null;
}

export interface DeviceClockInfo {
  offsetMinutes: number | null;
  driftSeconds: number | null;
  mode: "local" | "utc";
}

export interface PtzCommand {
  action: "up" | "down" | "left" | "right" | "zoomIn" | "zoomOut" | "stop";
  speed?: number; // 1 to 10
}

export interface VendorAdapter {
  id: string;
  label: string;
  capabilities(device: Device): AdapterCapabilities;

  /** Resolves the RTSP live path for a channel (main or sub-stream). */
  liveRtspPath(device: Device, channel: number, stream: "main" | "sub"): string;

  /** Reads model, serial, disk status, and clock drift. */
  getDeviceInfo?(device: Device): Promise<DeviceInfo>;

  /** Discovers channels configured on an NVR/DVR. */
  listChannels?(device: Device): Promise<ChannelInfo[]>;

  /** Queries per-channel connection status without pulling video. */
  channelStatus?(device: Device): Promise<Map<number, ChannelStatus>>;

  /** Searches recorder disk index for footage between two times. */
  searchRecordings?(device: Device, channel: number, from: Date, to: Date): Promise<RecordingSegment[]>;

  /** Generates an authenticated RTSP playback URL for a time window. */
  playbackRtspUrl?(device: Device, channel: number, from: Date, to: Date): string;

  /** Streams a recorded file directly from the recorder. */
  downloadRecording?(device: Device, playbackUri: string, range?: string): Promise<Response>;

  /** Fetches a JPEG still snapshot. */
  snapshot?(device: Device, channel: number): Promise<Response>;

  /** Executes a PTZ movement or zoom command. */
  ptz?(device: Device, channel: number, command: PtzCommand): Promise<void>;

  /** Queries recorder clock and drift. */
  getClock?(device: Device): Promise<DeviceClockInfo>;
}
```

---

## 3. Adapter Registry (`src/lib/vendors/registry.ts`)

The registry replaces the single global provider slot in `src/lib/devices/health.ts` (`setDeviceInfoProvider`), allowing multiple protocols to co-exist safely:

```ts
import type { VendorAdapter } from "./types";
import { hikvisionAdapter } from "./hikvision";
import { genericRtspAdapter } from "./generic-rtsp";
import { cpPlusDahuaAdapter } from "./cp-plus";

const registry = new Map<string, VendorAdapter>();

export function registerAdapter(adapter: VendorAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getAdapter(adapterId: string | null | undefined): VendorAdapter {
  if (!adapterId) return genericRtspAdapter;
  const adapter = registry.get(adapterId);
  if (!adapter) {
    console.warn(`[vendors] Unknown adapter '${adapterId}', falling back to generic-rtsp`);
    return genericRtspAdapter;
  }
  return adapter;
}

export function listAdapters(): Array<{ id: string; label: string }> {
  return [...registry.values()].map((a) => ({ id: a.id, label: a.label }));
}

// Built-in registrations
registerAdapter(hikvisionAdapter);
registerAdapter(genericRtspAdapter);
registerAdapter(cpPlusDahuaAdapter);
```

---

## 4. Wrapping Existing Hikvision ISAPI (Zero-Behavior-Change Guarantee)

The `hikvision-isapi` adapter is a direct wrapper around `src/lib/hikvision/isapi.ts`.
- **Preserved unchanged**:
  - RFC 7616 Digest authentication cache (`src/lib/hikvision/digest.ts`).
  - Serialized request queues per recorder (`serialize(device.id)`).
  - 30-minute authentication lockout back-off (`authBlockedUntil`, `assertNotBlocked`).
  - Wall-clock time correction and drift adjustments (`deviceClock`, `toDeviceTime`, `fromDeviceTime`).
- **Adapter mapping**:
  - `capabilities(device)` returns:
    ```ts
    {
      deviceInfo: true,
      channelImport: true,
      channelStatus: true,
      subStream: true,
      snapshot: true,
      ptz: false, // will be verified on hardware in Phase 7.4
      recordingSearch: true,
      rtspPlayback: true,
      playbackScale: false,
      recordingDownload: true,
      downloadRange: false, // tested in Phase 8
      clock: true,
    }
    ```
  - `liveRtspPath`: `/Streaming/Unicast/channels/${channel}${stream === "sub" ? "02" : "01"}` `[REPO: src/lib/cameras/source.ts:20]`.
  - `listChannels`: wraps `getChannels(device)`.
  - `channelStatus`: wraps `getChannelStatus(device)`.
  - `searchRecordings`: wraps `searchRecordings(device, channel * 100 + 1, from, to, clock)`.
  - `playbackRtspUrl`: wraps `playbackRtspUrl(device, channel * 100 + 1, from, to, clock)`.
  - `downloadRecording`: wraps `downloadRecording(device, playbackUri)`.
  - `getDeviceInfo`: wraps `getDeviceInfo`, `getStorage`, `getClock`.

---

## 5. CP Plus LAN Adapter (`cp-plus-dahua`) — Status: UNVERIFIED

Because no CP Plus hardware is currently reachable on the network, this adapter is designed from published General Surveillance CGI / Dahua specifications `[COMMUNITY]` and explicitly flagged as **UNVERIFIED**.

- **Capabilities**:
  ```ts
  {
    deviceInfo: false,        // UNVERIFIED
    channelImport: false,     // UNVERIFIED
    channelStatus: false,     // UNVERIFIED
    subStream: true,          // Dahua subtype=1 supported on standard models [COMMUNITY]
    snapshot: false,          // UNVERIFIED
    ptz: false,               // UNVERIFIED
    recordingSearch: false,   // UNVERIFIED
    rtspPlayback: false,      // UNVERIFIED
    playbackScale: false,     // UNVERIFIED
    recordingDownload: false, // UNVERIFIED
    downloadRange: false,     // UNVERIFIED
    clock: false,             // UNVERIFIED
  }
  ```
- **RTSP Path Implementation**:
  ```ts
  liveRtspPath(device, channel, stream) {
    const subtype = stream === "sub" ? 1 : 0;
    return `/cam/realmonitor?channel=${channel}&subtype=${subtype}`;
  }
  ```
- **Verification Gate**: No HTTP methods (`getDeviceInfo`, `searchRecordings`, `downloadRecording`) will be implemented or enabled until real hardware is reachable, probed unauthenticated, and confirmed with exactly one authenticated attempt.

---

## 6. Generic RTSP Adapter (`generic-rtsp`)

For standalone IP cameras or unlisted recorders:
- **Capabilities**:
  - `subStream`: `true` (if a sub-path is defined on the camera).
  - All other capabilities: `false`.
- **RTSP Path**: Returns `camera.rtspPath` or `"/"`.

---

## 7. Call-Site Refactoring Map

The 7 hard-wired touchpoints identified in Section 2 move cleanly to adapter calls:

| # | File | Current Hard-Wired Code | Refactored Code with Adapter |
|---|---|---|---|
| **1** | `src/server/actions/devices.ts` | `DEVICE_VENDORS = ["hikvision", "generic"]` | Reads from `listAdapters()` and `BRANDS` enum. |
| **2** | `src/lib/devices/health.ts` | Single global provider `getDeviceInfoProvider()` | Calls `getAdapter(device.adapter).getDeviceInfo(device)` if `capabilities.deviceInfo` is true. |
| **3** | `src/lib/health/monitor.ts` | Filters `d.vendor === "hikvision"` for channel status | Checks `getAdapter(d.adapter).capabilities(d).channelStatus`. |
| **4** | `src/lib/devices/channels.ts` | Throws for `device.vendor !== "hikvision"` | Checks `adapter.capabilities(device).channelImport`, calls `adapter.listChannels(device)`. |
| **5** | `src/lib/cameras/source.ts` | `hikvisionLivePath(channel)` hard-wired fallback | Calls `adapter.liveRtspPath(device, channel, "main")`. |
| **6** | `src/lib/playback/sessions.ts` | Directly imports `playbackRtspUrl` & `getClock` from `isapi.ts` | Checks `capabilities.rtspPlayback`, calls `adapter.playbackRtspUrl()`. |
| **7** | `src/app/api/playback/[cameraId]/download/route.ts` | Directly calls `searchRecordings` and `downloadRecording` from `isapi.ts` | Checks `capabilities.recordingDownload`, calls `adapter.downloadRecording()`. |

---

## 8. UI Capability-Driven Display Pattern

The UI must **never branch on brand names or adapter IDs**. Instead:
1. Server actions and API routes return an explicit `capabilities` map to the client.
2. UI components render controls conditionally:
   - Timeline / Playback bar: rendered only when `capabilities.rtspPlayback` or `playbackMode === "LOCAL"` is true.
   - Channel Import button: rendered only when `capabilities.channelImport` is true.
   - PTZ overlay: rendered only when `capabilities.ptz` is true.
   - Disk / Storage health card: displays "Storage monitoring not supported by this device" when `capabilities.deviceInfo` is false.
3. If an unauthorized or unsupported action is triggered, the server and client return: `"Feature not supported by this device adapter"` (never fail silently, never return canned/mock data).

---

## 9. Verification & "Do Not Break" Guarantees

1. **Backwards Compatibility**: Existing records in PostgreSQL have `vendor = "hikvision"`. The migration in Phase 5B will backfill `adapter = "hikvision-isapi"` and `brand = "Tyco / Holis"`.
2. **Acceptance Test**:
   - `npm run typecheck` passes with zero errors.
   - NVR 3 and NVR 4 continue to stream live video, report storage, report channel health, and execute playback sessions without any change in behavior.
