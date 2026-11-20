/**
 * RTSP URL helpers. Camera credentials are stored separately and only
 * combined into a URL on the server when talking to MediaMTX.
 */

export interface RtspParts {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  path: string;
}

/**
 * Parses an RTSP URL, tolerating un-encoded "@" characters inside the password
 * (e.g. rtsp://admin:Pa@ss@10.0.0.1:554/stream): the host is everything after the LAST "@".
 */
export function parseRtspUrl(input: string): RtspParts {
  const trimmed = input.trim();
  const m = /^rtsps?:\/\/(.*)$/i.exec(trimmed);
  if (!m) throw new Error("URL must start with rtsp://");
  const rest = m[1] ?? "";
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "/" : rest.slice(slash);

  const at = authority.lastIndexOf("@");
  let username: string | null = null;
  let password: string | null = null;
  let hostPort = authority;
  if (at !== -1) {
    const cred = authority.slice(0, at);
    hostPort = authority.slice(at + 1);
    const colon = cred.indexOf(":");
    if (colon === -1) {
      username = safeDecode(cred);
    } else {
      username = safeDecode(cred.slice(0, colon));
      password = safeDecode(cred.slice(colon + 1));
    }
  }
  const [hostRaw, portRaw] = hostPort.split(":");
  const host = (hostRaw ?? "").trim();
  if (!host) throw new Error("URL is missing a host");
  const port = portRaw ? Number.parseInt(portRaw, 10) : 554;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  return { host, port, username, password, path: path || "/" };
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export function buildRtspUrl(parts: RtspParts): string {
  const auth =
    parts.username != null && parts.username !== ""
      ? `${encodeURIComponent(parts.username)}${parts.password ? `:${encodeURIComponent(parts.password)}` : ""}@`
      : "";
  const path = parts.path.startsWith("/") ? parts.path : `/${parts.path}`;
  return `rtsp://${auth}${parts.host}:${parts.port}${path}`;
}

export function maskRtspUrl(parts: RtspParts): string {
  return buildRtspUrl({ ...parts, password: parts.password ? "••••••" : null });
}

/** Converts a human name into a MediaMTX-safe path segment. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export interface ImportedCamera {
  name: string;
  url: string;
  parts: RtspParts;
}

/**
 * Parses a free-form camera list such as the NVR export used on site:
 *   Table Number: -1
 *   rtsp://admin:pass@host:554/Streaming/Unicast/channels/101
 * Lines without a label are named after their channel.
 */
export function parseCameraList(text: string): { cameras: ImportedCamera[]; errors: string[] } {
  const cameras: ImportedCamera[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let pendingLabel: string | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^rtsps?:\/\//i.test(line)) {
      try {
        const parts = parseRtspUrl(line);
        const key = `${parts.host}:${parts.port}${parts.path}`;
        if (seen.has(key)) {
          pendingLabel = null;
          continue;
        }
        seen.add(key);
        const channel = /channels\/(\d+)/i.exec(parts.path)?.[1];
        const name = pendingLabel ?? (channel ? `Channel ${channel}` : `Camera ${cameras.length + 1}`);
        cameras.push({ name, url: line, parts });
      } catch (e) {
        errors.push(`${line}: ${(e as Error).message}`);
      }
      pendingLabel = null;
      continue;
    }
    const label = /^(?:table\s*(?:number|no\.?)?\s*[:#-]*\s*-?\s*(\d+))$/i.exec(line);
    if (label) {
      pendingLabel = `Table ${label[1]}`;
    } else if (!/^rtsp/i.test(line) && line.length < 80 && !line.includes("://")) {
      // Any other short text line is treated as the label of the next URL.
      pendingLabel = line.replace(/[:#-]+$/, "").trim() || null;
    }
  }
  return { cameras, errors };
}
