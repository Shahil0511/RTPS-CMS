# System Architecture & "Do Not Break" Reference

This document maps the architecture of **Libas VMS** (`libas-vms`), an enterprise CCTV Video Management System built for live monitoring, NVR recording playback, health monitoring, RBAC, and audit logging.

---

## 1. System Map

```
 Browser (Client)
   │
   ├─► Next.js App Router (Port 3000)
   │     │  (Session Cookie / RBAC / Server Actions / Route Handlers)
   │     ├─► PostgreSQL (vms schema only)
   │     ├─► ISAPI / HTTP / RTSP Control to NVRs/Recorders
   │     └─► MediaMTX Control API (:9997) / Playback (:9996)
   │
   └─► MediaMTX Streaming Server (:8889 WebRTC/WHEP, :8888 LL-HLS)
         │  (Validates bearer token via POST /api/internal/mediamtx-auth)
         └─► Pulls RTSP On-Demand from NVRs/Cameras (:554)
```

### 1.1 Frontend
- **Framework**: Next.js 16.4.5 (App Router), React 19.3.1, TypeScript 5.9.2, Tailwind CSS 4.3.4, Lucide icons.
- **Key Views**:
  - `LiveGrid` (`src/components/live/live-grid.tsx`): 1/4/9/16 tile layouts, Store vs. Corporate tabs, wall mode, per-user saved state.
  - `WhepPlayer` (`src/components/player/whep-player.tsx`): WebRTC (WHEP) client with automatic fallback to LL-HLS (`hls.js`), snapshot, fullscreen, mute, reconnect logic.
  - `PlaybackBrowser` (`src/components/playback/playback-browser.tsx`): Interactive timeline, segment queries, ±30s / ±5min jumping, pass-through download trigger.
  - Device & Camera Admin (`src/components/devices/*`, `src/components/cameras/*`): Form controls and data tables.
  - UI Kit (`src/components/ui/*`): Accessible, Jira/Atlassian styled design system with custom animations.

### 1.2 Backend & Server Logic
- **Request Gate (`src/proxy.ts`)**: Next.js 16 proxy convention (replaces deprecated `middleware.ts`). Inspects session cookies (`libas_session`), validates JWT claims, handles password-rotation rerouting.
- **Auth & RBAC (`src/lib/auth/*`)**:
  - Roles: `ADMIN`, `MANAGER`, `VIEWER`.
  - Store Scoping: `ADMIN` has global access; `MANAGER` and `VIEWER` access is strictly scoped to assigned stores (`user_stores`).
  - Stream Tokens (`stream-token.ts`): Short-lived HMAC-SHA256 JWTs signed with `SESSION_SECRET` specifying permissible paths and actions.
  - Brute Force Lockout (`rate-limit.ts`): Dual in-memory rate-limiting by client IP and account key.
- **Secrets Management (`src/lib/crypto.ts`)**: AES-256-GCM encryption at rest (`v1.<iv>.<tag>.<ciphertext>`) keyed by 64-hex-char `ENCRYPTION_KEY`.
- **Background Scheduler (`src/server/scheduler.ts`)**: Single-instance background loops for MediaMTX reconciliation (60s), device/camera health monitoring (20s), and idle playback session cleanup (30s).
- **Vendor ISAPI Client (`src/lib/hikvision/*`)**: HTTP Digest auth client (RFC 7616), per-device serialized execution queues, 30-minute auth lockout back-off, XML parsing, device clock drift adjustment.

### 1.3 Database (`src/db/schema.ts`, `drizzle/`)
- **Isolation Boundary**: PostgreSQL shared server, operating strictly within the `vms` schema (`DATABASE_SCHEMA`).
- **Core Entities**:
  - `users`: Accounts, password hashes, roles, token versions (for immediate session revocation).
  - `stores`: Locations (Store, Corporate, Warehouse), timezones, active flags.
  - `user_stores`: Join table scoping non-admin access.
  - `devices`: Recorders (NVR/DVR) and standalone units. Holds host, ports, encrypted credentials, model, storage, clock drift.
  - `cameras`: MediaMTX path names (`path_name`), channels, RTSP paths, playback modes, status.
  - `playback_sessions`: Temporary paths (`pb-...`) proxying recorder footage to MediaMTX.
  - `device_status_events` & `camera_status_events`: Historical status transitions.
  - `audit_logs`: User actions, exports, logins; secrets explicitly forbidden.

