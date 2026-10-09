// Client-side pipeline for turning one transcript into notes: start the background
// jobs, poll until the document is assembled, then download it or write it to Google Docs.

export type GenerationProgress = {
  completed: number
  total: number
  progressPercent?: number
  jobStatuses?: Array<{ id: string; status: string; progress: number }>
  // Set while waiting for the AI's per-minute limit to clear before continuing.
  rateLimitWaitMs?: number
}

export type NoteRequest = {
  file: File
  pages: number
  titleName: string
  duration: string
  gdocsUrl: string
}

export type NoteResult =
  | { kind: "download"; file: Blob; downloadName: string }
  | { kind: "gdocs" }

type GenerationJob = { id: string; targetWords: number; expanded: boolean; pageNumber?: number; pageSpan?: number; expansionAttempts?: number; retries?: number }

export const GOOGLE_DOCS_URL_PATTERN = /^https:\/\/docs\.google\.com\/document\/d\/[a-zA-Z0-9-_]+\/?.*$/

export function authorizeGoogleDocs(docUrl: string): Promise<void> {
  const authUrl = `/api/auth/google?docUrl=${encodeURIComponent(docUrl)}&mode=export&write=true`
  const popup = window.open(authUrl, "google-docs-auth", "popup,width=520,height=680")
  if (!popup) return Promise.reject(new Error("Allow popups to authorize Google Docs, then try again."))

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("message", handleMessage)
      window.clearInterval(closedTimer)
    }
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "gdocs-auth-success") return
      cleanup()
      resolve()
    }
    const closedTimer = window.setInterval(() => {
      if (!popup.closed) return
      cleanup()
      reject(new Error("Google authorization was not completed."))
    }, 1000)
    window.addEventListener("message", handleMessage)
  })
}

// Throws with a user-facing reason when the file cannot be turned into notes.
export async function generateNotes(
  request: NoteRequest,
  googleAuthorization: Promise<void>,
  onProgress: (progress: GenerationProgress) => void
): Promise<NoteResult> {
  const { file, pages, titleName, duration, gdocsUrl } = request
  const useGdocs = gdocsUrl.trim().length > 0
  let progress: GenerationProgress = { completed: 0, total: 1 }
  const report = (next: GenerationProgress) => {
    progress = next
    onProgress(next)
  }
  // A per-minute limit is not a failure: wait for it to clear and send the upload again,
  // passing back the sections already accepted so only the rest are resent.
  let submittedJobIds: Array<string | null> = []
  let job
  while (true) {
    const formData = new FormData()
    formData.append("file", file)
    formData.append("pages", String(pages))
    formData.append("titleName", titleName)
    formData.append("duration", duration)
    if (submittedJobIds.length) formData.append("submittedJobIds", JSON.stringify(submittedJobIds))
    const response = await fetch("/api/upload", { method: "POST", body: formData })
    job = await response.json()
    if (response.status === 429 && job.rateLimited) {
      if (Array.isArray(job.submittedJobIds)) submittedJobIds = job.submittedJobIds
      const waitMs = typeof job.retryAfterMs === "number" ? job.retryAfterMs : 20000
      report({ ...progress, rateLimitWaitMs: waitMs })
      await new Promise((resolve) => window.setTimeout(resolve, waitMs))
      continue
    }
    if (!response.ok) throw new Error(job.error || "Failed to start note generation.")
    break
  }

  let jobs: GenerationJob[] = job.jobs
  const downloadName: string = job.downloadName || "Organized Notes.docx"
  const pageCount: number = job.pageCount || pages
  const resolvedTitleName: string = job.titleName ?? titleName
  const resolvedDuration: string = job.duration ?? duration
  const startedAt = Date.now()
  // Time spent waiting out the AI's per-minute limit does not count toward the time limit.
  let rateLimitWaitedMs = 0
  let consecutivePollFailures = 0
  let pollDelay = 750
  report({ completed: 0, total: jobs.length, progressPercent: 0 })

  while (Date.now() - startedAt - rateLimitWaitedMs < 15 * 60 * 1000) {
    await new Promise((resolve) => window.setTimeout(resolve, pollDelay))
    pollDelay = 2000
    try {
      const statusResponse = await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobs,
          downloadName,
          pageCount,
          titleName: resolvedTitleName,
          duration: resolvedDuration,
          returnNotesHtml: useGdocs,
        }),
        signal: AbortSignal.timeout(30000),
      })
      const contentType = statusResponse.headers.get("Content-Type") || ""

      // Check for binary DOCX response first (in case generation completed)
      if (statusResponse.ok && contentType.includes("application/vnd.openxmlformats")) {
        // Only download direct file if not using Google Docs export
        if (!useGdocs) {
          const outputFile = await statusResponse.blob()
          report({ completed: jobs.length, total: jobs.length, progressPercent: 100 })
          return { kind: "download", file: outputFile, downloadName }
        }
        // If using Google Docs, generation may still be completing;
        // continue polling loop without trying to parse binary as JSON
        continue
      }

      const status = await statusResponse.json()
      if (!statusResponse.ok) throw new Error(status.error || "A note section failed to generate.")

      if (Array.isArray(status.jobs)) jobs = status.jobs
      consecutivePollFailures = 0
      const rateLimitWaitMs = typeof status.retryAfterMs === "number" && status.retryAfterMs > 0 ? status.retryAfterMs : undefined
      report({
        completed: status.completed || 0,
        total: status.total || jobs.length,
        progressPercent: status.progressPercent,
        jobStatuses: status.jobStatuses,
        rateLimitWaitMs,
      })
      if (rateLimitWaitMs) {
        // The AI hit its per-minute limit; poll again once it can take requests.
        pollDelay = rateLimitWaitMs
        rateLimitWaitedMs += rateLimitWaitMs
        continue
      }

      if (useGdocs && status.status === "completed" && typeof status.notesHtml === "string") {
        await googleAuthorization

        const exportResponse = await fetch("/api/export/gdocs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            docUrl: gdocsUrl,
            notesHtml: status.notesHtml,
            title: resolvedTitleName || downloadName.replace(" - Organized Notes.docx", ""),
            duration: resolvedDuration,
          }),
        })
        const exportResult = await exportResponse.json()
        if (!exportResponse.ok) throw new Error(exportResult.error || "Failed to write notes to Google Docs.")
        report({ completed: jobs.length, total: jobs.length, progressPercent: 100 })
        return { kind: "gdocs" }
      }
    } catch (pollError) {
      consecutivePollFailures += 1
      if (consecutivePollFailures >= 3) throw pollError
    }
  }

  throw new Error("Generation took longer than 15 minutes. Please try again with fewer pages or a shorter transcript.")
}
