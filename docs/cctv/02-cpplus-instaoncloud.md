# Phase 2 — CP Plus InstaOnCloud Investigation Report

Device on record:
- **Manufacturer**: CP Plus
- **Platform**: InstaOnCloud
- **Connection Type**: Cloud / P2P
- **Device Name**: `CP PLUS HQ`
- **Device Serial**: `2EGCNCI2R12QERBG`
- **Account**: `admin` (cloud login)

---

## 1. Research Findings & Technical Evidence

### 1.1 How InstaOnCloud Reaches Devices via Serial Number
- **Mechanism**: InstaOnCloud (`instaon.com`, `redclouddvr.instaon.com`) is a proprietary vendor rendezvous and P2P NAT traversal service `[COMMUNITY]`. The recorder registers an outbound TCP/UDP heartbeat to CP Plus cloud relays using its factory serial number.
- **Client Handshake**: When an authorized client (e.g., `gCMOB`, `iCMOB`, `KVMS Pro`) requests a stream, the cloud service facilitates UDP hole-punching between client and recorder; if hole-punching fails, video is relayed through vendor bandwidth servers `[COMMUNITY]`.
- **Proprietary Protocol**: The protocol is closed-source and proprietary. No open specification exists.

### 1.2 Availability of Official Cloud API or SDK
- **Official Public Portal**: An exhaustive search of `cpplusworld.com` and `cpplusworld.com/sdk` yields **"No record found!"** `[DOC: cpplusworld.com/sdk]`.
- **Public Downloads**: The public CP Plus download center offers only consumer and installer utilities (`KVMS Pro`, `IP Finder`, `Smart Player`, user manuals) `[DOC: cpplusworld.com/support]`.
- **Third-Party Cloud API**: CP Plus publishes **no public REST API, OpenAPI, or WebRTC cloud gateway** allowing external applications to stream video via serial number and cloud credentials `[DOC]`.
- **Native Enterprise SDK**: CP Plus has proprietary C/C++ SDKs (historically aligned with Dahua General Surveillance NetSDK architecture) for Windows and Linux. However, these are strictly enterprise-gated, provided only upon direct application and NDA via authorized distributors or `support@cpplusworld.com` `[DOC / COMMUNITY]`.

### 1.3 KVMS Pro Capabilities
- **Role**: `KVMS Pro` is strictly an end-user client application (CMS) `[DOC: cpplusworld.com KVMS Pro Manual]`.
- **No Integration Interfaces**: It does not expose an RTSP re-streaming server, REST API, Webhook mechanism, or third-party plugin interface `[DOC]`. It cannot act as a headless middleware or gateway for a web VMS.

### 1.4 Authentication Requirements
- The serial number alone does not grant access. The platform requires the device or cloud credentials (`admin`), and devices are cryptographically bound to specific registered cloud accounts to prevent unauthorized access `[DOC / COMMUNITY]`.

### 1.5 Local Protocols Supported by CP Plus Hardware
When accessible over a local network or VPN, CP Plus recorders natively support standard open protocols:
- **RTSP**: `rtsp://<user>:<password>@<ip>:554/cam/realmonitor?channel=<n>&subtype=<0|1>` (0 = main stream, 1 = sub stream) `[DOC / COMMUNITY]`.
- **ONVIF**: Profile S (live streaming), Profile G (edge recording search & playback), Profile T (advanced codecs) `[DOC]`.
- **HTTP CGI**: General Surveillance CGI endpoints (`/cgi-bin/configManager.cgi`, `/cgi-bin/snapshot.cgi`, `/cgi-bin/ptz.cgi`, `/cgi-bin/mediaFileFind.cgi`) using HTTP Digest authentication `[DOC]`.

### 1.6 Browser Execution Feasibility
- **Browser Constraints**: A modern web browser cannot open raw TCP/UDP sockets, cannot speak RTSP, and cannot run proprietary P2P binary protocols `[REPO: mediamtx.yml, whep-player.tsx]`.
- **Legacy Web Portal**: The historical web portal at `instaon.com` required an obsolete Internet Explorer **ActiveX plugin** (`"To use InstaOn service you need to install/update your ActiveX first"`), which modern browsers (Chrome, Edge, Firefox) have completely deprecated `[COMMUNITY]`.
- **Architectural Conclusion**: Every CCTV integration must terminate on the server or an edge gateway, forwarding media to browsers as WebRTC (WHEP) or HLS via MediaMTX.

