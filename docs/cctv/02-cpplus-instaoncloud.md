# Phase 2 — CP Plus InstaOnCloud Investigation Report

Device on record:
- **Manufacturer**: CP Plus
- **Platform**: InstaOnCloud
- **Connection Type**: Cloud / P2P
- **Device Name**: `CP PLUS HQ`
- **Device Serial**: `2EGCNCI2R12QERBG`
- **Credentials**: Username `admin` is a **cloud login only**; **no local device credentials are available** `[USER]`
- **Status**: **BLOCKED (awaiting client info)**

---

## 1. Research Findings & Technical Evidence

### 1.1 How InstaOnCloud Reaches Devices via Serial Number
- **Mechanism**: InstaOnCloud (`instaon.com`, `redclouddvr.instaon.com`) functions as a closed vendor rendezvous and P2P NAT traversal relay service `[COMMUNITY]`. The recorder registers an outbound TCP/UDP heartbeat with vendor servers using its factory serial number `[COMMUNITY]`.
- **Client Handshake**: When a vendor client (e.g. `gCMOB`, `iCMOB`, `KVMS Pro`) requests a feed, the cloud service coordinates UDP hole-punching between the client and recorder; if traversal fails, media traffic is relayed through vendor bandwidth servers `[COMMUNITY]`.
- **Proprietary Protocol**: The protocol is closed and proprietary; no open specification or RFC is published `[COMMUNITY]`.

### 1.2 Availability of Official Cloud API or SDK
- **Official Public Portal**: Visiting the public developer download page yields **"No record found!"** `[DOC: https://www.cpplusworld.com/sdk]`.
- **Public Downloads**: The public CP Plus download center provides only consumer and installer utilities (`KVMS Pro`, `IP Finder`, `Smart Player`, user manuals) `[DOC: https://www.cpplusworld.com/support-search]`.
- **Third-Party Cloud API**: There is no publicly documented REST API, OpenAPI, or WebRTC cloud gateway for third-party developers on CP Plus public domains `[ASSUMPTION — verified by search on https://www.cpplusworld.com]`.
- **Native Enterprise SDK**: Proprietary C/C++ SDKs for Windows and Linux are reported to exist for enterprise partners, but they are not publicly accessible and require formal distributor authorization `[COMMUNITY]`.

### 1.3 KVMS Pro Capabilities
- **Role**: `KVMS Pro` is strictly an end-user client / CMS application `[DOC: https://www.cpplusworld.com/software/kvms-pro]`.
- **No Integration Interfaces**: It exposes no RTSP re-streaming server, REST API, Webhook mechanism, or third-party plugin interface `[COMMUNITY]`. It cannot be used as a headless middleware or gateway for this web VMS.

### 1.4 Authentication Requirements & Credential Status
- **Serial Number Alone**: A serial number alone does not grant access; cloud binding and account credentials are required `[COMMUNITY]`.
- **Credential State**: The provided username `admin` is a cloud account login `[USER]`. **No local device credentials (LAN IP username/password) are currently available** `[USER]`.

### 1.5 Local Protocols Supported by CP Plus Hardware (Unverified for this device)
Reported specifications for CP Plus recorders on a local network include:
- **RTSP**: `rtsp://<user>:<password>@<ip>:554/cam/realmonitor?channel=<n>&subtype=<0|1>` `[COMMUNITY]`.
- **ONVIF**: Profiles S, G, and T `[COMMUNITY]`.
- **HTTP CGI**: General Surveillance CGI endpoints (`/cgi-bin/configManager.cgi`, etc.) over HTTP Digest auth `[COMMUNITY]`.
- *Verification Requirement*: Because the device LAN IP is currently unknown and unreachable, all local protocol support on this exact hardware remains `[ASSUMPTION — unverified until device is reachable]`.

