import { NextRequest, NextResponse } from "next/server"
import { expandBackgroundNotes, getBackgroundNoteStatus, getExpansionAttempts, getRateLimitRetryMs, groupTopicHeadings, MAX_EXPANSION_ATTEMPTS, mergeNoteSections, resubmitRateLimitedNotes, retryQueuedBackgroundNotes, type BackgroundNoteJob } from "@/lib/ai-service"
import { applyTopicGroups, createNotesDocx, parseNotes, type Bullet } from "@/lib/docx-generator"

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
const PAGINATED_WORD_TARGET_RATIO = 0.98

function countExportedWords(html: string): number {
  const { announcements, lecture } = parseNotes(mergeNoteSections([html]))
  const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length
  const countBullets = (bullets: Bullet[]): number => bullets.reduce(
    (sum, bullet) => sum + countWords(bullet.text) + countBullets(bullet.children), 0
  )
  return [...announcements, ...lecture].reduce(
    (sum, section) => sum + countWords(section.heading) + countBullets(section.bullets), 0
  )
}

function getJobProgress(status: string, truncated: boolean): number {
  if (status === "completed") return 100
  if (status === "in_progress") return truncated ? 90 : 50
  if (status === "failed" || status === "cancelled" || status === "incomplete") return 0
  return 10 // queued/starting
}

