"use client"

import { useState } from "react"
import { AlertTriangle, BookOpen, BrainCircuit, CheckCircle2, Loader2, Sparkles } from "lucide-react"
import FileUpload from "@/components/FileUpload"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"

type AppState = "upload" | "processing" | "error" | "result"

type GenerationProgress = {
  completed: number
  total: number
  progressPercent?: number
  jobStatuses?: Array<{ id: string; status: string; progress: number }>
}

const benefits = [
  { icon: BrainCircuit, title: "Finds the signal", copy: "Pulls out concepts, definitions, examples, and exam cues." },
  { icon: BookOpen, title: "Built for studying", copy: "Turns a raw transcript into a clear, skimmable study guide." },
  { icon: CheckCircle2, title: "Stays grounded", copy: "Uses only information found in your uploaded document." },
]

export default function Home() {
  const [state, setState] = useState<AppState>("upload")
  const [errorMessage, setErrorMessage] = useState("")
  const [downloadedName, setDownloadedName] = useState("")
  const [googleDocsComplete, setGoogleDocsComplete] = useState(false)
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress>({ completed: 0, total: 1 })

  const handleDownload = ({ file, downloadName }: { file: Blob; downloadName: string }) => {
    const url = URL.createObjectURL(file)
    const link = document.createElement("a")
    link.href = url
    link.download = downloadName
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setDownloadedName(downloadName)
    setState("result")
    setErrorMessage("")
  }

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
            Upload a class transcript, choose the depth you want, and get structured notes without the filler.
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
          {(state === "upload" || state === "result") && downloadedName && (
            <Alert className="mb-4 border-emerald-500/30 bg-emerald-500/5 text-emerald-800">
              <CheckCircle2 className="size-4 text-emerald-600" />
              <AlertDescription>Your download for {downloadedName} has started.</AlertDescription>
            </Alert>
          )}

          {(state === "upload" || state === "result") && googleDocsComplete && (
            <Alert className="mb-4 border-emerald-500/30 bg-emerald-500/5 text-emerald-800">
              <CheckCircle2 className="size-4 text-emerald-600" />
              <AlertDescription>The generated notes were written to your Google Doc.</AlertDescription>
            </Alert>
          )}

          {(state === "upload" || state === "result") && (
            <FileUpload
              onProcessingStart={() => { setDownloadedName(""); setGoogleDocsComplete(false); setErrorMessage(""); setGenerationProgress({ completed: 0, total: 1 }); setState("processing") }}
              onProgress={setGenerationProgress}
              onProcessingComplete={handleDownload}
              onGoogleDocsComplete={() => { setGoogleDocsComplete(true); setErrorMessage(""); setState("result") }}
              onError={(error) => { setErrorMessage(error); setState("error") }}
            />
          )}

          {state === "processing" && (
            <Card className="overflow-hidden border-border/70 shadow-xl shadow-primary/5">
              <div className="h-1 bg-primary" />
              <CardContent className="flex min-h-[420px] flex-col items-center justify-center px-8 py-16 text-center">
                <div className="relative mb-6 flex size-20 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Loader2 className="size-9 animate-spin" />
                  <span className="absolute -right-1 -top-1 size-3 animate-pulse rounded-full bg-primary" />
                </div>
                <h2 className="text-xl font-semibold tracking-tight">Building your study guide</h2>
                <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                  {generationProgress.jobStatuses && generationProgress.jobStatuses.length > 0
                    ? `Processing ${generationProgress.jobStatuses.filter(j => j.status === "completed").length} of ${generationProgress.jobStatuses.length} sections`
                    : `Generating topic section ${Math.min(generationProgress.completed + 1, generationProgress.total)} of ${generationProgress.total}.`}
                </p>
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
                          <span className="text-primary">{job.progress}%</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {state === "error" && (
            <div className="space-y-4">
              <Alert variant="destructive"><AlertTriangle className="size-4" /><AlertDescription>{errorMessage}</AlertDescription></Alert>
              <FileUpload
                onProcessingStart={() => { setErrorMessage(""); setState("processing") }}
                onProgress={setGenerationProgress}
                onProcessingComplete={handleDownload}
                onGoogleDocsComplete={() => { setGoogleDocsComplete(true); setErrorMessage(""); setState("result") }}
                onError={(error) => setErrorMessage(error)}
              />
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
