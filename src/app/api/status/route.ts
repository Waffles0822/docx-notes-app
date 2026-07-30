import { NextRequest, NextResponse } from "next/server"
import { expandBackgroundNotes, getBackgroundNoteStatus, mergeNoteSections, type BackgroundNoteJob } from "@/lib/ai-service"
import { createNotesDocx } from "@/lib/docx-generator"

// The final poll assembles the .docx, and an expansion pass may start new OpenAI jobs.
export const maxDuration = 60
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const jobs: BackgroundNoteJob[] = Array.isArray(body.jobs)
      ? body.jobs.filter((job: unknown): job is BackgroundNoteJob => {
          if (!job || typeof job !== "object") return false
          const candidate = job as Partial<BackgroundNoteJob>
          return typeof candidate.id === "string" && /^resp_[a-zA-Z0-9_-]+$/.test(candidate.id)
            && typeof candidate.targetWords === "number" && candidate.targetWords >= 100 && candidate.targetWords <= 10000
            && typeof candidate.expanded === "boolean"
        }).slice(0, 10)
      : []
    const downloadName = typeof body.downloadName === "string"
      ? body.downloadName.replace(/[\r\n"/\\]/g, "").slice(0, 150)
      : "Organized Notes.docx"
    const titleName = typeof body.titleName === "string" ? body.titleName.replace(/[\r\n]/g, "").slice(0, 150) : ""
    const duration = typeof body.duration === "string" ? body.duration.replace(/[\r\n]/g, "").slice(0, 40) : ""

    if (!jobs.length) {
      return NextResponse.json({ error: "No valid generation jobs were provided." }, { status: 400 })
    }

    const statuses = await Promise.all(jobs.map((job) => getBackgroundNoteStatus(job.id)))
    const failed = statuses.find((job) => ["failed", "cancelled", "incomplete"].includes(job.status))
    if (failed) {
      return NextResponse.json({ error: failed.error || "A note section failed to generate." }, { status: 500 })
    }

    const completed = statuses.filter((job) => job.status === "completed")
    if (completed.length !== statuses.length) {
      return NextResponse.json({
        status: "processing",
        completed: completed.length,
        total: statuses.length,
        jobs,
      })
    }

    const wordCounts = statuses.map((status) => (status.notes || "")
      .replace(/<[^>]+>/g, " ").replace(/&[a-z0-9#]+;/gi, " ").split(/\s+/).filter(Boolean).length)
    const needsExpansion = jobs.map((job, index) => !job.expanded && (statuses[index].truncated || wordCounts[index] < job.targetWords * 0.9))
    if (needsExpansion.some(Boolean)) {
      const updatedJobs = await Promise.all(jobs.map((job, index) =>
        needsExpansion[index] ? expandBackgroundNotes(job, wordCounts[index], statuses[index].truncated) : job
      ))
      return NextResponse.json({
        status: "processing",
        completed: needsExpansion.filter((needed) => !needed).length,
        total: jobs.length,
        jobs: updatedJobs,
        correctingLength: true,
      })
    }

    const notes = mergeNoteSections(statuses.map((job) => job.notes || ""))
    const docxBuffer = await createNotesDocx(notes, { titleName, duration })
    return new NextResponse(new Uint8Array(docxBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
        "X-Download-Name": encodeURIComponent(downloadName),
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    console.error("Status error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not check generation progress." },
      { status: 500 }
    )
  }
}
