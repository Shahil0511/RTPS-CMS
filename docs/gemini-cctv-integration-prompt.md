# PROMPT FOR GEMINI FLASH (Antigravity) — Libas VMS: CP Plus InstaOnCloud, multi-vendor adapters, professional CCTV player

You are working inside an existing, working production-bound application at the root of this workspace (`package.json` name: `libas-vms`). Your job is to extend it in small, verified phases. You are a careful senior engineer joining a live project: you investigate first, you prove things with evidence, and you stop at every gate marked **STOP** until I reply.

Read this whole prompt before doing anything. Then start at Phase 0.

---

## 0. How you must work (non-negotiable)

1. **Investigate before you change.** No file is edited in Phases 0–2. Those phases produce reports only.
2. **One phase at a time.** At the end of each phase, write the phase report, update `docs/cctv/STATUS.md`, and **STOP**. Do not begin the next phase until I say "continue".
3. **Never invent.** Do not invent APIs, SDK names, endpoints, URL formats, ports, npm packages or config keys. Every external fact you rely on must be one of:
   - `[REPO]` — you read it in this codebase (cite `path:line`).
   - `[DEVICE]` — you observed it from the real device (quote the response, with secrets removed).
   - `[DOC]` — official manufacturer documentation (cite the URL).
   - `[COMMUNITY]` — a non-official source (cite the URL); treat as a lead to test, never as fact.
   - `[ASSUMPTION]` — unverified; say what would verify it.
4. **Never fake success.** No placeholder video, no sample MP4, no mock "connected" status, no hard-coded success responses, no stubbed adapter that returns canned data. If something cannot be done, the UI and your report must say so.
5. **Never replace a working feature** without first showing me what works today, what you would change, and why. Refactors must be behaviour-preserving and shown to be so.
6. **Small diffs.** One concern per change. If a change touches more than about 8 files or 400 lines, split it and tell me the order.
7. **Missing information is a result, not an obstacle.** If you need something from me (a model number, network access, a vendor SDK, a decision), list it under "NEEDED FROM USER" and stop. Do not guess to keep moving.
8. **Report format for every phase:**
   - What I did (commands run, files read or changed)
   - What I verified, with evidence and a tag from rule 3
   - What is still unverified
   - NEEDED FROM USER
   - Proposed next step

### Persistent state
Create `docs/cctv/STATUS.md` in Phase 0 and keep it current: phase, decisions made, open questions, verified device facts (never secrets). If a new conversation starts, read that file first and resume from it.

---

## 1. Hard safety rules for this project

Break none of these. If a task seems to require breaking one, stop and ask.

**Secrets**
- Never print, log, echo, commit or paste the contents of `.env`, any password, any `password_enc` value, session secret or stream token. Do not `cat .env`. If you need to know which keys exist, list key names only.
- Never ask me to type a camera/recorder password into the chat. Passwords enter the system only through (a) the app's own form at **Recorders → Add recorder**, which encrypts them with AES-256-GCM (`src/lib/crypto.ts`), or (b) the `RECORDER_PASSWORD` environment variable used by `scripts/add-recorder.ts`.
- No credential, internal IP, RTSP URL with credentials, or serial number may ever reach browser code, an API response for a non-admin, an audit-log `details` field, a file in the repo, or a web search query.
- When you research on the web, use generic queries (brand, model family, protocol). **Do not send the device serial number, our IP addresses or account names to any website, search engine or third-party tool.**

**Devices**
- Recorders lock the admin account after repeated bad logins. For any device: **at most one authenticated attempt per credential set.** If it is rejected, stop and report — never retry in a loop, never try alternative or default passwords. Keep the existing 30-minute ISAPI auth back-off in `src/lib/hikvision/isapi.ts` (`authBlockedUntil`, `assertNotBlocked`) and build the same protection into every new adapter.
- Do unauthenticated, read-only probing first (TCP port reachability, RTSP `OPTIONS`, ONVIF `GetSystemDateAndTime`, HTTP response headers). These identify the platform without risking a lockout.
- Never change device configuration (encoding, users, network, time, firmware, reboot, format). Read-only until I approve a specific write. PTZ movement is the only device "write" in scope, and only in its own phase.
- Do not reverse-engineer, packet-capture, decompile or re-implement any manufacturer cloud/P2P protocol. Do not use community re-implementations of proprietary P2P protocols. Do not bypass authentication, cloud binding or licensing. Only officially supported interfaces (documented SDK/API, RTSP, ONVIF, documented HTTP API).
- Per-recorder requests in the existing code are serialised (`serialize()` in `isapi.ts`) to protect the NVR. Keep recorder load low: bounded concurrency, timeouts, no polling storms.

