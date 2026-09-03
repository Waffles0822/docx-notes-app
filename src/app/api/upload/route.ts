import { NextRequest, NextResponse } from "next/server"
import { parseFile } from "@/lib/docx-parser"
import { startBackgroundNotes, type BackgroundNoteJob } from "@/lib/ai-service"
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-limits"

const SUPPORTED_EXTENSIONS = [".docx", ".txt"]

// Parsing the document and handing chunks to OpenAI can take up to a minute, which
// exceeds the platform's short default function timeout.
export const maxDuration = 60
// mammoth and docx rely on Node APIs such as Buffer, so the edge runtime is unusable.
export const runtime = "nodejs"

function getFileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".")
  return lastDot === -1 ? "" : fileName.slice(lastDot).toLowerCase()
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get("file") as File | null
    const pagesStr = formData.get("pages") as string | null
    const pages = Math.min(Math.max(parseInt(pagesStr || "1", 10) || 1, 1), 80)
    const titleName = ((formData.get("titleName") as string | null) || "").trim().slice(0, 150)
    const duration = ((formData.get("duration") as string | null) || "").trim().slice(0, 40)

    if (!file) {
      return NextResponse.json(
        { error: "No file provided." },
        { status: 400 }
      )
    }

    const fileExt = getFileExtension(file.name)
    if (!SUPPORTED_EXTENSIONS.includes(fileExt)) {
      return NextResponse.json(
        { error: "Only .docx and .txt files are supported." },
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

    const transcript = await parseFile(arrayBuffer, file.name)

    if (!transcript.trim()) {
      return NextResponse.json(
        { error: "Could not extract text from the document." },
        { status: 400 }
      )
    }

    let jobs: BackgroundNoteJob[]
    try {
      jobs = await startBackgroundNotes(transcript, pages)
    } catch (aiError: unknown) {
      console.error("AI service error:", aiError)
      const message = aiError instanceof Error ? aiError.message : "Failed to start note generation."
      return NextResponse.json(
        {
          error: message,
        },
        {
          status: message.includes("OpenAI") || message === "fetch failed" ? 503 : 500,
        }
      )
    }

    const sourceName = file.name.replace(/\.(docx|txt)$/i, "").replace(/[^a-z0-9-_ ]/gi, "").trim() || "class"
    const downloadName = `${sourceName} - Organized Notes.docx`

    return NextResponse.json({
      jobs,
      downloadName,
      pageCount: pages,
      totalSections: jobs.length,
      titleName,
      duration,
    })
  } catch (error: unknown) {
    console.error("Upload error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "An unexpected error occurred." },
      { status: 500 }
    )
  }
}
