import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { auth0 } from "./lib/auth0";
import { isPathAllowed, landingPathFor, resolveAccess } from "./lib/access";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Keep sales-rep images public so Looker Studio can load them.
  if (pathname.startsWith("/reps/")) {
    return NextResponse.next();
  }

  // Public website chat bubble (dendefenders.com). No login: the widget file
  // is plain JavaScript, and /api/website-bot does its own origin check, kill
  // switch and rate limits (lib/websiteBotGuard.ts). Nothing else is opened.
  if (pathname === "/chat-widget.js" || pathname === "/api/website-bot") {
    return NextResponse.next();
  }

  // Let Auth0 handle login, callback, and logout routes.
  const authResponse = await auth0.middleware(request);

  if (pathname.startsWith("/auth/")) {
    return authResponse;
  }

  const session = await auth0.getSession(request);

  if (session) {
    // Role check: sales reps and installers only reach the Scheduler and
    // Talk with Denny; the Team page and Owner Dashboard are owner-only.
    const access = await resolveAccess(session);

    if (access && isPathAllowed(access.role, pathname)) {
      return authResponse;
    }

    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Your Den Coach Denny role does not include this feature." },
        { status: 403 }
      );
    }

    return NextResponse.redirect(
      new URL(landingPathFor(access?.role ?? "disabled"), request.url)
    );
  }

  // API requests receive an authorization error instead of a login webpage.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const loginUrl = new URL("/auth/login", request.url);

  loginUrl.searchParams.set(
    "returnTo",
    `${pathname}${request.nextUrl.search}`
  );

  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};