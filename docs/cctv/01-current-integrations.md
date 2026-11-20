# Phase 1 — Current Integrations Report

Generated on: 2026-11-20
Source: Live database inspection (`vms` schema) and health run (`npm run health:run`).

---

## 1. Verified Inventory of Active Recorders

| Field | Recorder 1 | Recorder 2 | Evidence Tag |
|---|---|---|---|
| **Name** | NVR 3 | NVR 4 (Tables) | `[DEVICE]` |
| **Kind** | NVR | NVR | `[DEVICE]` |
| **Vendor (DB field)** | `hikvision` | `hikvision` | `[DEVICE]` |
| **Model** | `HRN-64081S-R` | `HRN-64081S-R` | `[DEVICE]` |
| **Physical Brand** | Tyco (Holis Pro 64-Channel NVR) | Tyco (Holis Pro 64-Channel NVR) | `[COMMUNITY]` |
| **Firmware** | `V4.50.000 .20220714` | `V4.50.000 .20230401` | `[DEVICE]` |
| **Channels** | 54 configured | 61 configured | `[DEVICE]` |
| **Status** | ONLINE | ONLINE | `[DEVICE]` |
| **Storage Status** | 3 HDD OK (~22.8 TB total, 0 MB free) | HDD 5: error (~30.5 TB total, 0 MB free) | `[DEVICE]` |
| **Time Mode** | `local` | `local` | `[DEVICE]` |
| **Clock Drift** | +2325 s (~38.75 min fast) | +1067 s (~17.78 min fast) | `[DEVICE]` |
| **Protocol Used** | Hikvision ISAPI (HTTP Digest) + RTSP | Hikvision ISAPI (HTTP Digest) + RTSP | `[REPO: src/lib/hikvision/isapi.ts]` |

---

## 2. Camera Summary

- **Total Registered Cameras**: 115 `[DEVICE]`
  - Linked to NVR 3: 54 cameras
  - Linked to NVR 4 (Tables): 61 cameras
- **Operational Status**:
  - ONLINE: 99 cameras `[DEVICE]`
  - OFFLINE: 16 cameras (reported offline by NVR input proxy status) `[DEVICE]`
  - UNKNOWN: 0 cameras `[DEVICE]`
- **Streaming & Codecs**:
  - Live streams are pulled on-demand (`sourceOnDemand: true` in MediaMTX) `[REPO: src/lib/mediamtx/sync.ts]`.
  - For active/recently read tracks: Video is H.264, Audio is G.711, resolution 1280×720 `[DEVICE]`.
  - Inactive cameras have null track metadata until watched, preserving NVR bandwidth.

---

## 3. Physical Brand & Protocol Analysis

### Is there any Tyco-specific or CP Plus-specific code in this repository?
**No.** A codebase-wide search across `src/` and `scripts/` for `tyco`, `holis`, `cpplus`, `cp plus`, and `dahua` returns zero occurrences `[REPO]`.

### Which physical brands are actually connected, and through which protocol?
- **Physical Brand**: Both active hardware recorders (`NVR 3` and `NVR 4 (Tables)`) report model string `HRN-64081S-R`. Manufacturer product catalogs identify `HRN-64081S-R` as a **Tyco HOLIS Pro 64-channel NVR** `[COMMUNITY]`.
- **Protocol**: Both devices answer the **Hikvision ISAPI protocol** over HTTP with Digest authentication, and stream media via RTSP (`/Streaming/Unicast/channels/<ch>01` for live, `/Streaming/tracks/<ch>01?starttime=...` for playback) `[REPO: src/lib/hikvision/isapi.ts:223, 456]`.
- **Key Conclusion**: The "Hikvision" and "Tyco / Holis" integrations in this codebase are **one and the same code path**. There are no Hikvision-branded hardware units connected today; the Tyco Holis hardware emulates or natively runs Hikvision ISAPI firmware.

---

## 4. Questions for User (Phase 1 Gate)
1. Are there any physical Hikvision-branded devices or additional Tyco recorders on the network that are *not* currently registered in the database and that you expect to be operational?