**Database**
- PostgreSQL is a **shared server holding other applications' data**. This app owns only the schema named by `DATABASE_SCHEMA` (`vms`). Never read or write `public`, `ebo_audit` or any other schema. Never use SQLite.
- Schema changes: edit `src/db/schema.ts` → `npm run db:generate` → show me the generated SQL → wait for approval → `npm run db:migrate`. Never run `drizzle-kit push`. Migrations must be additive (new nullable columns, new tables, new enum values). No dropping, renaming or retyping existing columns without explicit approval.

**Build and runtime**
- `AGENTS.md` at the repo root applies: this is **Next.js 16.4.5 with breaking changes versus older versions**. Before writing any Next.js code, read the relevant guide under `node_modules/next/dist/docs/`. Example of a difference already in this repo: the request gate is `src/proxy.ts`, not `middleware.ts`.
- **Never run `npm run build` (or anything writing to `.next`) while the dev server is running** — it has corrupted the Turbopack dev cache before and caused an endless reload loop. Verify with `npm run typecheck` (`tsc --noEmit`). If a production build is truly needed: `NEXT_DIST_DIR=.next-alt npx next build`, then delete `.next-alt`.
- Everything must still start from a single `npm run dev` (it runs Next + MediaMTX through `concurrently`). Any new long-running process must be wired into that script or be strictly optional.
- Report every new dependency (name, version, licence, why, install command) and wait for approval before installing. Prefer zero new dependencies. `ffmpeg`/`ffprobe` are **not** installed on this machine; do not assume them.

**Version control**
- This folder is **not a git repository**, so there is currently no undo. In Phase 0, ask me for permission to run `git init` and make a baseline commit (`.gitignore` already excludes `.env`, `node_modules`, `.next`, `recordings/`, `mediamtx/bin/`). After approval, commit at the end of every phase. Never commit `.env`.

---

## 2. What already exists (verified by reading the repo on 2026-11-20 — re-verify, do not trust blindly)

**Stack.** Next.js 16.4.5 App Router, React 19, TypeScript, Tailwind CSS 4, lucide-react, zod 4, Drizzle ORM on PostgreSQL (`pg`), `jose` for JWTs, `hls.js`. Streaming through **MediaMTX 1.21.3** (`mediamtx/bin/mediamtx.exe`, config `mediamtx/mediamtx.yml`): RTSP in → WebRTC (WHEP, :8889 + UDP 8189) and LL-HLS (:8888) out. Dev machine is Windows 11; `Dockerfile` + `docker-compose.yml` (host networking, Linux) exist for deployment.

**Architecture already matches the secure pattern.** The browser never talks to a camera. Flow: browser → `GET /api/stream/[cameraId]` (session + role + store check, returns a short-lived per-path bearer token) → browser connects to MediaMTX → MediaMTX calls `POST /api/internal/mediamtx-auth` for every action → app validates token. Cameras are registered in MediaMTX through its Control API (`src/lib/mediamtx/client.ts`, `sync.ts`) with `sourceOnDemand`, so the NVR is only pulled while someone watches.

**Key files**

| Area | Files |
|---|---|
| DB schema | `src/db/schema.ts` (tables `users`, `stores`, `user_stores`, `devices`, `cameras`, `playback_sessions`, status events, `audit_logs`, `settings`), migrations in `drizzle/` |
| Auth / RBAC | `src/proxy.ts`, `src/lib/auth/session.ts`, `rbac.ts` (ADMIN / MANAGER / VIEWER + per-store scope), `stream-token.ts`, `rate-limit.ts` |
| Secrets | `src/lib/crypto.ts` (`encryptSecret` / `decryptSecret`, AES-256-GCM, key from `ENCRYPTION_KEY`) |
| Hikvision ISAPI | `src/lib/hikvision/digest.ts`, `isapi.ts` (device info, storage, clock + drift, channels, channel status, recording search, download, playback RTSP URL), `provider.ts` |
| Source resolution | `src/lib/cameras/source.ts`, `src/lib/rtsp.ts` |
| Channel import | `src/lib/devices/channels.ts` |
| Health | `src/lib/health/monitor.ts`, `src/lib/devices/health.ts`, `src/server/scheduler.ts` |
| Playback | `src/lib/playback/sessions.ts`, `src/app/api/playback/**` (segments, session, download, media) |
| Player UI | `src/components/player/whep-player.tsx`, `src/components/live/live-grid.tsx`, `src/components/playback/playback-browser.tsx` |
| Device/camera admin | `src/server/actions/devices.ts`, `cameras.ts`, `src/components/devices/*`, `src/components/cameras/*` |
| UI kit | `src/components/ui/*` (reuse it; visual direction is a clean Jira/Atlassian-style console with motion on interactions) |

