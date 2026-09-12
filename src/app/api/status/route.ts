import { NextRequest, NextResponse } from "next/server"
import { expandBackgroundNotes, getBackgroundNoteStatus, mergeNoteSections, retryQueuedBackgroundNotes, type BackgroundNoteJob } from "@/lib/ai-service"
import { createNotesDocx } from "@/lib/docx-generator"
import { normalizeDurationMinutes } from "@/lib/transcript-metadata"

type JobStatus = {
  id: string
  status: string
  progress: number // 0-100 for this job
}

// The final poll assembles the .docx, and an expansion pass may start new provider jobs.
export const maxDuration = 60
export const runtime = "nodejs"

const QUEUED_RETRY_MS = 3 * 60 * 1000
const QUEUED_FAILURE_MS = 5 * 60 * 1000
const MAX_EXPANSION_ATTEMPTS = 3
// A single correction pass was not enough when a long requested document came back
// far below its target. Recheck the actual returned word count and allow up to three
// focused revisions, one section at a time, without parallel duplicate spending.
const MAX_OPENAI_EXPANSION_ATTEMPTS = 3
const MIN_TARGET_COMPLETION_RATIO = 0.88
const MIN_SECTION_COVERAGE_RATIO = 0.85

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
          const context = candidate.context
          const validTimelineContext = context === undefined || (
            (context.documentTimestampCount === undefined || (Number.isInteger(context.documentTimestampCount) && context.documentTimestampCount >= 0))
            && (context.documentDurationSeconds === undefined || (Number.isInteger(context.documentDurationSeconds) && context.documentDurationSeconds >= 0))
            && (context.documentDurationMinutes === undefined || (Number.isInteger(context.documentDurationMinutes) && context.documentDurationMinutes >= 0))
            && (context.documentDuration === undefined || (typeof context.documentDuration === "string" && context.documentDuration.length <= 20))
            && (context.focusTimestampCount === undefined || (Number.isInteger(context.focusTimestampCount) && context.focusTimestampCount >= 0))
            && (context.focusStartTimestamp === undefined || context.focusStartTimestamp === null || (typeof context.focusStartTimestamp === "string" && context.focusStartTimestamp.length <= 20))
            && (context.focusEndTimestamp === undefined || context.focusEndTimestamp === null || (typeof context.focusEndTimestamp === "string" && context.focusEndTimestamp.length <= 20))
          )
          const validContext = context === undefined || (
            Number.isInteger(context.part) && context.part >= 1 && context.part <= 80
            && Number.isInteger(context.total) && context.total >= context.part && context.total <= 80
            && (context.strategy === "full-document" || context.strategy === "document-memory")
            && Number.isInteger(context.documentChars) && context.documentChars > 0
            && Number.isInteger(context.focusChars) && context.focusChars > 0
            && Number.isInteger(context.globalContextChars) && context.globalContextChars >= 0
            && Number.isInteger(context.retrievedContextChars) && context.retrievedContextChars >= 0
            && Number.isInteger(context.promptChars) && context.promptChars > 0
            && Number.isInteger(context.estimatedInputTokens) && context.estimatedInputTokens > 0
            && typeof context.fullDocumentIncluded === "boolean"
            && validTimelineContext
          )
          const validJobId = typeof candidate.id === "string" && (
            /^resp_[a-zA-Z0-9_-]+$/.test(candidate.id)
            || /^gemini:[a-zA-Z0-9_-]+$/.test(candidate.id)
          )
          return validJobId
            && typeof candidate.targetWords === "number" && candidate.targetWords >= 10 && candidate.targetWords <= 40000
            && typeof candidate.expanded === "boolean"
            && (candidate.expansionAttempts === undefined || (Number.isInteger(candidate.expansionAttempts) && candidate.expansionAttempts >= 0 && candidate.expansionAttempts <= MAX_EXPANSION_ATTEMPTS))
            && (candidate.retries === undefined || (Number.isInteger(candidate.retries) && candidate.retries >= 0 && candidate.retries <= 1))
            && (candidate.promptCacheKey === undefined || (typeof candidate.promptCacheKey === "string" && /^doc_[a-f0-9]{40}$/.test(candidate.promptCacheKey)))
            && validContext
        }).slice(0, 80)
      : []
    const downloadName = typeof body.downloadName === "string"
      ? body.downloadName.replace(/[\r\n"/\\]/g, "").slice(0, 150)
      : "Organized Notes.docx"
    const titleName = typeof body.titleName === "string" ? body.titleName.replace(/[\r\n]/g, "").slice(0, 150) : ""
    const duration = typeof body.duration === "string"
      ? normalizeDurationMinutes(body.duration.replace(/[\r\n]/g, "").slice(0, 40))
      : ""
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
        { error: "The AI provider kept one note section queued after an automatic retry. Please try again when provider demand is lower." },
        { status: 504 }
      )
    }

    // Do not duplicate a paid OpenAI job merely because it remains queued. Gemini's
    // replacement path is retained, while OpenAI continues through normal polling.
    const needsRetry = jobs.map((job, index) => job.id.startsWith("gemini:")
      && (job.retries || 0) < 1
      && queuedAges[index] >= QUEUED_RETRY_MS)
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
    const totalWords = wordCounts.reduce((sum, words) => sum + words, 0)
    const totalTargetWords = jobs.reduce((sum, job) => sum + job.targetWords, 0)
    const totalCompletionRatio = totalWords / Math.max(1, totalTargetWords)
    const openAIUsage = statuses.map((status, index) => status.usage && ({
      part: `${index + 1}/${jobs.length}`,
      ...status.usage,
      cacheHitRatio: Number((status.usage.cachedInputTokens / Math.max(1, status.usage.inputTokens)).toFixed(3)),
    })).filter(Boolean)
    console.info("AI output length validation", {
      totalWords,
      totalTargetWords,
      totalCompletionRatio: Number(totalCompletionRatio.toFixed(3)),
      sections: jobs.map((job, index) => ({
        part: `${index + 1}/${jobs.length}`,
        words: wordCounts[index],
        targetWords: job.targetWords,
        completionRatio: Number((wordCounts[index] / Math.max(1, job.targetWords)).toFixed(3)),
        expansionAttempts: job.expansionAttempts ?? (job.expanded ? 1 : 0),
        truncated: statuses[index].truncated || false,
      })),
    })
    if (openAIUsage.length) console.info("OpenAI prompt cache usage", openAIUsage)

    // Expand only the section with the largest useful deficit on each pass. This avoids
    // paying for several revisions at once when one correction is enough to bring the
    // whole document near its layout target. Both providers may receive up to three
    // sequential revisions per section when measured coverage remains too low.
    const eligibleExpansionIndexes = jobs.map((job, index) => {
      const expansionAttempts = job.expansionAttempts ?? (job.expanded ? 1 : 0)
      const maxAttempts = job.id.startsWith("gemini:") ? MAX_EXPANSION_ATTEMPTS : MAX_OPENAI_EXPANSION_ATTEMPTS
      const sectionRatio = wordCounts[index] / Math.max(1, job.targetWords)
      const needsMoreCoverage = sectionRatio < MIN_SECTION_COVERAGE_RATIO
      return expansionAttempts < maxAttempts
        && (statuses[index].truncated || totalCompletionRatio < MIN_TARGET_COMPLETION_RATIO || needsMoreCoverage)
        ? index
        : -1
    }).filter((index) => index >= 0)
    const expansionIndex = eligibleExpansionIndexes.sort((a, b) => {
      if (Boolean(statuses[a].truncated) !== Boolean(statuses[b].truncated)) return statuses[a].truncated ? -1 : 1
      return (jobs[b].targetWords - wordCounts[b]) - (jobs[a].targetWords - wordCounts[a])
    })[0]
    const needsExpansion = jobs.map((_, index) => index === expansionIndex)
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
        duration,
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
        "X-Document-Duration": encodeURIComponent(duration),
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
