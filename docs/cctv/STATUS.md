# Libas VMS — CCTV Integration Status & Log

Last updated: 2026-11-23 (IT requirements build: multi-vendor adapters + estate import)

## Phase: IT requirements build (2026-11-23)
Built against the IT department's 5-point list (live, NVR playback, per-camera RBAC, permissioned download, health alerts + daily report + downtime log). This section covers the vendor adapters and the estate import; alerts, RBAC and estate UI are separate parts of the same build. Nothing below has been tested against a CP Plus, Dahua or Honeywell unit.

**What was built (vendors + estate)**
- `src/lib/vendors/`: vendor catalogue (`VENDORS`, `vendorOf`, `vendorLabel`), protocol families (`isapi` / `dahua` / `template`), connection modes (`CONNECTION_MODE_LABELS`, `isConnectable`, `hostOptionalFor`), RTSP path builders (`buildLiveRtspUrlPath`, Dahua live + playback paths, `{channel}`/`{stream}` templates kept as an `RTSP template:` line in the recorder notes) and a server-only `adapters.ts` (`adapterFor`, `playbackRtspUrlFor`).
- `src/lib/cameras/source.ts` and `src/lib/mediamtx/sync.ts`: live paths come from the vendor builder; MediaMTX gets no path for a recorder that is not connectable (Pending network, Cloud-only, disabled or no address).
- Recorder form + actions: vendor (Hikvision, Tyco Holis, CP Plus, Dahua, Honeywell Hikvision-OEM / Dahua-OEM / other, Generic ONVIF/RTSP), connection mode (Live, Live (relay), Pending network, Cloud-only) with explanations, vendor cloud platform + cloud account (login identifier only), host optional for Pending network / Cloud-only. Passwords stay AES-256-GCM encrypted; audit entries never carry secrets. Testing a non-monitored recorder never changes its status.
- `scripts/import-stores.ts` (`npm run estate:import`): imports `config/store-cameras.json`. Dry run by default (reads the DB, writes nothing), `--apply` writes in one transaction, `--offline` plans from the JSON alone. Idempotent; never prints passwords or usernames; creates no cameras. Recorders already Live keep their address, mode, vendor and credentials. Data-quality flags go into the recorder notes as one line `Data quality: FLAG; FLAG`.
- Offline plan of the current file: 69 rows -> 61 stores, 64 recorders (CP Plus 38, Hikvision 22, Honeywell (Hikvision OEM) 2, Honeywell 1, unknown 1), 62 Pending network + 2 Cloud-only, 5 rows skipped (2 marked NA, 2 empty, 1 on Hold). **Not yet applied to the database** (lead runs migration 0004 first, then `npm run estate:import`, then `-- --apply`).

**Adapter verification status**
| Family | Vendors | Live | Playback | Download | Health |
|---|---|---|---|---|---|
| isapi | Hikvision, Tyco Holis | verified | verified | verified | verified |
| dahua | CP Plus, Dahua, Honeywell (Dahua OEM) | unverified (path builder only) | unverified (RTSP URL builder exists, not wired into the playback UI; no recording search) | unverified | TCP reachability only |
| isapi (OEM) | Honeywell (Hikvision OEM) | unverified | unverified | unverified | unverified |
| template | Generic ONVIF/RTSP, Honeywell other | supported (user template) | not available | not available | TCP reachability only |

Regression check: for vendors `hikvision`, `tyco` and legacy `generic`, live paths, stored-path handling and channel parsing were compared with the previous code for channels 1-128 (main + sub) plus common stored paths: 16,384 cases, 0 differences.

**Blockers**
- Network route: every store recorder is on a private store LAN (172.16.x / 192.168.x) with no route from the server, and IT will not provide a VPN. Store recorders stay "Pending network" (listed, never probed, never alerted on) until a relay or edge box exists. See `06-feasibility-response.md`.
- Duplicate private IPs across stores (192.168.1.x reused), 1 network address given as a device IP, placeholder serials, model numbers in the serial column, 2 recorders with no IP: listed per recorder in its `Data quality:` notes line. Needs correction by the business.
- CP Plus cloud (InstaOnCloud), Hik-Connect and IH View: no API the server can use; cloud-only recorders are inventory only. Cloud platforms for CP Plus / Hikvision rows are assumed from the vendor and marked as such in the notes.
- ISAPI features (channel import, recorder playback, provider info) still check `vendor === "hikvision"` in `lib/devices/channels.ts`, `lib/hikvision/provider.ts` and `lib/playback/sessions.ts`, so a recorder saved as "Tyco Holis" or "Honeywell (Hikvision OEM)" does not get them yet. Existing Tyco units are stored as `hikvision` and are unaffected.