**What is registered today (read from the `vms` schema, no secrets):** two recorders, `172.16.1.3` (54 channels) and `172.16.1.4` (61 channels), both reporting model **`HRN-64081S-R`**, both stored with `vendor = "hikvision"`, 115 cameras, all H.264, live path style `/Streaming/Unicast/channels/<ch>01`. Public listings describe `HRN-64081S-R` as a **Tyco HOLIS Pro** 64-channel NVR `[COMMUNITY]`. So the "Hikvision" and "Tyco / Holis" integrations that work today appear to be **one and the same code path**: Tyco Holis hardware answering the Hikvision ISAPI protocol. There is no Tyco-specific code and no Hikvision-branded device in the database. Confirm this in Phase 1 and say so plainly.

**Player features that exist today:** WebRTC with automatic HLS fallback and reconnect; PNG snapshot; fullscreen; mute; layouts 1 / 4 / 9 / 16 with paging, wall mode and per-user saved selection; Stores / Corporate tabs; NVR-sourced playback with a clickable timeline, ±30 s / ±5 min jumps; per-file download proxied from the recorder (`/ISAPI/ContentMgmt/download`).

**Player features that do NOT exist yet:** digital zoom / pan, mouse-wheel zoom, PTZ, 2-camera layout, enlarge-and-return, sub-stream use in grids (every tile pulls the main stream), playback speed, pause/resume of recorder playback, frame stepping, multi-frame extraction, time-range export, resumable / multi-connection download, download progress UI.

**Places where Hikvision is hard-wired (these are what the adapter work must untangle, carefully):**
- `src/server/actions/devices.ts` — `DEVICE_VENDORS = ["hikvision", "generic"]`.
- `src/lib/devices/health.ts` — a **single global** provider slot (`setDeviceInfoProvider`); only one vendor can register.
- `src/lib/health/monitor.ts` (~line 134) — channel status only for `vendor === "hikvision"`.
- `src/lib/devices/channels.ts` — channel import throws for non-Hikvision.
- `src/lib/cameras/source.ts` — `hikvisionLivePath()` is the fallback for *any* device; `trackId = channel * 100 + 1`.
- `src/lib/playback/sessions.ts` and `src/app/api/playback/[cameraId]/download/route.ts` — import Hikvision functions directly.
- `src/db/schema.ts` — `devices.host` is NOT NULL and `(host, rtsp_port)` is unique; there is no connection-type, cloud-ID, ONVIF-port, sub-stream or capability field.

**Traps you must know about**
- `reconcileAll()` in `src/lib/mediamtx/sync.ts` **deletes any MediaMTX path with an `rtsp://` source that is not a row in `cameras`**, every 60 seconds. A test path you add by hand will vanish. Anything new (sub-stream paths, cloud-bridge paths) must be taught to the reconciler and to `storeOfPath()` in `src/app/api/internal/mediamtx-auth/route.ts`, or stream authorisation will deny it.
- The MediaMTX auth hook denies `publish` to everyone except the service account. A design where something *pushes* video into MediaMTX needs that hook extended deliberately.
- Recorder clocks are wrong and "Z" timestamps are local time on these NVRs (`timeMode`, `clockDriftSeconds`). Any new search/playback/export code must go through `deviceClock()` / `toDeviceTime()` / `fromDeviceTime()`.
- Business rule: playback comes from the recorder's own disks. **No long-term recording storage on this server.** Temporary export files need my approval and an automatic clean-up.
- `getCameraForUser()` returns the recorder's `host` to callers. Audit whether internal IPs reach non-admin browsers and report it (do not silently change it).

---

## 3. Target scope (the whole programme)

1. **CP Plus via InstaOnCloud** — first priority.
2. **Reusable multi-vendor adapter architecture** for LAN devices (Hikvision-protocol, Tyco/Holis, CP Plus, generic ONVIF/RTSP).
3. **Cloud/P2P brands** — Honeywell (P2P, mobile app), Hikvision (Hik-Connect / iVMS), CP Plus (InstaOnCloud / KVMS): investigate official routes only.
4. **Professional player** — digital zoom, PTZ where supported, layouts 1/2/4/9/16, enlarge/return, playback speed, pause/resume, frame stepping, single and multi-frame capture, timeline scrolling.
5. **Downloads** — fast download, download-manager (IDM) compatibility, parallel downloading where the source supports it, time-range export, per-camera recordings, progress / speed / ETA.