---

## 2. Integration Route Evaluation

| # | Route | Feasibility for `CP PLUS HQ` | Verdict |
|---|---|---|---|
| **A** | **Direct LAN / Routed IP** | Device IP must be routable from this server. | **Preferred if routable.** Cloud P2P not needed. |
| **B** | **Network Extension (Site-to-Site VPN / MPLS)** | Connects the remote site network to the central server. | **Strongly Recommended.** Best long-term reliability and zero cloud dependency. |
| **C** | **Edge MediaMTX Relay** | A small edge node (e.g. Raspberry Pi / Mini PC) on the camera LAN runs MediaMTX, pulling local RTSP and publishing inward to the central server over authenticated TLS. | **Recommended Alternative** if a site-to-site VPN cannot be deployed. |
| **D** | **Official Vendor SDK in Companion Process** | Requires official CP Plus Linux/Windows SDK with P2P login support from distributor. | **Valid only if official SDK is provided.** Requires companion C++/Go/Node daemon. |
| **E** | **Official Cloud API** | Third-party REST/WebRTC API accepting serial + cloud login. | **NOT SUPPORTED.** No public official cloud API exists. |
| **F** | **Port-Forwarding + DDNS** | Opening port 554/80 directly on remote router. | **Discouraged.** Severe security risk unless strictly IP-allowlisted. |
| **✗** | **Reverse-Engineered P2P / Packet Capture** | Unofficial protocols / decompiled app tokens. | **FORBIDDEN.** Violates project safety rules. |

---

## 3. Recommendation & Verdict

1. **Verdict**: Direct third-party cloud streaming via Serial Number + Cloud Login is **NOT SUPPORTED** by CP Plus through any documented, public interface.
2. **Path Forward**:
   - **Primary Recommendation (Route B / A)**: Route the device's local network to this server via an existing company WAN, site-to-site VPN, or WireGuard tunnel. Once routable, connect using native RTSP and Dahua/CP Plus CGI adapter.
   - **Secondary Recommendation (Route C)**: Deploy a lightweight edge MediaMTX relay at the remote site pulling RTSP locally and pushing over TLS to the central MediaMTX.
   - **SDK Option (Route D)**: In parallel, submit the formal SDK request below to CP Plus technical support.

---

## 4. NEEDED FROM USER

1. **Network Topology & IP**: Can `CP PLUS HQ` be assigned a local IP reachable via an existing site-to-site VPN, MPLS link, or SD-WAN? If yes, what is the IP address?
2. **Physical Hardware Details**: Exact model number and firmware version of `CP PLUS HQ` (found on physical label or local web UI).
3. **Local Credentials**: Local device administrator username and password (distinct from InstaOnCloud web login), to be entered into the app form or `.env` when network access is established.
4. **CP Plus Distributor Contact**: Confirmation whether your procurement team has a dedicated CP Plus account manager or support rep to expedite the SDK request below.

---

## 5. Formal SDK Request Email (Ready to Send)

```text
To: support@cpplusworld.com
Cc: [Your CP Plus Distributor / Account Manager]
Subject: Request for Official CP Plus Developer SDK & Third-Party Integration Documentation (Enterprise VMS)

Dear CP Plus Technical Support & Engineering Team,

We are developing an internal enterprise Video Management System (VMS) for central monitoring of our retail and corporate infrastructure, which includes CP Plus NVR and DVR hardware.

We currently have CP Plus recording units deployed (including device serial: 2EGCNCI2R12QERBG) and require official integration resources to securely ingest live video feeds and recording playback into our central management console.

Could you please provide us with:
1. The official CP Plus Network SDK / General Surveillance SDK (Linux x86_64 and Windows x64 libraries, header files, and C++/C# wrapper documentation).
2. Documentation on whether the SDK supports device connection via Cloud Serial Number / P2P login, or if it is restricted to direct IP/port connectivity.
3. The official HTTP API / CGI command specification for CP Plus recorders (system info, channel status, PTZ, recording search, and media download).
4. Licensing and redistribution terms for deploying the SDK runtime binaries within our private enterprise application servers.

Please let us know if an NDA or formal registration form is required to receive these developer packages.

Sincerely,
System Architecture Team
Libas VMS Project
```
