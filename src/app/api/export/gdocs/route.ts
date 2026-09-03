import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { decryptGoogleTokens, writeNotesToGoogleDoc } from "@/lib/google-docs"

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

    const tokenCookie = (await cookies()).get("gdocs_export_tokens")?.value
    if (!tokenCookie) {
      return NextResponse.json({ error: "Google authorization expired. Please try again." }, { status: 401 })
    }

    await writeNotesToGoogleDoc(decryptGoogleTokens(tokenCookie), docUrl, notesHtml, title, duration)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Google Docs export failed:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to write notes to Google Docs." },
      { status: 500 }
    )
  }
}