One fact frames all of it: **a browser cannot open raw TCP/UDP sockets, cannot speak RTSP, and cannot run a manufacturer's native P2P stack.** Every integration therefore terminates on the server (or a companion process next to it) and reaches the browser through the existing MediaMTX → WebRTC/HLS path. A vendor-supplied WebAssembly player is the only exception, and only where the vendor officially provides one.

---

## PHASE 0 — Orientation (read-only)

1. Read `AGENTS.md`, `README.md`, `package.json`, `.env.example` (never `.env`), `mediamtx/mediamtx.yml`, `docker-compose.yml`, `src/db/schema.ts`, and every file in the table in section 2.
2. Read the Next.js 16 guides you will need under `node_modules/next/dist/docs/` (route handlers, server actions, proxy, caching).
3. Confirm or correct every statement in section 2. List anything that has changed.
4. Create `docs/cctv/STATUS.md`.
5. Ask permission for `git init` + baseline commit.

**Deliver:** `docs/cctv/00-architecture.md` — a one-page map of frontend, backend, DB, streaming, auth, deployment, plus a "do not break" list. **STOP.**

---

## PHASE 1 — Prove what works today (read-only)

1. Ask me to confirm `npm run dev` is running. Do not start a second dev server on the same `.next` directory.
2. Using the app's own code paths (for example `npm run health:run`) and read-only queries on the `vms` schema, record: recorders, vendor values, models, channel counts, camera count, codecs, status.
3. Answer explicitly: **Is there any Tyco-specific or CP Plus-specific code? Which physical brands are actually connected, and through which protocol?** (See the `HRN-64081S-R` note in section 2.)
4. Ask me whether there are Hikvision-branded or Tyco devices that are *not* in the database yet and that I expect to be "working".

**Deliver:** `docs/cctv/01-current-integrations.md`. **STOP.**

---

## PHASE 2 — CP Plus InstaOnCloud investigation (FIRST PRIORITY, read-only, no code)

Device on record:

- Manufacturer: CP Plus — Platform: InstaOnCloud — Connection: Cloud / P2P
- Device name: `CP PLUS HQ`
- Serial number: `2EGCNCI2R12QERBG` (use it only inside this project; never in web searches)
- Username: `admin` — Password: held by me, entered only through the app form or `RECORDER_PASSWORD`

### 2A. Questions I must answer first — ask them and wait
1. Exact model number and firmware of `CP PLUS HQ`. Is it a DVR, an NVR or a single camera? How many channels?
2. Where is it physically? Is it on the same routed network as this server (172.x), at another site, or behind an ISP router we do not control?
3. From this server, can the device's LAN IP be reached at all (directly, or through an existing site-to-site VPN / MPLS link)? If yes, what is the IP?
4. Is `admin` the device's own local account, or the login of the InstaOn/KVMS/mobile-app cloud account? Is the device bound to a cloud account, and whose?
5. Does the company have a CP Plus distributor or support contact who can supply an official SDK and its licence terms?
6. Recording: does the device record to its own disk? Main-stream codec (H.264 or H.265)?

### 2B. Research (official sources first; cite every claim)
Answer each of these with evidence and a tag:
1. How does InstaOnCloud identify and reach a device from its serial number? (Registration to a vendor relay/rendezvous service, NAT traversal, relay fallback.) What is officially documented?
2. Does CP Plus publish an **official cloud API or SDK** for third-party software? Start at CP Plus's own site (there is a page at `cpplusworld.com/sdk` — read what it actually offers, for which products, on which operating systems, under which licence, and whether it covers P2P/serial-number login or only IP login).
3. Does KVMS (or KVMS Pro) expose any supported integration interface (export, API, RTSP re-streaming, plugin)? Or is it only an end-user client?
4. Does the serial number alone grant access? (Expected: no — a device account and usually a bound cloud account are also required. Verify.)
5. Which local protocols does this exact model support: RTSP, ONVIF (which profiles — S for live, G for recordings, T), a documented HTTP API?
6. Can any of this run in a browser? (See the framing fact in section 3.)

Leads to test — these are **not** facts; verify each against official documentation and the device itself:
- `[COMMUNITY]` Many CP Plus recorders and IP cameras are reported to use the Dahua-style RTSP path `rtsp://<ip>:554/cam/realmonitor?channel=<n>&subtype=<0|1>` (0 = main, 1 = sub). Some CP Plus consumer Wi-Fi models are reported to use port `5543` with `/live/channel1` instead. Model and firmware decide.
- `[ASSUMPTION]` If the unauthenticated probe shows a Dahua-compatible platform, the manufacturer's published HTTP API specification for that platform (system info, recording file search, download-by-time, snapshot, PTZ over digest-auth HTTP) may apply. Use it only after you have found the official specification document and confirmed on the device that the endpoints answer. Do not write an adapter from memory.
- `[ASSUMPTION]` A vendor network SDK, if obtainable, will be a native Windows/Linux library, not JavaScript. Using it means a companion process, not browser code.
- My own search on 2026-11-20 found **no public official documentation** of a third-party InstaOnCloud API. Treat "official cloud API exists" as unproven until you find it on a CP Plus domain.

