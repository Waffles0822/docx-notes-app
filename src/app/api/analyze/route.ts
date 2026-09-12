import { NextRequest, NextResponse } from "next/server"
import { parseFile } from "@/lib/docx-parser"
import { estimateTranscript } from "@/lib/ai-service"
import { analyzeTranscriptTimeline, countMarkedSourcePages } from "@/lib/transcript-metadata"
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-limits"

const SUPPORTED_EXTENSIONS = [".docx", ".txt"]

export const maxDuration = 60
// mammoth needs Node's Buffer, so this route cannot run on the edge runtime.
export const runtime = "nodejs"

function getFileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".")
  return lastDot === -1 ? "" : fileName.slice(lastDot).toLowerCase()
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get("file") as File | null

    if (!file) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 })
    }

    const fileExt = getFileExtension(file.name)
    if (!SUPPORTED_EXTENSIONS.includes(fileExt)) {
      return NextResponse.json({ error: "Only .docx and .txt files are supported." }, { status: 400 })
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: `The file is larger than the ${MAX_UPLOAD_LABEL} limit.` }, { status: 400 })
    }

    const transcript = await parseFile(await file.arrayBuffer(), file.name)

    if (!transcript.trim()) {
      return NextResponse.json({ error: "Could not extract text from the document." }, { status: 400 })
    }

    const timeline = analyzeTranscriptTimeline(transcript)
    return NextResponse.json({
      ...estimateTranscript(transcript),
      duration: timeline.durationLabel,
      durationSeconds: timeline.durationSeconds,
      durationMinutes: timeline.durationMinutes,
      timestampCount: timeline.timestampCount,
      firstTimestamp: timeline.firstTimestamp,
      lastTimestamp: timeline.lastTimestamp,
      maxTimestamp: timeline.maxTimestamp,
      sourcePageCount: countMarkedSourcePages(transcript) || null,
    })
  } catch (error) {
    console.error("Analyze error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not analyze the document." },
      { status: 500 }
    )
  }
}
