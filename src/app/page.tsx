"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, BookOpen, BrainCircuit, CheckCircle2, Circle, Loader2, RotateCcw, Sparkles, XCircle } from "lucide-react"
import FileUpload, { type FileEntry } from "@/components/FileUpload"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import LoginGate from "@/components/LoginGate"
import { authorizeGoogleDocs, generateNotes, type GenerationProgress } from "@/lib/note-generation"

type AppState = "upload" | "processing"

// skipped: failed on the first pass and waiting for its retry; failed: the retry failed too.
type QueueStatus = "waiting" | "processing" | "completed" | "skipped" | "retrying" | "failed"

type QueueItem = {
  id: string
  name: string
  destination: "download" | "gdocs"
  status: QueueStatus
  retried: boolean
  firstError?: string
  error?: string
}

const benefits = [
  { icon: BrainCircuit, title: "Finds the signal", copy: "Pulls out concepts, definitions, examples, and exam cues." },
  { icon: BookOpen, title: "Built for studying", copy: "Turns a raw transcript into a clear, skimmable study guide." },
  { icon: CheckCircle2, title: "Stays grounded", copy: "Uses only information found in your uploaded document." },
]

const queueStatusLabels: Record<QueueStatus, string> = {
  waiting: "Waiting",
  processing: "Processing",
  completed: "Done",
  skipped: "Skipped · will retry",
  retrying: "Retrying",
  failed: "Not processed",
}

