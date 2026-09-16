import { NextRequest, NextResponse } from "next/server"
import { AUTH_COOKIE_NAME } from "@/lib/auth-core.mjs"
import { isValidAuthToken } from "@/lib/auth-core.mjs"

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  if (!pathname.startsWith("/api/") || pathname.startsWith("/api/auth/login") || pathname.startsWith("/api/auth/session") || pathname.startsWith("/api/auth/logout")) {
    return NextResponse.next()
  }

  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value
  if (!token || !await isValidAuthToken(token)) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 })
  }
  return NextResponse.next()
}

export const config = { matcher: ["/api/:path*"] }
