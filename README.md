# Libas VMS

Enterprise video management system built on a fully free, open-source stack:

| Layer | Technology |
| --- | --- |
| Web app | Next.js 16 (App Router, React 19, TypeScript), Tailwind CSS 4 |
| Streaming server | [MediaMTX](https://github.com/bluenviron/mediamtx) (MIT) – RTSP → WebRTC / HLS for live and NVR playback |
| Recorders | Hikvision-compatible NVR/DVR over ISAPI (digest auth) and RTSP |
| Database | PostgreSQL (shared server, isolated `vms` schema) via Drizzle ORM |
| Auth | Signed HTTP-only session cookies (jose), bcrypt passwords, role + store based access |

## Features

- **Dashboard** – cameras online, NVR/DVR online/offline, 24-hour availability trend, cameras by site, recorder disk and clock alerts, offline list with the NVR's reason.
- **Live monitoring** – Stores and Corporate tabs (corporate offices and warehouses), WebRTC with automatic HLS fallback, 1/4/9/16 grids, wall mode, snapshots. Streams are pulled from the NVR only while someone watches.
- **Playback from the NVR** – the recording index is read from each recorder (ISAPI search) and footage is streamed from the recorder's own disks on demand, so **no recording storage is needed on this server**. Click anywhere on the timeline, jump ±30 s / ±5 min, download the NVR's file.
- **Recorders** – NVR/DVR inventory, one-click channel import (names taken from the NVR), model/firmware/disk status, automatic clock-drift and time-zone correction.
- **Health monitoring** – recorder reachability plus per-channel status reported by the NVR (no video needed), uptime %, status history.
- **Store management** – stores, corporate offices and warehouses; credentials encrypted at rest (AES-256-GCM).
- **User permissions** – Administrator / Manager / Viewer roles with store-wise restrictions; MediaMTX authorises every stream through the app.
- **Audit logs** – sign-ins, failed attempts, configuration changes, playback views and exports, with CSV export.
- Brute-force lockout, forced password rotation, session revocation, security headers, liveness endpoint.

## Quick start (Windows / Linux / macOS)

```bash
npm install
cp .env.example .env          # then edit: DATABASE_URL, SESSION_SECRET, ENCRYPTION_KEY, MEDIAMTX_API_PASS
npm run mediamtx:download     # fetches the MediaMTX binary into mediamtx/bin (already present on this machine)
npm run setup                 # creates the "vms" schema + tables, admin user, default store, cameras from link.txt
npm run dev                   # starts MediaMTX and the web app together (concurrently)
```

Open <http://localhost:3000> and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env` (you will be asked to set a new password).

Generate strong secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY (must be 64 hex chars)
```

### Adding a recorder (NVR/DVR)

In the app: **Recorders → Add recorder**, then the row menu **Import channels**. Or from a terminal (password via an environment variable so it never lands in history):

```powershell
$env:RECORDER_PASSWORD = "…"
npm run recorder:add -- --site WH --name "NVR 4" --host 172.16.1.4 --user admin --import
```

Add `--rename` to also rename existing linked cameras to the NVR's channel names. `npm run health:run` runs one health check and prints a summary.

**Recorder clock.** Most Hikvision NVRs report times as local wall-clock with a trailing "Z"; the default "Local time" setting handles that. Clock drift (e.g. an NVR running 17 minutes fast) is measured every 10 minutes and corrected automatically for search and playback. Fix NTP on the NVR to remove the warning.

**Account safety.** After a rejected login the app stops calling that recorder for 30 minutes so it never locks the NVR's admin account; saving a new password retries immediately.

### Running the pieces separately

```bash
npm run mediamtx   # streaming server (reads mediamtx/mediamtx.yml, records to ./recordings)
npm run dev:web    # Next.js dev server only
npm run build && npm start   # production
```

### Database

All tables are created inside the schema named by `DATABASE_SCHEMA` (default `vms`). Nothing is written to `public` or any other schema.

```bash
npm run db:generate   # after editing src/db/schema.ts → new SQL migration in ./drizzle
npm run db:migrate    # apply migrations (also runs automatically when the server boots)
npm run db:studio     # Drizzle Studio, scoped to the vms schema
```

### Docker

```bash
docker compose up -d --build
```

Uses host networking so WebRTC (UDP 8189) and the LAN cameras are reachable without extra port mapping.

## Network / ports

| Port | Purpose |
| --- | --- |
| 3000 | Web application |
| 8889 (TCP) + 8189 (UDP/TCP) | WebRTC / WHEP for browsers |
| 8888 | HLS for browsers |
| 8554 | RTSP proxy (VLC etc. – sign in with your VMS email/password) |
| 9997 / 9996 / 9998 | Control API / local playback / metrics – internal, called by the app only |
| NVR 80 + 554 | The app server must reach each recorder's HTTP (ISAPI) and RTSP ports |

When users open the console from other machines, set `MEDIAMTX_PUBLIC_WEBRTC_URL` and `MEDIAMTX_PUBLIC_HLS_URL` to the server's LAN address.

## How streaming authorisation works

1. The browser asks `/api/stream/:cameraId`; the app checks the user's role and store access and returns a short-lived bearer token scoped to that one stream.
2. The browser connects to MediaMTX (WHEP or HLS) with that token.
3. MediaMTX calls back `/api/internal/mediamtx-auth` for every action; the app validates the token (or the service account / a VMS user's credentials for RTSP clients).

Cameras are registered with MediaMTX through its Control API whenever they change, and a background reconciler re-registers them every minute (MediaMTX does not persist API-added paths across restarts). Playback creates a temporary path per viewer (`pb-…`) whose source is the NVR's RTSP playback URL; a janitor removes it within about 90 seconds of the viewer leaving.

## Project layout

```
src/app            pages and route handlers (App Router)
src/components     UI kit and feature components (player, live grid, playback, tables)
src/server         server actions and query modules
src/lib            auth, audit, crypto, MediaMTX client/sync, health monitor
src/db             Drizzle schema (Postgres, "vms" schema) and connection
drizzle/           SQL migrations
mediamtx/          MediaMTX config (+ bin/ with the downloaded binary)
scripts/           helper scripts (seed, migrate, run/download MediaMTX, dev orchestration)
```

## Notes on codecs

Browsers can decode H.264 over WebRTC and HLS. If a camera streams H.265, switch its NVR channel to H.264 (or use the sub-stream `/Streaming/Unicast/channels/<n>02`). Audio over WebRTC requires Opus/G.711; AAC audio is dropped on WebRTC but kept in recordings and HLS.
