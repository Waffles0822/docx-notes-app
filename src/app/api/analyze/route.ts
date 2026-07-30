import { NextRequest, NextResponse } from "next/server"
import { parseDocx } from "@/lib/docx-parser"
import { estimateTranscript } from "@/lib/ai-service"
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-limits"

export const maxDuration = 30
// mammoth needs Node's Buffer, so this route cannot run on the edge runtime.
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get("file") as File | null

    if (!file) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 })
    }

    if (!file.name.toLowerCase().endsWith(".docx")) {
      return NextResponse.json({ error: "Only .docx files are supported." }, { status: 400 })
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: `The file is larger than the ${MAX_UPLOAD_LABEL} limit.` }, { status: 400 })
    }

    const transcript = await parseDocx(await file.arrayBuffer())

    if (!transcript.trim()) {
      return NextResponse.json({ error: "Could not extract text from the document." }, { status: 400 })
    }

    return NextResponse.json(estimateTranscript(transcript))
  } catch (error) {
    console.error("Analyze error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not analyze the document." },
      { status: 500 }
    )
  }
}
