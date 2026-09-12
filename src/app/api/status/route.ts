import { NextRequest, NextResponse } from "next/server"
import { expandBackgroundNotes, getBackgroundNoteStatus, mergeNoteSections, retryQueuedBackgroundNotes, type BackgroundNoteJob } from "@/lib/ai-service"
import { createNotesDocx } from "@/lib/docx-generator"

type JobStatus = {
  id: string
  status: string
  progress: number // 0-100 for this job
}

// The final poll assembles the .docx, and an expansion pass may start new OpenAI jobs.
export const maxDuration = 60
export const runtime = "nodejs"

const QUEUED_RETRY_MS = 3 * 60 * 1000
const QUEUED_FAILURE_MS = 5 * 60 * 1000

function getJobProgress(status: string, truncated: boolean): number {
  if (status === "completed") return 100
  if (status === "in_progress") return truncated ? 90 : 50
  if (status === "failed" || status === "cancelled" || status === "incomplete") return 0
  return 10 // queued/starting
}

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
            && (candidate.retries === undefined || (Number.isInteger(candidate.retries) && candidate.retries >= 0 && candidate.retries <= 1))
        }).slice(0, 20)
      : []
    const downloadName = typeof body.downloadName === "string"
      ? body.downloadName.replace(/[\r\n"/\\]/g, "").slice(0, 150)
      : "Organized Notes.docx"
    const titleName = typeof body.titleName === "string" ? body.titleName.replace(/[\r\n]/g, "").slice(0, 150) : ""
    const duration = typeof body.duration === "string" ? body.duration.replace(/[\r\n]/g, "").slice(0, 40) : ""
    const returnNotesHtml = body.returnNotesHtml === true

    if (!jobs.length) {
      return NextResponse.json({ error: "No valid generation jobs were provided." }, { status: 400 })
    }

    const statuses = await Promise.all(jobs.map((job) => getBackgroundNoteStatus(job.id)))

    const jobStatuses: JobStatus[] = statuses.map((status, index) => ({
      id: jobs[index].id,
      status: status.status,
      progress: getJobProgress(status.status, status.truncated || false),
    }))

    const failed = statuses.find((job) => ["failed", "cancelled", "incomplete"].includes(job.status))
    if (failed) {
      return NextResponse.json({ error: failed.error || "A note section failed to generate." }, { status: 500 })
    }

    const now = Date.now()
    const queuedAges = statuses.map((status) =>
      status.status === "queued" && typeof status.createdAt === "number"
        ? now - status.createdAt * 1000
        : 0
    )
    const exhaustedJob = jobs.find((job, index) => (job.retries || 0) >= 1 && queuedAges[index] >= QUEUED_FAILURE_MS)
    if (exhaustedJob) {
      return NextResponse.json(
        { error: "OpenAI kept one note section queued after an automatic retry. Please try again when provider demand is lower." },
        { status: 504 }
      )
    }

    const needsRetry = jobs.map((job, index) => (job.retries || 0) < 1 && queuedAges[index] >= QUEUED_RETRY_MS)
    if (needsRetry.some(Boolean)) {
      const updatedJobs = await Promise.all(jobs.map((job, index) =>
        needsRetry[index] ? retryQueuedBackgroundNotes(job) : job
      ))
      return NextResponse.json({
        status: "processing",
        completed: statuses.filter((status) => status.status === "completed").length,
        total: statuses.length,
        jobs: updatedJobs,
        jobStatuses: jobStatuses.map((jobStatus, index) => needsRetry[index]
          ? { id: updatedJobs[index].id, status: "retrying", progress: 10 }
          : jobStatus),
        progressPercent: Math.round(jobStatuses.reduce((sum, item) => sum + item.progress, 0) / jobStatuses.length),
      })
    }

    const completed = statuses.filter((job) => job.status === "completed")
    const totalProgress = jobStatuses.reduce((sum, job) => sum + job.progress, 0)
    const progressPercent = Math.round(totalProgress / jobStatuses.length)

    if (completed.length !== statuses.length) {
      return NextResponse.json({
        status: "processing",
        completed: completed.length,
        total: statuses.length,
        jobs,
        jobStatuses,
        progressPercent,
      })
    }

    const wordCounts = statuses.map((status) => (status.notes || "")
      .replace(/<[^>]+>/g, " ").replace(/&[a-z0-9#]+;/gi, " ").split(/\s+/).filter(Boolean).length)
    // A complete draft that is close to its requested size is preferable to another full
    // model pass. Truncated or substantially short sections still get corrected.
    const needsExpansion = jobs.map((job, index) => !job.expanded && (statuses[index].truncated || wordCounts[index] < job.targetWords * 0.8))
    if (needsExpansion.some(Boolean)) {
      const updatedJobs = await Promise.all(jobs.map((job, index) =>
        needsExpansion[index] ? expandBackgroundNotes(job, wordCounts[index], statuses[index].truncated) : job
      ))
      return NextResponse.json({
        status: "processing",
        completed: needsExpansion.filter((needed) => !needed).length,
        total: jobs.length,
        jobs: updatedJobs,
        jobStatuses: jobStatuses.map((js, idx) => needsExpansion[idx] ? { ...js, status: "expanding", progress: 75 } : js),
        progressPercent: Math.round(jobStatuses.reduce((sum, js, idx) => sum + (needsExpansion[idx] ? 75 : js.progress), 0) / jobStatuses.length),
        correctingLength: true,
      })
    }

    const notes = mergeNoteSections(statuses.map((job) => job.notes || ""))

    if (returnNotesHtml) {
      return NextResponse.json({
        status: "completed",
        notesHtml: notes,
        downloadName,
        progressPercent: 100,
      })
    }

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
