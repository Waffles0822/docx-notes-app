import { NextRequest, NextResponse } from "next/server"
import { decryptGoogleTokens, encryptGoogleTokens, ensureFreshGoogleTokens, getAuthUrl } from "@/lib/google-docs"
import { cookies } from "next/headers"

const GOOGLE_SESSION_SECONDS = 60 * 60 * 24 * 30

function authorizationComplete(request: NextRequest) {
  const origin = JSON.stringify(request.nextUrl.origin)
  return new NextResponse(
    `<!doctype html><html><body><p>Google authorization complete. You can close this window.</p><script>window.opener?.postMessage({type:"gdocs-auth-success"},${origin});window.close();</script></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  )
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const docUrl = searchParams.get("docUrl")
  const redirectTo = searchParams.get("redirectTo") || "/"
  const write = searchParams.get("write") === "true"
  const mode = searchParams.get("mode") || "import"

  if (!docUrl) {
    return NextResponse.json({ error: "docUrl parameter required" }, { status: 400 })
  }

  const cookieStore = await cookies()
  if (mode === "export") {
    const savedAuthorization = cookieStore.get("gdocs_export_tokens")?.value
    if (savedAuthorization) {
      try {
        const tokens = await ensureFreshGoogleTokens(decryptGoogleTokens(savedAuthorization))
        cookieStore.set("gdocs_export_tokens", encryptGoogleTokens(tokens), {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: GOOGLE_SESSION_SECONDS,
          path: "/api",
        })
        return authorizationComplete(request)
      } catch {
        cookieStore.delete("gdocs_export_tokens")
      }
    }
  }

  const state = Buffer.from(JSON.stringify({ docUrl, redirectTo, mode })).toString("base64url")
  const authUrl = getAuthUrl(state, write)
  cookieStore.set("gdocs_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  })

  return NextResponse.redirect(authUrl)
}
