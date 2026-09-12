import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { decryptGoogleTokens, encryptGoogleTokens, ensureFreshGoogleTokens, writeNotesToGoogleDoc } from "@/lib/google-docs"

const GOOGLE_SESSION_SECONDS = 60 * 60 * 24 * 30

export const maxDuration = 60
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get("origin")
    if (origin && origin !== request.nextUrl.origin) {
      return NextResponse.json({ error: "Invalid request origin." }, { status: 403 })
    }

    const body = await request.json()
    const docUrl = typeof body.docUrl === "string" ? body.docUrl.trim() : ""
    const notesHtml = typeof body.notesHtml === "string" ? body.notesHtml : ""
    const title = typeof body.title === "string" ? body.title.slice(0, 150) : "Organized Notes"
    const duration = typeof body.duration === "string" ? body.duration.slice(0, 40) : ""
    if (!docUrl || !notesHtml) {
      return NextResponse.json({ error: "Google Docs URL and generated notes are required." }, { status: 400 })
    }

    const cookieStore = await cookies()
    const tokenCookie = cookieStore.get("gdocs_export_tokens")?.value
    if (!tokenCookie) {
      return NextResponse.json({ error: "Google authorization expired. Please try again." }, { status: 401 })
    }

    const tokens = await ensureFreshGoogleTokens(decryptGoogleTokens(tokenCookie))
    cookieStore.set("gdocs_export_tokens", encryptGoogleTokens(tokens), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: GOOGLE_SESSION_SECONDS,
      path: "/api",
    })
    await writeNotesToGoogleDoc(tokens, docUrl, notesHtml, title, duration)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Google Docs export failed:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to write notes to Google Docs." },
      { status: 500 }
    )
  }
}
