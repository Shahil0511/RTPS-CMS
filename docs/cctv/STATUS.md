# Libas VMS — CCTV Integration Status & Log

Last updated: 2026-11-20 (Phase 5A Design Complete)

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