function downloadFile(file: Blob, downloadName: string) {
  const url = URL.createObjectURL(file)
  const link = document.createElement("a")
  link.href = url
  link.download = downloadName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function QueueStatusIcon({ status }: { status: QueueStatus }) {
  if (status === "completed") return <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
  if (status === "processing" || status === "retrying") return <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
  if (status === "skipped") return <RotateCcw className="size-4 shrink-0 text-amber-600" />
  if (status === "failed") return <XCircle className="size-4 shrink-0 text-destructive" />
  return <Circle className="size-4 shrink-0 text-muted-foreground/50" />
}

export default function Home() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [state, setState] = useState<AppState>("upload")
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [batchFinished, setBatchFinished] = useState(false)
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress>({ completed: 0, total: 1 })

  useEffect(() => {
    fetch("/api/auth/session").then((response) => response.json()).then((data) => setAuthenticated(data.authenticated === true)).catch(() => setAuthenticated(false))
  }, [])

  if (authenticated === null) return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>
  if (!authenticated) return <LoginGate onAuthenticated={() => setAuthenticated(true)} />

  // Files run strictly one after another. A file that fails is skipped so the rest can
  // finish, then gets one more attempt after everything else; a second failure is reported.
  const runBatch = async (entries: FileEntry[]): Promise<string[]> => {
    // Opened before any await so the popup still counts as a response to the click.
    // One authorization covers every Google Doc in the batch.
    const gdocsEntry = entries.find((entry) => entry.gdocsUrl)
    const googleAuthorization = gdocsEntry ? authorizeGoogleDocs(gdocsEntry.gdocsUrl) : Promise.resolve()
    googleAuthorization.catch(() => { /* surfaced when a Google Docs file reaches its export */ })

    let current: QueueItem[] = entries.map((entry) => ({
      id: entry.id,
      name: entry.file.name,
      destination: entry.gdocsUrl ? "gdocs" : "download",
      status: "waiting",
      retried: false,
    }))
    const updateQueue = (id: string, patch: Partial<QueueItem>) => {
      current = current.map((item) => item.id === id ? { ...item, ...patch } : item)
      setQueue(current)
    }
    setQueue(current)
    setBatchFinished(false)
    setState("processing")

    const attempt = async (entry: FileEntry, isRetry: boolean): Promise<boolean> => {
      updateQueue(entry.id, { status: isRetry ? "retrying" : "processing", retried: isRetry })
      setGenerationProgress({ completed: 0, total: 1 })
      try {
        const result = await generateNotes(entry, googleAuthorization, setGenerationProgress)
        if (result.kind === "download") downloadFile(result.file, result.downloadName)
        updateQueue(entry.id, { status: "completed" })
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : "An unexpected error occurred."
        updateQueue(entry.id, isRetry ? { status: "failed", error: message } : { status: "skipped", firstError: message, error: message })
        return false
      }
    }

    const skipped: FileEntry[] = []
    for (const entry of entries) {
      if (!(await attempt(entry, false))) skipped.push(entry)
    }
    for (const entry of skipped) {
      await attempt(entry, true)
    }

    setBatchFinished(true)
    setState("upload")
    return current.filter((item) => item.status === "completed").map((item) => item.id)
  }

  const completedItems = queue.filter((item) => item.status === "completed")
  const failedItems = queue.filter((item) => item.status === "failed")
  const activeItem = queue.find((item) => item.status === "processing" || item.status === "retrying")
  const retryTotal = queue.filter((item) => item.firstError).length
  const retryIndex = queue.filter((item) => item.retried && item.status !== "retrying").length + 1

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--color-primary-soft),_transparent_38%)]">
      <header className="border-b bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Sparkles className="size-4" />
            </div>
            <div>
              <p className="font-semibold leading-none tracking-tight">DocuNotes</p>
              <p className="mt-1 text-xs text-muted-foreground">Transcript to study guide</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground sm:flex">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            DOCX, TXT · Google Docs export
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[0.85fr_1.15fr] lg:items-start lg:py-16">
        <section className="pt-2 lg:sticky lg:top-24">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-xs font-medium text-primary shadow-sm">
            <Sparkles className="size-3.5" />
            AI-powered note making
          </div>
          <h1 className="max-w-xl text-4xl font-bold tracking-tight text-balance sm:text-5xl">
            Turn long lectures into notes you can actually study.
          </h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-muted-foreground sm:text-lg">
            Upload your class transcripts, choose the depth you want, and get structured notes without the filler.
          </p>

          <div className="mt-8 grid gap-3">
            {benefits.map(({ icon: Icon, title, copy }) => (
              <div key={title} className="flex gap-3 rounded-xl border border-transparent p-3 transition-colors hover:border-border hover:bg-background/60">
                <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-4" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{title}</p>
                  <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{copy}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="min-w-0">
          {state === "upload" && batchFinished && completedItems.length > 0 && (
            <Alert className="mb-4 border-emerald-500/30 bg-emerald-500/5 text-emerald-800">
              <CheckCircle2 className="size-4 text-emerald-600" />
              <AlertDescription>
                <p className="font-medium">{completedItems.length} of {queue.length} {queue.length === 1 ? "file was" : "files were"} processed.</p>
                <ul className="mt-1 space-y-0.5">
                  {completedItems.map((item) => (
                    <li key={item.id}>
                      {item.name}: {item.destination === "gdocs" ? "written to your Google Doc" : "download started"}
                      {item.retried && " (succeeded on the retry)"}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {state === "upload" && batchFinished && failedItems.length > 0 && (
            <Alert variant="destructive" className="mb-4">
              <AlertTriangle className="size-4" />
              <AlertDescription>
                <p className="font-medium">
                  {failedItems.length} {failedItems.length === 1 ? "file was" : "files were"} skipped and not processed, even after a retry:
                </p>
                <ul className="mt-1 space-y-1">
                  {failedItems.map((item) => (
                    <li key={item.id}>
                      <span className="font-medium">{item.name}</span>: {item.error}
                      {item.firstError && item.firstError !== item.error && ` (first attempt: ${item.firstError})`}
                    </li>
                  ))}
                </ul>
                <p className="mt-2">These files are still listed below so you can try them again.</p>
              </AlertDescription>
            </Alert>
          )}

          {/* Kept mounted while processing so files that fail stay listed for another try. */}
          <div className={state === "processing" ? "hidden" : undefined}>
            <FileUpload onSubmit={runBatch} />
          </div>

          {state === "processing" && (
            <Card className="overflow-hidden border-border/70 shadow-xl shadow-primary/5">
              <div className="h-1 bg-primary" />
              <CardContent className="flex min-h-[420px] flex-col items-center justify-center px-8 py-16 text-center">
                <div className="relative mb-6 flex size-20 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Loader2 className="size-9 animate-spin" />
                  <span className="absolute -right-1 -top-1 size-3 animate-pulse rounded-full bg-primary" />
                </div>
                <h2 className="text-xl font-semibold tracking-tight">
                  {queue.length > 1 ? "Building your study guides" : "Building your study guide"}
                </h2>
                {activeItem && (
                  <p className="mt-2 max-w-sm truncate text-sm font-medium">
                    {activeItem.status === "retrying"
                      ? `Retrying skipped file ${retryIndex} of ${retryTotal}: ${activeItem.name}`
                      : `File ${queue.findIndex((item) => item.id === activeItem.id) + 1} of ${queue.length}: ${activeItem.name}`}
                  </p>
                )}
                <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
                  {generationProgress.jobStatuses && generationProgress.jobStatuses.length > 0
                    ? `Processing ${generationProgress.jobStatuses.filter(j => j.status === "completed").length} of ${generationProgress.jobStatuses.length} sections`
                    : `Generating topic section ${Math.min(generationProgress.completed + 1, generationProgress.total)} of ${generationProgress.total}.`}
                </p>
                {generationProgress.rateLimitWaitMs && (
                  <p className="mt-3 max-w-sm rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-800">
                    The AI reached its per-minute limit. Waiting about {Math.ceil(generationProgress.rateLimitWaitMs / 1000)} seconds, then continuing automatically.
                  </p>
                )}
                <div className="mt-8 w-full max-w-xs space-y-2">
                  <Progress value={generationProgress.progressPercent ?? (generationProgress.completed / generationProgress.total) * 100} />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{generationProgress.jobStatuses && generationProgress.jobStatuses.length > 0
                      ? `${generationProgress.jobStatuses.filter(j => j.status === "completed").length} of ${generationProgress.jobStatuses.length} sections complete`
                      : `${generationProgress.completed} of ${generationProgress.total} sections complete`}
                    </span>
                    <span>{generationProgress.progressPercent ?? Math.round((generationProgress.completed / generationProgress.total) * 100)}%</span>
                  </div>
                  {generationProgress.jobStatuses && generationProgress.jobStatuses.length > 0 && (
                    <div className="mt-2 text-[10px] text-muted-foreground font-mono">
                      {generationProgress.jobStatuses.map((job, idx) => (
                        <div key={job.id} className="flex justify-between gap-2">
                          <span>Section {idx + 1}</span>
                          <span className="text-primary">
                            {job.status === "retrying" ? "Retrying" : job.status === "rate_limited" ? "Waiting for AI" : job.status === "queued" ? "Queued" : `${job.progress}%`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {queue.length > 1 && (
                  <ol className="mt-8 w-full max-w-sm space-y-1.5 text-left text-sm">
                    {queue.map((item, index) => (
                      <li key={item.id} className="flex items-center gap-2.5 rounded-lg border bg-muted/20 px-3 py-2">
                        <QueueStatusIcon status={item.status} />
                        <span className="min-w-0 flex-1 truncate">{index + 1}. {item.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{queueStatusLabels[item.status]}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </CardContent>
            </Card>
          )}
        </section>
      </main>
    </div>
  )
}
