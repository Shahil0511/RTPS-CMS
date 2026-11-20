import { NextResponse, type NextRequest } from "next/server";
import { apiError, noStore } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { rolesFor } from "@/lib/auth/rbac";
import { requireApiUser, requestMeta } from "@/lib/auth/session";
import { deviceUptimeFor } from "@/lib/devices/health";
import { runHealthCheck, uptimeFor } from "@/lib/health/monitor";
import { listCamerasForUser } from "@/server/queries/cameras";
import { listDevicesForUser } from "@/server/queries/devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current status of every visible camera (polled by the health page and live grid). */
export async function GET(req: NextRequest) {
  try {
    const user = await requireApiUser(rolesFor("health.view"));
    const storeId = req.nextUrl.searchParams.get("storeId");
    const [cams, devs] = await Promise.all([listCamerasForUser(user, { storeId }), listDevicesForUser(user, { storeId })]);
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [uptime, deviceUptime] = await Promise.all([
      uptimeFor(
        cams.map((c) => c.id),
        since,
      ),
      deviceUptimeFor(
        devs.map((d) => d.id),
        since,
      ),
    ]);
    return noStore(
      NextResponse.json({
        checkedAt: new Date().toISOString(),
        devices: devs.map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          store: d.store.name,
          storeId: d.store.id,
          host: d.host,
          rtspPort: d.rtspPort,
          httpPort: d.httpPort,
          status: d.status,
          isEnabled: d.isEnabled,
          lastCheckedAt: d.lastCheckedAt,
          lastOnlineAt: d.lastOnlineAt,
          lastError: d.lastError,
          lastLatencyMs: d.lastLatencyMs,
          model: d.model,
          serialNumber: d.serialNumber,
          firmware: d.firmware,
          storageStatus: d.storageStatus,
          cameraCount: d.cameraCount,
          onlineCameraCount: d.onlineCameraCount,
          uptime24h: deviceUptime.get(d.id) ?? null,
        })),
        items: cams.map((c) => ({
          id: c.id,
          name: c.name,
          store: c.store.name,
          storeId: c.store.id,
          deviceId: c.deviceId,
          deviceName: c.device?.name ?? null,
          channel: c.channel,
          host: c.device?.host ?? c.host,
          port: c.device?.rtspPort ?? c.port,
          status: c.status,
          isEnabled: c.isEnabled,
          recordEnabled: c.recordEnabled,
          lastCheckedAt: c.lastCheckedAt,
          lastOnlineAt: c.lastOnlineAt,
          lastError: c.lastError,
          lastLatencyMs: c.lastLatencyMs,
          videoCodec: c.videoCodec,
          audioCodec: c.audioCodec,
          resolution: c.resolution,
          readerCount: c.readerCount,
          uptime24h: uptime.get(c.id) ?? null,
        })),
      }),
    );
  } catch (e) {
    return apiError(e);
  }
}

/** Runs a health check immediately. */
export async function POST() {
  try {
    const user = await requireApiUser(rolesFor("health.run"));
    const result = await runHealthCheck();
    const meta = await requestMeta();
    await audit({
      actor: user,
      action: "health.check_run",
      entityType: "system",
      details: {
        online: result.online,
        offline: result.offline,
        unknown: result.unknown,
        transitions: result.transitions.length,
        devicesOnline: result.devicesOnline,
        devicesOffline: result.devicesOffline,
        deviceTransitions: result.deviceTransitions.length,
        mediamtxReachable: result.mediamtxReachable,
      },
      ...meta,
    });
    return noStore(NextResponse.json(result));
  } catch (e) {
    return apiError(e);
  }
}