### 1.4 Streaming Infrastructure (MediaMTX 1.21.3)
- **Binary**: Native Windows executable (`mediamtx/bin/mediamtx.exe`) or Docker container (`bluenviron/mediamtx:1.21.3`).
- **Protocols & Ports**:
  - Ingest: RTSP (TCP/UDP, port 8554).
  - Browser Egress: WebRTC WHEP (port 8889 TCP, port 8189 UDP/TCP), Low-Latency HLS (port 8888).
  - Internal Control: API (:9997), Playback (:9996), Metrics (:9998).
- **Dynamic Registration & On-Demand Ingest**: Cameras are registered via MediaMTX Control API with `sourceOnDemand: true` (only pulling RTSP from physical devices when readers are active).
- **Auth Callback (`/api/internal/mediamtx-auth`)**: Webhook called by MediaMTX for every action, verified via secret key parameter `?k=${MEDIAMTX_AUTH_SECRET}`. Validates stream tokens and service accounts.

### 1.5 Deployment
- **Local Dev**: Windows 11 host. `npm run dev` starts both Next.js and MediaMTX via `concurrently`.
- **Production / Container**: `Dockerfile` + `docker-compose.yml` using `network_mode: host` (mandatory for WebRTC UDP 8189 and local LAN camera routing).

---

## 2. Hard "Do Not Break" Rules

1. **Authentication Back-off & NVR Account Safety**:
   - Physical recorders lock out after repeated bad logins. Every vendor adapter must implement serialized requests per recorder and an enforced 30-minute lockout back-off upon any 401 response (`authBlockedUntil`).
   - Maximum of **one** authenticated login attempt per credential change.

2. **Zero In-Memory / Server Storage for Footage**:
   - Live and playback streams pass directly through memory from the recorder to MediaMTX. No permanent video storage on this server. Temporary files (e.g. clip exports) require explicit user approval and auto-cleanup.

3. **Database Schema Enclosure**:
   - Only touch the schema defined in `DATABASE_SCHEMA` (`vms`). Never read, alter, or drop tables in `public` or any other schema.
   - All schema migrations must be additive and generated via `npm run db:generate` with prior user review.

4. **Secrets & Privacy Boundary**:
   - Never expose `.env`, plain passwords, encrypted secrets, internal IP addresses, or RTSP URLs with credentials to the browser, client bundles, audit logs, or web searches.
   - Strip sensitive device host info before returning camera queries to non-admin users.

5. **MediaMTX Path Reconciliation Trap**:
   - `reconcileAll()` (`src/lib/mediamtx/sync.ts`) deletes any static RTSP path not present in `cameras` every 60 seconds. Any new stream path (sub-streams, cloud relays) must be registered in the DB and integrated into `reconcileAll()` and `storeOfPath()`.
   - MediaMTX auth hook blocks incoming stream publication (`publish`) for all non-service accounts.

6. **Dev Cache & Turbopack Safety**:
   - Never run `npm run build` while `next dev` is running (causes Turbopack cache corruption).
   - Use `npm run typecheck` (`tsc --noEmit`) to verify builds. If production build testing is required: `NEXT_DIST_DIR=.next-alt npx next build` followed by cleanup.

7. **Next.js 16 Architectural Conventions**:
   - Request gate must remain in `src/proxy.ts` (Next 16 replaces `middleware.ts`).
   - Dynamic route params are asynchronous Promises (`await ctx.params`).
   - Request headers and cookies are asynchronous (`await cookies()`, `await headers()`).
