import { NextRequest, NextResponse } from "next/server"
import { parseDocx } from "@/lib/docx-parser"
import { startBackgroundNotes, type BackgroundNoteJob } from "@/lib/ai-service"
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-limits"

// Parsing the document and handing chunks to OpenAI can take up to a minute, which
// exceeds the platform's short default function timeout.
export const maxDuration = 60
// mammoth and docx rely on Node APIs such as Buffer, so the edge runtime is unusable.
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get("file") as File | null
    const pagesStr = formData.get("pages") as string | null
    const pages = Math.min(Math.max(parseInt(pagesStr || "1", 10) || 1, 1), 25)
    const titleName = ((formData.get("titleName") as string | null) || "").trim().slice(0, 150)
    const duration = ((formData.get("duration") as string | null) || "").trim().slice(0, 40)

    if (!file) {
      return NextResponse.json(
        { error: "No file provided." },
        { status: 400 }
      )
    }

    if (!file.name.toLowerCase().endsWith(".docx")) {
      return NextResponse.json(
        { error: "Only .docx files are supported." },
        { status: 400 }
      )
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `The file is larger than the ${MAX_UPLOAD_LABEL} limit.` },
        { status: 400 }
      )
    }

    const arrayBuffer = await file.arrayBuffer()

    const transcript = await parseDocx(arrayBuffer)

    if (!transcript.trim()) {
      return NextResponse.json(
        { error: "Could not extract text from the document." },
        { status: 400 }
      )
    }

    let jobs: BackgroundNoteJob[]
    try {
      jobs = await startBackgroundNotes(transcript, pages)
    } catch (aiError: any) {
      console.error("AI service error:", aiError)
      return NextResponse.json(
        {
          error: aiError.message || "Failed to start note generation.",
        },
        {
          status: aiError.message?.includes("OpenAI") || aiError.message === "fetch failed" ? 503 : 500,
        }
      )
    }

    const sourceName = file.name.replace(/\.docx$/i, "").replace(/[^a-z0-9-_ ]/gi, "").trim() || "class"
    const downloadName = `${sourceName} - Organized Notes.docx`

    return NextResponse.json({
      jobs,
      downloadName,
      pageCount: pages,
      totalSections: jobs.length,
      titleName,
      duration,
    })
  } catch (error: any) {
    console.error("Upload error:", error)
    return NextResponse.json(
      { error: error.message || "An unexpected error occurred." },
      { status: 500 }
    )
  }
}