### 2C. Decide the integration route — evaluate in this order
| # | Route | When it applies | Verdict you must give |
|---|---|---|---|
| A | **Direct LAN/VPN**: server reaches the device IP → RTSP live through existing MediaMTX, plus ONVIF / documented HTTP API for channels, recordings, PTZ | Device is routable from the server | Preferred. Cloud not needed at all. |
| B | **Network extension**: site-to-site VPN (or the company's existing WAN) so that Route A becomes possible | Device at another site we control | Preferred over any cloud route. Needs my network team. |
| C | **Edge relay**: a small MediaMTX at the remote site pulls RTSP locally; the central MediaMTX pulls from it over an authenticated, encrypted link (or the edge publishes inward — requires extending the auth hook) | Remote site, no VPN possible, we can run a small machine there | Valid. Describe ports, auth, encryption, and what breaks for NVR playback/search. |
| D | **Official vendor SDK in a companion service**: native process logs in (IP or officially supported P2P), receives video, republishes to MediaMTX as RTSP | Only if CP Plus supplies an SDK that officially supports this and its licence allows it | Valid only with the real SDK in hand. List OS, architecture, licence, how frames become an RTSP/H.264 stream, and what extra dependency that needs. |
| E | **Official cloud API** | Only if documented by CP Plus | Unproven. Do not design around it without the document. |
| F | Port-forwarding + DDNS to the device | Never by default | Explain the security cost; recommend against unless I insist, and then only with IP allow-listing and non-default ports. |
| ✗ | Re-implemented/reverse-engineered P2P, traffic capture of the vendor app, extracted app keys | — | **Forbidden.** Do not propose. |

### 2D. Unauthenticated probe (only if 2A gives a reachable IP, and only after I approve)
Write a throw-away script under `scripts/` (not wired into the app) that, for one host I give you, reports: which TCP ports accept connections (reuse `tcpProbe` from `src/lib/health/monitor.ts`); RTSP `OPTIONS` response and `Server` header; HTTP status line and identifying headers of `/`; ONVIF `GetSystemDateAndTime` (which the ONVIF specification allows without authentication) on the ONVIF port. No credentials are sent. Show me the output with the IP masked in anything you save to disk.

**Deliver:** `docs/cctv/02-cpplus-instaoncloud.md` containing: findings with tags, the route table filled in with a clear recommendation, the complete NEEDED FROM USER list, and — if an SDK must be requested — a ready-to-send email to CP Plus support listing exactly what to ask for (SDK name, OS, P2P/serial login support, redistribution licence, documentation). **STOP.**

---

## PHASE 3 — CP Plus connection plan (design only)

Based on the route I choose, write `docs/cctv/03-cpplus-plan.md`:
- Exact files to add or change, in order, each step independently testable.
- Schema additions needed for this device only (see Phase 5 for the full model; do not over-build now).
- How the path is registered in MediaMTX so that `reconcileAll()` keeps it and `mediamtx-auth` authorises it.
- How health is determined for a device with no directly probe-able host (if cloud).
- Codec plan: if the device sends H.265, state the options honestly — switch that channel/sub-stream to H.264 on the device (needs my approval, it is a device configuration change), or rely on browser H.265 support (recent Chrome supports H.265 over WebRTC only with hardware decoding; verify the current state for the browsers we use, and whether MediaMTX 1.21.3 forwards H.265 over WHEP), or HLS fallback. No server-side transcoding without my approval (CPU cost).
- Acceptance test (below).

**STOP for approval.**

---

## PHASE 4 — Implement and prove the CP Plus connection

Implement the approved plan in small commits.

**A connection counts as successful only when all of these are true, and you show the evidence:**
1. I entered the password myself through the app form (or `RECORDER_PASSWORD`); it is stored only as `password_enc`.
2. Exactly one authenticated attempt was made; it succeeded.
3. MediaMTX reports the path as ready with real tracks — codec and resolution read back through `mtx` in `src/lib/mediamtx/client.ts`.
4. The stream plays in the existing `WhepPlayer` in my browser and I confirm I see the real camera.
5. A viewer without access to that site is denied (test with the stream token of a restricted user or by reasoning from `tokenAllows()` with evidence).
6. `npm run typecheck` passes. Existing recorders still play.

If any step fails, report the exact failure text and stop. Do not paper over it.

**Deliver:** `docs/cctv/04-cpplus-result.md` with a table: capability (live main, live sub, channel list, device info, recording search, recorder playback, download, PTZ, snapshot) × status (VERIFIED / NOT SUPPORTED / NOT TESTED / BLOCKED — reason). **STOP.**

---

## PHASE 5 — Reusable adapter architecture (design, then behaviour-preserving refactor)

### 5A. Design document first
Write `docs/cctv/05-adapter-architecture.md`. Core idea to evaluate: **separate the brand from the protocol.** A "Tyco Holis" NVR speaks the Hikvision ISAPI protocol; a CP Plus recorder may speak a Dahua-compatible one; many devices speak only ONVIF + RTSP. So store:
- `brand` — what the user sees (Hikvision, Tyco / Holis, CP Plus, Honeywell, Other).
- `adapter` — the protocol implementation (for example `hikvision-isapi`, the CP Plus adapter proven in Phase 4, `onvif`, `generic-rtsp`).

Propose an adapter contract in `src/lib/vendors/` — start from this sketch and refine it against the real code; every method beyond `liveRtspPath` is optional and gated by a capability flag:

```ts
export interface AdapterCapabilities {
  deviceInfo: boolean; channelImport: boolean; channelStatus: boolean;
  subStream: boolean; snapshot: boolean; ptz: boolean;
  recordingSearch: boolean; rtspPlayback: boolean; playbackScale: boolean;
  recordingDownload: boolean; downloadRange: boolean; clock: boolean;
}
export interface VendorAdapter {
  id: string; label: string;
  capabilities(device: Device): AdapterCapabilities;
  liveRtspPath(device: Device, channel: number, stream: "main" | "sub"): string;
  getDeviceInfo?(device: Device): Promise<DeviceInfo>;
  listChannels?(device: Device): Promise<ChannelInfo[]>;
  channelStatus?(device: Device): Promise<Map<number, ChannelStatus>>;
  searchRecordings?(device: Device, channel: number, from: Date, to: Date): Promise<RecordingSegment[]>;
  playbackRtspUrl?(device: Device, channel: number, from: Date, to: Date): string;
  downloadRecording?(device: Device, segment: RecordingSegment, range?: string): Promise<Response>;
  snapshot?(device: Device, channel: number): Promise<Response>;
  ptz?(device: Device, channel: number, command: PtzCommand): Promise<void>;
}
```

Rules for the design:
- The Hikvision adapter **wraps the existing functions in `src/lib/hikvision/isapi.ts` unchanged**. No rewrite of ISAPI, digest auth, clock/drift handling or the auth back-off.
- Replace the single global provider slot in `src/lib/devices/health.ts` with a registry keyed by adapter id.
- Every call site listed under "Hikvision is hard-wired" in section 2 moves to `getAdapter(device)` + a capability check. Where a capability is missing, the UI must say "Not supported by this device", never fail silently and never fake it.
- UI reads capabilities from the server; it never branches on brand names.

### 5B. Data model — propose, do not assume
Determine the fields from the real devices. Candidates to evaluate (all additive):

| Field | On | Purpose |
|---|---|---|
| `brand` | devices | Display manufacturer |
| `adapter` (integration method) | devices | Which protocol implementation |
| `connection_type` (`LAN` / `CLOUD` / `P2P` / `RELAY`) | devices | How the server reaches it |
| `onvif_port`, `sdk_port` | devices | Extra service ports |
| `cloud_device_id` | devices | Vendor cloud/P2P serial as entered by the user — keep separate from `serial_number`, which the health check overwrites from the device |
| `cloud_account_ref` / encrypted cloud secret | devices or a new `cloud_accounts` table | Only if an official cloud route exists |
| `vendor_config` (jsonb) | devices | Adapter-specific settings without a schema change per vendor |
| `capabilities` (jsonb) + `capabilities_checked_at` | devices | Cached result of probing |
| `sub_rtsp_path` or a stream-profile field | cameras | Sub-stream for grids |
| `ptz_capable` | cameras | Show PTZ controls only where real |

Also resolve: `devices.host` is NOT NULL and unique with `rtsp_port` — what does a cloud-only device store? Propose the least invasive answer. Existing rows must keep working with no data migration beyond safe defaults (`brand` and `adapter` backfilled from today's `vendor`).

Passwords and any cloud secret use `encryptSecret()`; nothing new is stored in plain text.

### 5C. Refactor
After I approve 5A and 5B: migrate, introduce the registry, move call sites one at a time. After each step: `npm run typecheck`, and I re-test live view, playback, channel import and health on the two existing recorders. **Zero behaviour change for existing devices is the acceptance criterion.**

### 5D. Discovery and onboarding
- ONVIF WS-Discovery uses UDP multicast and only finds devices on the server's own subnet; in Docker it needs host networking (already used). State this limit in the UI. Always offer manual add by IP.
- "Test connection" in the device form: runs the unauthenticated probe, then **one** authenticated attempt, and shows detected platform, channels and capabilities before saving.
- NVR/DVR channel discovery and channel → camera mapping go through `listChannels`; generalise `importDeviceChannels()`.
- An ONVIF client needs SOAP + WS-Security digest. If you want a library, name it, show its licence and maintenance status, and ask first.

**STOP after each of 5A, 5B, 5C, 5D.**

---

## PHASE 6 — Additional manufacturers (one at a time, same discipline as Phases 2–4)

For each: 2A-style questions → research → unauthenticated probe → one authenticated attempt → capability table.

- **CP Plus on the LAN** (pending devices on 172.x): ask me for IPs and models.
- **Generic ONVIF/RTSP devices.**
- **Hikvision via Hik-Connect (cloud):** the official third-party route is Hikvision's partner OpenAPI (Hik-Partner Pro / Hik-Connect OpenAPI on the Hikvision Technology Partner Portal, `tpp.hikvision.com`) `[DOC — verify current terms]`. It requires a partner account and AppKey/Secret issued by Hikvision; the portal mentions a browser WASM decoder kit and limits on cloud-only live view. Establish what account I must apply for and what it costs before any code. The EZVIZ Open Platform is a different product and account system — do not mix them up. iVMS-4200 is an end-user client, not an integration interface — verify. If the device is reachable on the LAN/VPN, the existing ISAPI adapter is the better route.
- **Honeywell (P2P, mobile app):** unknown territory. I called the app "IHB"; first ask me for the exact device model(s) and the exact app name, then research. No public SDK was found in a first search — treat as unproven. LAN ONVIF/RTSP is the likely realistic route if the devices are routable.

For every cloud brand, the possible honest outcomes include **"not possible through officially supported means; here is the LAN/VPN/relay alternative."** That is an acceptable deliverable.

**STOP after each manufacturer.**

---

## PHASE 7 — Professional player

Build on `whep-player.tsx`, `live-grid.tsx` and `playback-browser.tsx`. Do not start a second player. Keep WebRTC-first with HLS fallback, the stream-token flow and the Stores / Corporate tabs.

**7.1 Digital zoom (client-only, no backend change).** A reusable pan/zoom hook applied to the `<video>` via CSS transforms: mouse-wheel zoom centred on the cursor, buttons for in / out / reset, drag to pan when zoomed, double-click to reset, clamped so the frame never leaves the tile, aspect ratio preserved, state independent per tile, works in fullscreen, pinch on touch. Snapshot gets a choice: full frame or current zoomed view. Wheel handling must not hijack page scroll when zoom is 1×.

**7.2 Layouts.** Add a 2-camera layout to the existing 1 / 4 / 9 / 16. Double-click (or an enlarge button) maximises a tile; Escape or the same action returns to the previous layout, page and selection. Keep the per-user saved state.

**7.3 Sub-streams for grids.** Sixteen main streams is heavy for the browser, the server and the NVR. Use the sub-stream in multi-tile layouts and the main stream when a tile is enlarged or zoomed. This needs a second MediaMTX path per camera — update the reconciler, `storeOfPath()` and the token `paths` claim together. Measure before and after (bitrate per tile, browser CPU) and report real numbers.

**7.4 PTZ (only where `capabilities.ptz` is true and verified on hardware).** Server-side only, through the adapter; new permission (for example `ptz.control`, ADMIN and MANAGER); every command audited; press-and-hold with guaranteed stop on release, blur and disconnect; rate-limited. Digital zoom remains the default everywhere else. Hide PTZ controls for cameras without it.

**7.5 Playback transport — be honest about what a live relay can do.**
- *Pause / resume:* pausing freezes the picture locally while the recorder keeps sending. Resume must restart the playback session at the paused timestamp (the player already has an `onRestart` hook used for this pattern).
- *Speed / fast-forward:* a real-time RTSP relay cannot be sped up with `video.playbackRate`. Investigate, in order: (1) whether MediaMTX 1.21.3 exposes an RTSP `Scale` option for static sources — check the local binary's own configuration reference / Control API schema rather than trusting release notes — and whether these recorders honour `Scale` on playback `[verify on device]`; (2) "clip mode" below. Offer only the speeds that are proven to work.
- *Frame-by-frame, previous / next frame, multi-frame view:* impossible on a live relay. Requires **clip mode**: fetch a short, bounded time range as a seekable file and play it in a plain `<video>` — then `playbackRate`, exact pause, stepping by one frame duration, `requestVideoFrameCallback` timestamps and a thumbnail strip all work. The recorder's download container may not be browser-playable; establish what it actually is. If remuxing is needed that means `ffmpeg` (not installed — ask) or a short MediaMTX recording of the playback path served through the existing Range-capable `/api/playback/[cameraId]/media` route. Compare both with measurements. Temporary files need my approval, a size cap and automatic deletion.
- *Timeline:* scrolling and zooming of the existing timeline (hour / 10 min / 1 min scales), keyboard shortcuts, recorded-range shading already comes from the recorder's index.
- *Timestamp display:* true recording time, corrected through `deviceClock()`, never the browser clock.

**7.6 Frames.** Single-frame capture exists (PNG). Add: timestamp and camera name burned in optionally, multi-frame extraction over a range at an interval (from clip mode), export as individual images. Audit exports.

Each sub-phase is its own change, with a short manual test script for me. **STOP after each.**

---

## PHASE 8 — Downloads and export

First establish facts on the real recorders (read-only, one request each, no loops):
1. Does the recorder's download endpoint honour HTTP `Range` (send one small ranged request; is the answer `206` with `Content-Range`, or `200`)?
2. Does it send `Content-Length`?
3. How many simultaneous download and playback sessions does the recorder allow, and does a download slow down live view?
4. Can a download be limited to a sub-range of a file, or only whole files as returned by the recording search?

Then design from the facts:
- **Recorded footage only.** A live RTSP stream is not a recording; never present "record the live stream now" as a download of past footage.
- **Fast download:** direct pass-through streaming from the recorder (as today), no buffering in memory.
- **Download-manager (IDM) compatibility:** needs `Accept-Ranges`, `Content-Length`, stable URLs and correct `Content-Disposition`. If the recorder supports `Range`, forward it. If it does not, the only way is a server-side spooled export (temporary file, capped size, auto-deleted) served with full Range support — ask me before choosing this, because of the no-storage rule. External download managers do not carry the HttpOnly session reliably: evaluate a short-lived, single-file, signed download URL (same `jose` approach as `stream-token.ts`), bound to user and camera, with the permission check and audit kept.
- **"Torrent-style" parallel downloading:** BitTorrent itself does not apply — recorders do not speak it. What is real: (a) multi-connection ranged download of one file, only if Range is proven; (b) a queue that downloads several recorder files in parallel with a **low, per-recorder concurrency limit**. Say plainly which of these the hardware supports.
- **Time-range export:** select start/end on the timeline → list the recorder files that cover it → download them as a set, or as one trimmed file only if trimming is proven possible (recorder-side sub-range, or remux — see the `ffmpeg` note).
- **Progress, speed, ETA:** from real byte counts (`Content-Length` and bytes transferred) — for in-browser downloads via streamed fetch, for server-side jobs via a job-status endpoint. No simulated progress bars. If total size is unknown, show bytes and speed, and no ETA.
- Keep `playback.export` permission checks and the `playback.exported` audit entry on every path.

**STOP after the facts report, and again after each feature.**

---

## PHASE 9 — Performance, security, reliability

- **Performance:** 16-tile wall for 30 minutes — browser CPU/memory, MediaMTX CPU, per-recorder session count, reconnect behaviour when a recorder drops. Real measurements, stated with the hardware they were taken on.
- **Security review (report findings before fixing):** search the client bundle and every API response for credentials, RTSP URLs, internal IPs and serial numbers; confirm every new route calls `requireApiUser` with the right roles and store scope; confirm new MediaMTX paths are covered by `storeOfPath()`; confirm audit entries contain no secrets; confirm new env vars are in `src/env.ts` (zod) and `.env.example` with safe placeholders; confirm rate limits on PTZ, probe and download endpoints; confirm "Test connection" cannot be used to scan arbitrary internal hosts by non-admins (SSRF).
- **Reliability:** adapter timeouts, auth back-off for every adapter, a device that is offline must not slow the health loop for others, clean-up of temporary files and playback sessions.
- Update `README.md` (features, ports, vendor support matrix marked VERIFIED / NOT VERIFIED) and `.env.example`.

**Deliver:** `docs/cctv/09-test-report.md`.

---

## START NOW

Begin with **Phase 0**. Do not write or modify application code. Your first reply must contain only:
1. Confirmation that you read this prompt and the files listed in Phase 0, with any corrections to section 2.
2. The contents of `docs/cctv/00-architecture.md` and the initial `docs/cctv/STATUS.md`.
3. The request to `git init`.
4. The Phase 2A questions, so I can gather answers while you continue to Phase 1 after my "continue".
