import { NextRequest, NextResponse } from "next/server"
import { encryptGoogleTokens, getTokensFromCode } from "@/lib/google-docs"
import { cookies } from "next/headers"

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const error = searchParams.get("error")

  const cookieStore = await cookies()
  const storedState = cookieStore.get("gdocs_state")?.value
  cookieStore.delete("gdocs_state")

  if (error) {
    const redirectUrl = new URL("/?error=google_auth_denied", request.url)
    return NextResponse.redirect(redirectUrl)
  }

  if (!code || !state || !storedState || state !== storedState) {
    const redirectUrl = new URL("/?error=invalid_oauth_state", request.url)
    return NextResponse.redirect(redirectUrl)
  }

  try {
    const tokens = await getTokensFromCode(code)
    const parsedState = JSON.parse(Buffer.from(state, "base64url").toString())
    const { docUrl, redirectTo, mode } = parsedState

    if (mode === "export") {
      cookieStore.set("gdocs_export_tokens", encryptGoogleTokens(tokens), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 600,
        path: "/api/export/gdocs",
      })
      const origin = JSON.stringify(request.nextUrl.origin)
      return new NextResponse(
        `<!doctype html><html><body><p>Google authorization complete. You can close this window.</p><script>window.opener?.postMessage({type:"gdocs-auth-success"},${origin});window.close();</script></body></html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
      )
    }

    const tokenData = Buffer.from(JSON.stringify(tokens)).toString("base64url")
    const encodedDocUrl = Buffer.from(docUrl).toString("base64url")

    const redirectUrl = new URL(`/api/import/gdocs?tokens=${tokenData}&docUrl=${encodedDocUrl}&redirectTo=${encodeURIComponent(redirectTo)}`, request.url)
    return NextResponse.redirect(redirectUrl)
  } catch (err) {
    console.error("Google OAuth token exchange failed:", err)
    const redirectUrl = new URL("/?error=token_exchange_failed", request.url)
    return NextResponse.redirect(redirectUrl)
  }
}
