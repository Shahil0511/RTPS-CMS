# Centralized CCTV Application – Feasibility Response

**To:** IT Department, Libas
**Date:** 23 November 2026
**Subject:** One in-house application for all cameras (CP Plus, Hikvision, Honeywell, Tyco) across stores, warehouses and corporate office

---

## 1. Short answer

**Yes, this is possible, and the application is already built.**

It is one application for every camera brand. It does not need any per-camera licence, and it does not store any video on our server. Recordings stay on each store's own NVR, as they do today.

The only thing stopping most stores from showing live video today is **network access**, not the software. This is explained in point 4.

---

## 2. What the application does

1. **Live view**: watch cameras from all stores, warehouses and the corporate office in one place, in a normal web browser. No software to install.
2. **Playback**: watch old recordings directly from each store's NVR, with a timeline to jump to any time.
3. **User-wise access**: each store manager or user can be given only their own locations, and even only specific cameras inside a location.
4. **Video download**: download can be allowed or blocked for each user separately. Every download is recorded with who did it and when.
5. **Health monitoring and alerts**:
   - The application checks every camera and NVR regularly.
   - When a camera or NVR goes offline, an email is sent with the store name, the camera name or ID, and since when it is down.
   - When it comes back online, another email is sent with the total downtime.
   - If a whole NVR goes down, one email is sent for it, not one email per camera.
   - Very short network drops (under 3 minutes) do not send emails, so people are not flooded with alerts.
6. **Daily health report**: every morning (9:00 AM) by email: which cameras went offline yesterday, when, for how long, and which are still offline.
7. **Downtime history**: a full record of every outage, which can be searched and downloaded in Excel (CSV).
8. **Audit log**: every login, playback, download and setting change is recorded against the user.

---

## 3. Status today

| | Status |
|---|---|
| **Warehouse (2 NVRs, 115 cameras)** | Working live. Live view, playback and health monitoring are tested on these NVRs. |
| **Stores (61 locations, 64 NVRs/DVRs from the store sheet)** | All are added in the application. They show as **"Pending network"** (62) or **"Cloud-only"** (2) because the server cannot reach them yet. |
| **Corporate office and new warehouse** | Not in the store sheet yet. Please share their NVR details. |
| **Email alerts and daily report** | Built. They will start as soon as we get an email account (SMTP) to send from. |

**By brand:**
- **Tyco / Hikvision / Honeywell (Hikvision-based):** tested and working on the warehouse NVRs. Store units will work the same way once they are reachable.
- **CP Plus:** support is built, but we could not test it on a real CP Plus unit yet, because none is reachable. We will confirm it on one pilot store.
- **Cloud-only units (Hik-Connect, InstaOnCloud, IH View app only):** these cannot be connected, because these companies do not give an official way for outside software to connect. This needs either a local network connection or a partner agreement with the brand.

Stores that are not reachable yet are shown clearly in the application. They do **not** send false "offline" alerts.

**Already useful:** on the warehouse NVRs the application has already found that 16 of the 115 cameras were offline, one NVR has a hard-disk error, and both NVR clocks run fast (about 18 and 39 minutes). Turning on time sync (NTP) on the NVRs will fix the clocks.

---

## 4. Why store cameras are not live yet

Store NVRs have local IP addresses like 192.168.1.x. These addresses only work **inside that store**. Many stores even use the same address (for example, two different stores both have 192.168.1.168), so the server cannot reach them over the internet by address alone.

We understand a VPN is not possible. These are the other ways to connect, in order of preference:

1. **Check the existing company network (WAN).** 27 store NVRs have 172.16.x addresses, which usually means they are already on a company-wide network. If that network reaches the corporate office or warehouse, one small box there can connect all of them at once.
   *Needed:* ask the network/ISP provider whether these stores are reachable from the office or warehouse.
2. **A small box at each store.** A low-cost mini computer, connected to the store's NVR network, which makes a secure connection to our server. It needs no router changes and no open ports. It uses internet only when someone is watching.
   *Needed:* budget approval, and store staff to plug it in (about 15 minutes per store).
3. **Brand partner access (only for cloud-only units).** Apply to Hikvision and CP Plus for official partner access.
   *Needed:* registration with each company. Approval and timelines depend on them.

**We do not recommend** opening ports on store routers (it puts NVRs on the open internet) or unofficial hacks of the brand apps.

---

## 5. Corrections needed in the store sheet

While adding the stores, we found these problems in 32 of the 64 recorders:

- **Same IP for different stores**: please confirm the correct NVR address for each store.
- **IP missing**: please give the address, or tell us the store is cloud-only.
- **Serial number missing, or a model number written in place of the serial**: please send the serial number from the NVR label.
- **Brand missing or unclear** (for example "Hikvision/Hikvision"): please give the exact make and model from the NVR label.
- **Login type unclear**: for each store, please tell us whether the username and password are the **NVR's own login** or the **mobile/cloud app login**. Only the NVR's own login can be used.
- **Store email missing** (13 stores): needed only if stores should get their own alerts.
- **Corporate office and new warehouse**: please send their NVR list (make, model, IP, number of cameras).

**Important:** the store sheet has NVR passwords in plain text. Please do not share it over email or shared drives. Once the passwords are entered in the application (where they are stored encrypted), we recommend changing them and deleting the sheet.

---

## 6. Security

- **No video is stored on our server.** It only passes through. Recordings stay on the store NVR.
- **Passwords are stored encrypted** and are never shown on screen, in emails or in logs.
- **NVRs are never locked out.** If a login fails, the application stops trying that NVR for 30 minutes.
- **Every view and download is logged** against the user, which helps in any investigation.
- **Only official methods are used** to connect to cameras. No hacks, no open ports.

---

## 7. Next steps

| # | What | Who |
|---|---|---|
| 1 | Send an email account (SMTP details: host, port, sender ID) for alerts, and the list of people who should receive alerts, per location | IT Department |
| 2 | Correct the store sheet (point 5) and add the corporate office and new warehouse NVRs | IT Department |
| 3 | Ask the network provider whether the 172.16.x stores can be reached from the office or warehouse | Business / Operations |
| 4 | Approve a small pilot: one CP Plus store and one Hikvision store with a store box | Business / Operations |
| 5 | Test alerts, daily report, user access and download together on the warehouse NVRs | VMS team, with IT |
| 6 | Turn on time sync (NTP) and replace the faulty disk on the warehouse NVR | IT / site vendor |
| 7 | Connect stores one by one as they become reachable. Alerts start automatically for each one. | VMS team |

We are happy to show the application running live on the warehouse NVRs at any time that suits you.