---

## Current Status
- **Active Phase**: Phase 5A Complete — Adapter Architecture Design document delivered (`docs/cctv/05-adapter-architecture.md`).
- **Next Phase**: Phase 5B — Data model & additive migration plan (Awaiting approval to begin 5B).
- **CP Plus Cloud (`CP PLUS HQ`, `2EGCNCI2R12QERBG`)**: **BLOCKED (awaiting client info)**.
  - Reason: `admin` is a cloud login with no local credentials available `[USER]`. No public, documented API/SDK exists for InstaOnCloud P2P streaming `[DOC: https://www.cpplusworld.com/sdk]`. Unofficial/reverse-engineered P2P is forbidden.
  - Required from user: LAN IP, local device credentials, or official distributor SDK.
  - CP Plus LAN adapter treated as **unverified** in Phase 5A.

---

## Decisions Made
1. **Zero-Trust Device Safety**: Unauthenticated, read-only probing first (TCP/RTSP OPTIONS/ONVIF). Max 1 authenticated attempt per credential set to prevent NVR account lockout.
2. **Strict Secrets Boundary**: Secrets (`.env`, passwords, stream tokens, internal IPs) never leave server context. No secrets in logs, audit details, client bundles, or web queries.
3. **Database Isolation**: All operations restricted strictly to PostgreSQL schema `DATABASE_SCHEMA` (`vms`). No access to `public` or other schemas.
4. **Pass-Through Architecture**: The server does not store recordings. Video passes through MediaMTX memory to WebRTC (WHEP) / HLS.
5. **Multi-Vendor Adapter Separation**: Protocol separated from Brand (e.g. Brand = "Tyco / Holis", Adapter = "hikvision-isapi").
6. **Capability-Gated UI**: UI components inspect capability booleans (`capabilities.ptz`, `capabilities.rtspPlayback`, etc.) instead of branching on brand names.
7. **Zero Behavior Change for Hikvision/Tyco**: `hikvision-isapi` adapter wraps `isapi.ts` directly, preserving digest caching, queue serialization, clock drift correction, and 30-minute auth lockout.
8. **CP Plus Cloud Verdict**: BLOCKED (awaiting client info). Any CP Plus LAN adapter is treated as unverified.

---

## Verified Facts (Repo & Environment)
- **Active Hardware**: Two Tyco Holis Pro NVRs (`HRN-64081S-R`), communicating via Hikvision ISAPI (HTTP Digest auth) + RTSP `[DEVICE]`.
  - NVR 3: 54 channels, 3 HDD OK (~22.8 TB total), clock drift +2325 s (~38.8 min fast).
  - NVR 4 (Tables): 61 channels, HDD 5: error (~30.5 TB total), clock drift +1067 s (~17.8 min fast).
- **Cameras**: 115 registered cameras (99 ONLINE, 16 OFFLINE) `[DEVICE]`.
- **Codebase Findings**: Zero Tyco-specific or CP Plus-specific code exists today. All existing integrations use the single Hikvision ISAPI code path `[REPO]`.
- **CP Plus Public SDK Portal**: `https://www.cpplusworld.com/sdk` explicitly returns "No record found!" `[DOC: https://www.cpplusworld.com/sdk]`.
- **KVMS Pro**: End-user CMS only; does not provide an RTSP relay server or REST API `[DOC: https://www.cpplusworld.com/software/kvms-pro]`.

---

## Open Questions & Needed Information
1. **CP Plus Network Route & Credentials**:
   - Local IP address for `CP PLUS HQ` (via site-to-site VPN or WAN).
   - Local device administrator username/password (distinct from cloud account).
   - Official enterprise SDK from CP Plus distributor (if obtainable).
2. **Existing Estate Clarification**: Are there any additional physical Hikvision or Tyco devices on the network not yet added to the database?
3. **Phase 5A Design Review**: Approval to proceed to Phase 5B (Data Model and Additive Migration proposal).
