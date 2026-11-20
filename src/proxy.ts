import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session-edge";

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/internal/mediamtx-auth", "/api/health/live"];

/**
 * Request gate: unauthenticated users are redirected to the login page,
 * API callers receive 401. Fine-grained role checks happen in pages/actions.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const claims = token ? await verifySessionToken(token) : null;

  if (!claims) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    const login = new URL("/login", request.url);
    if (pathname !== "/") login.searchParams.set("next", pathname + request.nextUrl.search);
    const res = NextResponse.redirect(login);
    if (token) res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  }

  // Accounts flagged for password rotation can only reach the profile page (and APIs it needs).
  if (claims.pw && !pathname.startsWith("/profile") && !pathname.startsWith("/api/")) {
    return NextResponse.redirect(new URL("/profile?reason=change-password", request.url));
  }

  const res = NextResponse.next();
  res.headers.set("x-vms-user", claims.sub);
  return res;
}

export const config = {
  matcher: [
    // Everything except static assets and Next internals.
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|assets/).*)",
  ],
};
