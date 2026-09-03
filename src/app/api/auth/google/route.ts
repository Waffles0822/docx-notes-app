import { NextRequest, NextResponse } from "next/server"
import { getAuthUrl } from "@/lib/google-docs"
import { cookies } from "next/headers"

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const docUrl = searchParams.get("docUrl")
  const redirectTo = searchParams.get("redirectTo") || "/"
  const write = searchParams.get("write") === "true"
  const mode = searchParams.get("mode") || "import"

  if (!docUrl) {
    return NextResponse.json({ error: "docUrl parameter required" }, { status: 400 })
  }

  const state = Buffer.from(JSON.stringify({ docUrl, redirectTo, mode })).toString("base64url")
  const authUrl = getAuthUrl(state, write)

  const cookieStore = await cookies()
  cookieStore.set("gdocs_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  })

  return NextResponse.redirect(authUrl)
}
