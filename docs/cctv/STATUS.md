# Libas VMS — CCTV Integration Status & Log

Last updated: 2026-11-20 (Phase 1 & Phase 2 Complete)

## Current Status
- **Active Phase**: Phase 2 Complete — Awaiting user direction on CP Plus integration route (Route B: VPN vs Route C: Edge Relay vs Route D: SDK) to begin Phase 3 (Connection Plan).
- **Target Programme**:
  1. CP Plus via InstaOnCloud (Phase 2 Completed — Direct Cloud P2P without vendor SDK is Not Supported)
  2. Multi-vendor adapter architecture (Phase 5)
  3. Cloud/P2P brand investigation (Phase 6)
  4. Professional CCTV player (Phase 7)
  5. High-performance downloads & exports (Phase 8)

---

## Decisions Made
1. **Zero-Trust Device Safety**: Unauthenticated, read-only probing first (TCP/RTSP OPTIONS/ONVIF). Max 1 authenticated attempt per credential set to prevent NVR account lockout.
2. **Strict Secrets Boundary**: Secrets (`.env`, passwords, stream tokens, internal IPs) never leave server context. No secrets in logs, audit details, client bundles, or web queries.
3. **Database Isolation**: All operations restricted strictly to PostgreSQL schema `DATABASE_SCHEMA` (`vms`). No access to `public` or other schemas.
4. **Pass-Through Architecture**: The server does not store recordings. Video passes through MediaMTX memory to WebRTC (WHEP) / HLS.
5. **No Speculative Implementation / No Reverse Engineering**: Only verified manufacturer protocols, documented SDKs, or standard RTSP/ONVIF. No reverse-engineered P2P protocols or traffic sniffing.
6. **CP Plus Integration Verdict**: Direct third-party cloud streaming via Serial + Cloud Login is **NOT SUPPORTED** via public documented APIs. The device must be integrated via Route B (Site-to-site VPN), Route C (Edge MediaMTX Relay), or Route D (Official Vendor SDK).

---

## Verified Facts (Repo & Environment)
- **Active Hardware**: Two Tyco Holis Pro NVRs (`HRN-64081S-R`), communicating via Hikvision ISAPI (HTTP Digest auth) + RTSP `[DEVICE]`.
  - NVR 3: 54 channels, 3 HDD OK (~22.8 TB total), clock drift +2325 s (~38.8 min fast).
  - NVR 4 (Tables): 61 channels, HDD 5: error (~30.5 TB total), clock drift +1067 s (~17.8 min fast).
- **Cameras**: 115 registered cameras (99 ONLINE, 16 OFFLINE) `[DEVICE]`.
- **Codebase Findings**: Zero Tyco-specific or CP Plus-specific code exists today. All existing integrations use the single Hikvision ISAPI code path `[REPO]`.
- **CP Plus Public SDK Portal**: `cpplusworld.com/sdk` explicitly returns "No record found!" `[DOC]`. No public third-party REST API or WebRTC cloud gateway exists for InstaOnCloud.
- **KVMS Pro**: End-user CMS only; does not provide an RTSP relay server or REST API `[DOC]`.

---

## Open Questions & Needed Information
1. **CP Plus Network Route Selection**:
   - Can `CP PLUS HQ` be connected via an existing site-to-site VPN or routed network (Route B)? What is its local LAN IP?
   - Or should we prepare an Edge MediaMTX Relay design (Route C) for the remote site?
   - Should the ready-to-send email in `docs/cctv/02-cpplus-instaoncloud.md` be dispatched to CP Plus support for their official Linux/Windows SDK (Route D)?
2. **Local Credentials**: Local device administrator username and password (distinct from cloud account) for when network connectivity is established.
3. **Existing Estate Clarification**: Are there any additional physical Hikvision or Tyco devices on the network not yet added to the database?
