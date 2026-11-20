import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * Minimal HTTP Digest (RFC 7616, MD5 / MD5-sess, qop=auth) client on top of fetch.
 * Hikvision recorders use Digest by default; Basic is tried only when the
 * device explicitly asks for it. Nonces are cached per origin so repeated
 * calls cost one round trip instead of two.
 */

interface Challenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm: string;
  nc: number;
}

const challenges = new Map<string, Challenge>();

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

function parseChallenge(header: string): Challenge | null {
  if (!/^digest\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  const re = /(\w+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header.slice(7)))) {
    const key = (m[1] ?? "").toLowerCase();
    params[key] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
  }
  if (!params.realm || !params.nonce) return null;
  const qop = params.qop
    ?.split(",")
    .map((q) => q.trim())
    .find((q) => q === "auth");
  return { realm: params.realm, nonce: params.nonce, qop, opaque: params.opaque, algorithm: params.algorithm ?? "MD5", nc: 0 };
}

function authorization(ch: Challenge, method: string, uri: string, user: string, pass: string): string {
  ch.nc += 1;
  const nc = ch.nc.toString(16).padStart(8, "0");
  const cnonce = randomBytes(8).toString("hex");
  let ha1 = md5(`${user}:${ch.realm}:${pass}`);
  if (/md5-sess/i.test(ch.algorithm)) ha1 = md5(`${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = ch.qop ? md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${ch.qop}:${ha2}`) : md5(`${ha1}:${ch.nonce}:${ha2}`);
  const parts = [
    `username="${user}"`,
    `realm="${ch.realm}"`,
    `nonce="${ch.nonce}"`,
    `uri="${uri}"`,
    `algorithm=${ch.algorithm}`,
    `response="${response}"`,
  ];
  if (ch.opaque) parts.push(`opaque="${ch.opaque}"`);
  if (ch.qop) parts.push(`qop=${ch.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(", ")}`;
}

export interface DigestRequest {
  method?: "GET" | "POST" | "PUT";
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class DigestAuthError extends Error {
  constructor(public status: number) {
    super(status === 401 ? "Recorder rejected the username or password" : `Recorder returned HTTP ${status}`);
  }
}

/** fetch() with Digest (or Basic) authentication. The response body is not consumed. */
export async function digestFetch(url: string, user: string, pass: string, req: DigestRequest = {}): Promise<Response> {
  const u = new URL(url);
  const method = req.method ?? "GET";
  const uri = u.pathname + u.search;
  const timeout = req.timeoutMs ?? 10_000;

  const send = (auth?: string) =>
    fetch(url, {
      method,
      body: req.body,
      headers: { ...(req.headers ?? {}), ...(auth ? { Authorization: auth } : {}) },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });

  const cached = challenges.get(u.origin);
  let res = await send(cached ? authorization(cached, method, uri, user, pass) : undefined);
  if (res.status !== 401) return res;

  const header = res.headers.get("www-authenticate") ?? "";
  await res.body?.cancel().catch(() => undefined);
  const ch = parseChallenge(header);
  // A 401 on a cached nonce only warrants a retry when the nonce changed or is
  // marked stale; otherwise the password is wrong and a retry would just add a
  // failed login towards the recorder's account lockout.
  if (cached && ch && ch.nonce === cached.nonce && !/stale\s*=\s*"?true/i.test(header)) {
    challenges.delete(u.origin);
    throw new DigestAuthError(401);
  }
  if (ch) {
    challenges.set(u.origin, ch);
    res = await send(authorization(ch, method, uri, user, pass));
  } else if (/^basic/i.test(header) && u.protocol === "https:") {
    // Basic sends the password in clear text, so it is only allowed over HTTPS.
    res = await send(`Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`);
  }
  if (res.status === 401) {
    challenges.delete(u.origin);
    await res.body?.cancel().catch(() => undefined);
    throw new DigestAuthError(401);
  }
  return res;
}
