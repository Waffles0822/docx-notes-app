import { NextRequest, NextResponse } from "next/server"
import { fetchGoogleDocContent, GoogleTokens } from "@/lib/google-docs"
import { startBackgroundNotes, type BackgroundNoteJob } from "@/lib/ai-service"
import { createNotesDocx } from "@/lib/docx-generator"

export const maxDuration = 60
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const tokensParam = searchParams.get("tokens")
  const docUrlParam = searchParams.get("docUrl")
  const redirectTo = searchParams.get("redirectTo") || "/"
  const pagesParam = searchParams.get("pages")
  const titleName = searchParams.get("titleName") || ""
  const duration = searchParams.get("duration") || ""

  if (!tokensParam || !docUrlParam) {
    const redirectUrl = new URL(`${redirectTo}?error=missing_params`, request.url)
    return NextResponse.redirect(redirectUrl)
  }

  try {
    const tokens: GoogleTokens = JSON.parse(Buffer.from(tokensParam, "base64url").toString())
    const docUrl = Buffer.from(docUrlParam, "base64url").toString()

    const { title, text } = await fetchGoogleDocContent(tokens, docUrl)

    if (!text.trim()) {
      const redirectUrl = new URL(`${redirectTo}?error=empty_document`, request.url)
      return NextResponse.redirect(redirectUrl)
    }

    const pages = pagesParam ? Math.min(Math.max(parseInt(pagesParam, 10) || 5, 1), 80) : 5

    const jobs = await startBackgroundNotes(text, pages)

    const sourceName = title.replace(/[^a-z0-9-_ ]/gi, "").trim() || "Google Doc"
    const downloadName = `${sourceName} - Organized Notes.docx`

    const statusCheckUrl = new URL("/api/status", request.url)
    const statusBody = JSON.stringify({
      jobs,
      downloadName,
      pageCount: pages,
      titleName: titleName || title,
      duration,
    })

    const statusResponse = await fetch(statusCheckUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: statusBody,
    })

    if (statusResponse.ok) {
      const contentType = statusResponse.headers.get("Content-Type") || ""
      if (contentType.includes("application/vnd.openxmlformats")) {
        const docxBuffer = await statusResponse.arrayBuffer()
        return new NextResponse(docxBuffer, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
          },
        })
      }
    }

    const redirectUrl = new URL(`${redirectTo}?importStarted=true&jobs=${encodeURIComponent(JSON.stringify(jobs))}&downloadName=${encodeURIComponent(downloadName)}&pageCount=${pages}&titleName=${encodeURIComponent(titleName || title)}&duration=${encodeURIComponent(duration)}`, request.url)
    return NextResponse.redirect(redirectUrl)
  } catch (err) {
    console.error("Google Docs import failed:", err)
    const errorMsg = err instanceof Error ? err.message : "Import failed"
    const redirectUrl = new URL(`${redirectTo}?error=${encodeURIComponent(errorMsg)}`, request.url)
    return NextResponse.redirect(redirectUrl)
  }
}