// Keeps the old job wherever the AI's per-minute limit turned its replacement away, so the
// next poll tries again; retryAfterMs tells the client how long to wait before that poll.
function settleJobUpdates(jobs: BackgroundNoteJob[], results: PromiseSettledResult<BackgroundNoteJob>[]) {
  let retryAfterMs: number | undefined
  const rateLimited = results.map((result) => result.status === "rejected" && getRateLimitRetryMs(result.reason) !== null)
  const updatedJobs = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value
    const waitMs = getRateLimitRetryMs(result.reason)
    if (waitMs === null) throw result.reason
    retryAfterMs = Math.max(retryAfterMs ?? 0, waitMs)
    return jobs[index]
  })
  return { jobs: updatedJobs, rateLimited, retryAfterMs }
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
            && (candidate.pageNumber === undefined || (Number.isInteger(candidate.pageNumber) && candidate.pageNumber >= 1 && candidate.pageNumber <= 80))
            && (candidate.pageSpan === undefined || (Number.isInteger(candidate.pageSpan) && candidate.pageSpan >= 1 && candidate.pageSpan <= 2))
            && (candidate.expansionAttempts === undefined || (Number.isInteger(candidate.expansionAttempts) && candidate.expansionAttempts >= 0 && candidate.expansionAttempts <= MAX_EXPANSION_ATTEMPTS))
            && (candidate.retries === undefined || (Number.isInteger(candidate.retries) && candidate.retries >= 0 && candidate.retries <= 1))
        }).slice(0, 80)
      : []
    const downloadName = typeof body.downloadName === "string"
      ? body.downloadName.replace(/[\r\n"/\\]/g, "").slice(0, 150)
      : "Organized Notes.docx"
    const titleName = typeof body.titleName === "string" ? body.titleName.replace(/[\r\n]/g, "").slice(0, 150) : ""
    const duration = typeof body.duration === "string" ? body.duration.replace(/[\r\n]/g, "").slice(0, 40) : ""
    const returnNotesHtml = body.returnNotesHtml === true

    if (!jobs.length || jobs.length !== body.jobs.length) {
      return NextResponse.json({ error: "No valid generation jobs were provided." }, { status: 400 })
    }

    const paginated = jobs.some((job) => job.pageNumber !== undefined)
    const requestedPages = jobs.reduce((sum, job) => sum + (job.pageSpan ?? 1), 0)
    if (paginated && (jobs.some((job, index) => job.pageNumber !== index + 1)
      || (body.pageCount !== undefined && body.pageCount !== requestedPages))) {
      return NextResponse.json({ error: "The generation plan is missing a requested page. Please start generation again." }, { status: 400 })
    }

    const statuses = await Promise.all(jobs.map((job) => getBackgroundNoteStatus(job.id)))

    const jobStatuses: JobStatus[] = statuses.map((status, index) => ({
      id: jobs[index].id,
      status: status.status,
      progress: getJobProgress(status.status, status.truncated || false),
    }))

    const failed = statuses.find((job) => ["failed", "cancelled", "incomplete"].includes(job.status) && !job.rateLimitMs)
    if (failed) {
      return NextResponse.json({ error: failed.error || "A note section failed to generate." }, { status: 500 })
    }

    // The AI dropped these jobs under its per-minute limit, so send them again instead of failing the file.
    const droppedByRateLimit = statuses.map((status) => status.status === "failed" && Boolean(status.rateLimitMs))
    if (droppedByRateLimit.some(Boolean)) {
      const settled = settleJobUpdates(jobs, await Promise.allSettled(jobs.map((job, index) =>
        droppedByRateLimit[index] ? resubmitRateLimitedNotes(job) : Promise.resolve(job)
      )))
      return NextResponse.json({
        status: "processing",
        completed: statuses.filter((status) => status.status === "completed").length,
        total: statuses.length,
        jobs: settled.jobs,
        jobStatuses: jobStatuses.map((jobStatus, index) => droppedByRateLimit[index]
          ? { id: settled.jobs[index].id, status: settled.rateLimited[index] ? "rate_limited" : "retrying", progress: 10 }
          : jobStatus),
        progressPercent: Math.round(jobStatuses.reduce((sum, item, index) => sum + (droppedByRateLimit[index] ? 10 : item.progress), 0) / jobStatuses.length),
        retryAfterMs: settled.retryAfterMs,
      })
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
      const settled = settleJobUpdates(jobs, await Promise.allSettled(jobs.map((job, index) =>
        needsRetry[index] ? retryQueuedBackgroundNotes(job) : Promise.resolve(job)
      )))
      const updatedJobs = settled.jobs
      return NextResponse.json({
        status: "processing",
        completed: statuses.filter((status) => status.status === "completed").length,
        total: statuses.length,
        jobs: updatedJobs,
        jobStatuses: jobStatuses.map((jobStatus, index) => needsRetry[index]
          ? { id: updatedJobs[index].id, status: settled.rateLimited[index] ? "rate_limited" : "retrying", progress: 10 }
          : jobStatus),
        progressPercent: Math.round(jobStatuses.reduce((sum, item) => sum + item.progress, 0) / jobStatuses.length),
        retryAfterMs: settled.retryAfterMs,
      })
    }

    const completed = statuses.filter((job) => job.status === "completed")
    const totalProgress = jobStatuses.reduce((sum, job) => sum + job.progress, 0)
    const progressPercent = Math.round(totalProgress / jobStatuses.length)

    if (completed.length !== statuses.length) {
      // Status checks the AI turned away under its per-minute limit; their jobs keep running.
      const statusCheckWaitMs = Math.max(0, ...statuses.map((status) => status.rateLimitMs || 0))
      return NextResponse.json({
        status: "processing",
        completed: completed.length,
        total: statuses.length,
        jobs,
        jobStatuses,
        progressPercent,
        retryAfterMs: statusCheckWaitMs || undefined,
      })
    }

    // Validate the content that survives export, on every pass including replacements.
    const wordCounts = statuses.map((status) => countExportedWords(status.notes || ""))
    const targetRatio = paginated ? PAGINATED_WORD_TARGET_RATIO : 0.8
    const needsExpansion = jobs.map((job, index) => Boolean(statuses[index].truncated)
      || wordCounts[index] < Math.ceil(job.targetWords * targetRatio))
    const exhaustedIndex = jobs.findIndex((job, index) => needsExpansion[index] && getExpansionAttempts(job) >= MAX_EXPANSION_ATTEMPTS)
    if (exhaustedIndex !== -1 && statuses[exhaustedIndex].truncated) {
      return NextResponse.json({ error: "A note section is still cut off after two automatic corrections. Please try generating again." }, { status: 422 })
    }
    if (needsExpansion.some((needed, index) => needed && getExpansionAttempts(jobs[index]) < MAX_EXPANSION_ATTEMPTS)) {
      const settled = settleJobUpdates(jobs, await Promise.allSettled(jobs.map((job, index) =>
        needsExpansion[index] && getExpansionAttempts(job) < MAX_EXPANSION_ATTEMPTS
          ? expandBackgroundNotes(job, wordCounts[index], statuses[index].truncated, statuses[index].sourceInput)
          : Promise.resolve(job)
      )))
      const updatedJobs = settled.jobs
      return NextResponse.json({
        status: "processing",
        completed: needsExpansion.filter((needed) => !needed).length,
        total: jobs.length,
        jobs: updatedJobs,
        jobStatuses: jobStatuses.map((js, idx) => needsExpansion[idx] ? { ...js, id: updatedJobs[idx].id, status: settled.rateLimited[idx] ? "rate_limited" : "expanding", progress: 75 } : js),
        progressPercent: Math.round(jobStatuses.reduce((sum, js, idx) => sum + (needsExpansion[idx] ? 75 : js.progress), 0) / jobStatuses.length),
        correctingLength: true,
        retryAfterMs: settled.retryAfterMs,
      })
    }

    const combined = paginated
      ? statuses.map((job, index) => `<article class="notes-page" data-page-span="${jobs[index].pageSpan ?? 1}">${mergeNoteSections([job.notes || ""])}</article>`).join("")
      : mergeNoteSections(statuses.map((job) => job.notes || ""))
    // Allocations name topics independently, so fold related sub-headers into one heading.
    const grouping = await groupTopicHeadings(parseNotes(combined).lecture.map((section) => ({
      heading: section.heading,
      labels: section.bullets.map((bullet) => bullet.text),
    })))
    // Grouping only tidies headings, but a per-minute limit clears soon, so wait it out
    // and assemble on a later poll rather than exporting ungrouped notes.
    if (grouping.retryAfterMs) {
      return NextResponse.json({
        status: "processing",
        completed: jobs.length,
        total: jobs.length,
        jobs,
        jobStatuses,
        progressPercent: 99,
        retryAfterMs: grouping.retryAfterMs,
      })
    }
    const notes = applyTopicGroups(combined, grouping.groups)

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