### 1.6 Browser Execution Feasibility
- **Browser Constraints**: A modern web browser cannot open raw TCP/UDP sockets, cannot speak RTSP, and cannot execute proprietary P2P binary stacks `[REPO: mediamtx/mediamtx.yml, src/components/player/whep-player.tsx]`.
- **Legacy Web Portal**: The historical web portal at `instaon.com` required an obsolete Internet Explorer **ActiveX plugin** (`"To use InstaOn service you need to install/update your ActiveX first"`), which modern browsers (Chrome, Edge, Firefox) have completely deprecated `[COMMUNITY]`.
- **Architectural Fact**: All CCTV streams must terminate on the server/relay and reach the browser via MediaMTX WebRTC (WHEP) or HLS `[REPO: src/lib/mediamtx/client.ts]`.

---

## 2. Integration Route Evaluation

| # | Route | Feasibility for `CP PLUS HQ` | Verdict |
|---|---|---|---|
| **A** | **Direct LAN / Routed IP** | Requires known, reachable LAN IP and local credentials. | **Unverified.** Currently blocked by lack of IP and local credentials. |
| **B** | **Network Extension (Site-to-Site VPN / MPLS)** | Connects remote site to server network. | **Recommended Architecture** once network team assists. |
| **C** | **Edge MediaMTX Relay** | Edge node on camera LAN pulls local RTSP, publishes inward over TLS. | **Valid Alternative** if site-to-site VPN cannot be deployed. |
| **D** | **Official Vendor SDK in Companion Process** | Requires official CP Plus Linux/Windows SDK with P2P login support from distributor. | **Valid only if official SDK is provided.** Requires companion daemon. |
| **E** | **Official Cloud API** | Third-party REST/WebRTC API accepting serial + cloud login. | **NOT SUPPORTED.** No public official cloud API exists. |
| **F** | **Port-Forwarding + DDNS** | Opening port 554/80 directly on remote router. | **Discouraged.** High security risk. |
| **✗** | **Reverse-Engineered P2P / Packet Capture** | Unofficial protocols / decompiled app tokens. | **FORBIDDEN.** Violates project safety rules. |

---

## 3. Recommendation & Current Verdict

1. **Verdict**: **BLOCKED (awaiting client info)**. Direct third-party cloud streaming via Serial Number + Cloud Login is **NOT SUPPORTED** through any documented, public interface. Because project rules strictly forbid reverse engineering, no authenticated cloud attempt can be made.
2. **Path Forward**:
   - The device must be integrated via **Route B (Site-to-site VPN)** or **Route C (Edge MediaMTX Relay)** once LAN reachability is established, or via **Route D (Official Vendor SDK)** if supplied by the distributor.

---

## 4. NEEDED FROM USER

1. **Network Topology & IP**: Can `CP PLUS HQ` be reached over a local or VPN-routed IP address? If yes, what is the IP?
2. **Local Hardware & Credentials**: What are the local device credentials (distinct from the InstaOn cloud login), and what is the exact hardware model?
3. **Vendor SDK Contact**: Can your procurement or technical contact request the official Linux/Windows SDK and licensing terms from your authorized CP Plus distributor?

---

## 5. Formal SDK Request Template (For User's Distributor / Support Contact)

```text
To: [Your CP Plus Distributor / Account Manager / Technical Contact]
Subject: Request for Official CP Plus Developer SDK & Third-Party Integration Documentation (Enterprise VMS)

Dear CP Plus Technical Support & Engineering Team,

We are developing an internal enterprise Video Management System (VMS) for central monitoring of our infrastructure, which includes CP Plus NVR and DVR hardware.

We currently have CP Plus recording units deployed (including device serial: 2EGCNCI2R12QERBG) and require official integration resources to securely ingest live video feeds and recording playback into our central management console.

Could you please provide us with:
1. The official CP Plus Network SDK / General Surveillance SDK (Linux x86_64 and Windows x64 libraries, header files, and documentation).
2. Documentation on whether the SDK supports device connection via Cloud Serial Number / P2P login, or if it is restricted to direct IP/port connectivity.
3. The official HTTP API / CGI command specification for CP Plus recorders (system info, channel status, PTZ, recording search, and media download).
4. Licensing and redistribution terms for deploying the SDK runtime binaries within our private enterprise application servers.

Please let us know if an NDA or formal registration form is required to receive these developer packages.

Sincerely,
System Architecture Team
Libas VMS Project
```
