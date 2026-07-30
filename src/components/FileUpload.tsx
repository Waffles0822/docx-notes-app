"use client"

import { useCallback, useRef, useState } from "react"
import { FileText, Loader2, Sparkles, Upload, Wand2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-limits"

interface FileUploadProps {
  onProcessingStart: () => void
  onProgress: (progress: { completed: number; total: number }) => void
  onProcessingComplete: (result: { file: Blob; downloadName: string }) => void
  onError: (error: string) => void
}

export default function FileUpload({ onProcessingStart, onProgress, onProcessingComplete, onError }: FileUploadProps) {
  const [file, setFile] = useState<File | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [pages, setPages] = useState(5)
  const [titleName, setTitleName] = useState("")
  const [duration, setDuration] = useState("")
  const [estimate, setEstimate] = useState<{ words: number; recommendedPages: number } | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const analyzeToken = useRef(0)

  // Reads the transcript's real length so the page target starts at a sensible value
  // instead of an arbitrary default the user has to guess at.
  const analyzeFile = useCallback(async (candidate: File) => {
    const token = ++analyzeToken.current
    setIsAnalyzing(true)
    setEstimate(null)
    try {
      const formData = new FormData()
      formData.append("file", candidate)
      const response = await fetch("/api/analyze", { method: "POST", body: formData })
      const data = await response.json()
      // A newer file was chosen while this request was in flight; its result wins.
      if (token !== analyzeToken.current) return
      if (response.ok && typeof data.recommendedPages === "number") {
        setEstimate(data)
        setPages(data.recommendedPages)
      }
    } catch {
      // A failed estimate is not worth interrupting the user for; the manual page input still works.
    } finally {
      if (token === analyzeToken.current) setIsAnalyzing(false)
    }
  }, [])

  const validateFile = useCallback((candidate?: File) => {
    if (!candidate) return
    if (!candidate.name.toLowerCase().endsWith(".docx")) {
      onError("Please choose a Word document in .docx format.")
      return
    }
    if (candidate.size > MAX_UPLOAD_BYTES) {
      onError(`That file is larger than ${MAX_UPLOAD_LABEL}. Please choose a smaller document.`)
      return
    }
    setFile(candidate)
    if (!titleName.trim()) {
      setTitleName(candidate.name.replace(/\.docx$/i, "").replace(/[_-]+/g, " ").trim())
    }
    void analyzeFile(candidate)
  }, [onError, analyzeFile, titleName])

  const handleDrag = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(event.type === "dragenter" || event.type === "dragover")
  }, [])

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(false)
    validateFile(event.dataTransfer.files[0])
  }, [validateFile])

  const handleUpload = useCallback(async () => {
    if (!file || isProcessing) return
    setIsProcessing(true)
    onProcessingStart()
    try {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("pages", String(pages))
      formData.append("titleName", titleName)
      formData.append("duration", duration)
      const response = await fetch("/api/upload", { method: "POST", body: formData })
      const job = await response.json()
      if (!response.ok) throw new Error(job.error || "Failed to start note generation.")

      let jobs: Array<{ id: string; targetWords: number; expanded: boolean }> = job.jobs
      const downloadName: string = job.downloadName || "Organized Notes.docx"
      const pageCount: number = job.pageCount || pages
      const resolvedTitleName: string = job.titleName ?? titleName
      const resolvedDuration: string = job.duration ?? duration
      const startedAt = Date.now()
      let consecutivePollFailures = 0
      onProgress({ completed: 0, total: jobs.length })

      while (Date.now() - startedAt < 8 * 60 * 1000) {
        await new Promise((resolve) => window.setTimeout(resolve, 3500))
        try {
          const statusResponse = await fetch("/api/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobs, downloadName, pageCount, titleName: resolvedTitleName, duration: resolvedDuration }),
            signal: AbortSignal.timeout(30000),
          })
          const contentType = statusResponse.headers.get("Content-Type") || ""
          if (statusResponse.ok && contentType.includes("application/vnd.openxmlformats")) {
            const outputFile = await statusResponse.blob()
            onProgress({ completed: jobs.length, total: jobs.length })
            onProcessingComplete({ file: outputFile, downloadName })
            return
          }

          const status = await statusResponse.json()
          if (!statusResponse.ok) throw new Error(status.error || "A note section failed to generate.")
          if (Array.isArray(status.jobs)) jobs = status.jobs
          consecutivePollFailures = 0
          onProgress({ completed: status.completed || 0, total: status.total || jobs.length })
        } catch (pollError) {
          consecutivePollFailures += 1
          if (consecutivePollFailures >= 3) throw pollError
        }
      }

      throw new Error("Generation took longer than 8 minutes. Please try again with fewer pages or a shorter transcript.")
    } catch (error) {
      onError(error instanceof Error ? error.message : "An unexpected error occurred.")
    } finally {
      setIsProcessing(false)
    }
  }, [file, isProcessing, onProcessingStart, onProgress, onProcessingComplete, onError, pages, titleName, duration])

  return (
    <Card className="overflow-hidden border-border/70 bg-card/95 shadow-xl shadow-primary/5 backdrop-blur">
      <CardHeader className="border-b bg-muted/25 p-6 sm:p-7">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
          <span className="flex size-5 items-center justify-center rounded-md bg-primary/10">1</span>
          Add your source
        </div>
        <CardTitle className="text-2xl">Create a new study guide</CardTitle>
        <CardDescription className="leading-6">Upload a class transcript and choose how much detail you need.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-7 p-6 sm:p-7">
        <div
          role="button"
          tabIndex={0}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") inputRef.current?.click() }}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "group relative flex min-h-52 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-5 text-center outline-none transition-all focus-visible:ring-4 focus-visible:ring-ring/20",
            isDragging ? "border-primary bg-primary/10" : "border-border bg-muted/20 hover:border-primary/50 hover:bg-primary/[0.035]",
            file && "border-primary/40 bg-primary/[0.035]"
          )}
        >
          <input ref={inputRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="hidden" onChange={(event) => validateFile(event.target.files?.[0])} />
          {file ? (
            <>
              <button
                type="button"
                aria-label="Remove selected file"
                className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation()
                  analyzeToken.current++
                  setFile(null)
                  setEstimate(null)
                  setIsAnalyzing(false)
                  if (inputRef.current) inputRef.current.value = ""
                }}
              ><X className="size-4" /></button>
              <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><FileText className="size-7" /></div>
              <p className="max-w-full truncate px-6 text-sm font-semibold">{file.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {isAnalyzing
                  ? "Measuring transcript length…"
                  : estimate
                    ? `${estimate.words.toLocaleString()} words · Ready to process`
                    : `${(file.size / 1024).toFixed(1)} KB · Ready to process`}
              </p>
              <p className="mt-4 text-xs font-medium text-primary">Click to replace</p>
            </>
          ) : (
            <>
              <div className="mb-4 flex size-14 items-center justify-center rounded-2xl border bg-background text-muted-foreground shadow-sm transition-transform group-hover:-translate-y-0.5"><Upload className="size-6" /></div>
              <p className="text-sm font-semibold">Drop your transcript here</p>
              <p className="mt-1 text-sm text-muted-foreground">or click to browse your files</p>
              <p className="mt-4 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">DOCX · up to {MAX_UPLOAD_LABEL}</p>
            </>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            <span className="flex size-5 items-center justify-center rounded-md bg-primary/10">2</span>
            Set note length
          </div>
          <p className="mb-3 text-sm text-muted-foreground">
            {isAnalyzing
              ? "Reading your transcript to recommend a page count…"
              : estimate
                ? `Recommended ${estimate.recommendedPages} ${estimate.recommendedPages === 1 ? "page" : "pages"} based on this transcript. Adjust if you want more or less detail.`
                : "Upload a transcript for a recommendation, or set a page target from 1 to 25."}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-40">
              <Input
                id="page-count"
                type="number"
                min={1}
                max={25}
                step={1}
                inputMode="numeric"
                value={pages}
                onChange={(event) => {
                  const value = event.target.valueAsNumber
                  if (!Number.isNaN(value)) setPages(Math.min(25, Math.max(1, Math.round(value))))
                }}
                className="h-12 rounded-xl pr-16 text-base font-semibold tabular-nums"
                aria-label="Target number of pages"
              />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                {pages === 1 ? "page" : "pages"}
              </span>
            </div>
            {isAnalyzing && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            {estimate && !isAnalyzing && pages !== estimate.recommendedPages && (
              <button
                type="button"
                onClick={() => setPages(estimate.recommendedPages)}
                className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
              >
                <Wand2 className="size-3.5" />
                Use recommended ({estimate.recommendedPages})
              </button>
            )}
            {estimate && !isAnalyzing && pages === estimate.recommendedPages && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
                <Wand2 className="size-3.5" />
                Recommended
              </span>
            )}
          </div>
        </div>

        <div>
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            <span className="flex size-5 items-center justify-center rounded-md bg-primary/10">3</span>
            Label your notes
          </div>
          <p className="mb-3 text-sm text-muted-foreground">Shown at the top of the generated document.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="title-name" className="mb-1.5 block text-xs font-medium text-muted-foreground">Class or course name</label>
              <Input
                id="title-name"
                type="text"
                placeholder="e.g. Environmental Law"
                value={titleName}
                onChange={(event) => setTitleName(event.target.value.slice(0, 150))}
                className="h-12 rounded-xl text-sm"
                aria-label="Class or course name"
              />
            </div>
            <div>
              <label htmlFor="duration" className="mb-1.5 block text-xs font-medium text-muted-foreground">Duration (minutes)</label>
              <Input
                id="duration"
                type="text"
                inputMode="decimal"
                placeholder="e.g. 82.55"
                value={duration}
                onChange={(event) => setDuration(event.target.value.slice(0, 40))}
                className="h-12 rounded-xl text-sm"
                aria-label="Class duration in minutes"
              />
            </div>
          </div>
        </div>

        <Button size="lg" onClick={handleUpload} disabled={!file || isProcessing || isAnalyzing} className="h-12 w-full rounded-xl text-sm shadow-md shadow-primary/15">
          {isProcessing
            ? <><Loader2 className="animate-spin" />Creating your notes</>
            : isAnalyzing
              ? <><Loader2 className="animate-spin" />Analyzing transcript</>
              : <><Sparkles />Generate smart notes</>}
        </Button>
        <p className="text-center text-xs text-muted-foreground">Your document is used only to create your notes.</p>
      </CardContent>
    </Card>
  )
}
