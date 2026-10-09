"use client"

import { useCallback, useRef, useState } from "react"
import { FileText, Loader2, Sparkles, Upload, Wand2, X, Link2, AlertTriangle, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/upload-limits"
import { GOOGLE_DOCS_URL_PATTERN, type NoteRequest } from "@/lib/note-generation"

export type FileEntry = NoteRequest & { id: string }

type UploadItem = FileEntry & {
  estimate: { words: number; recommendedPages: number } | null
  isAnalyzing: boolean
  gdocsUrlError: string
}

interface FileUploadProps {
  // Resolves with the ids of the files that were processed, so only the rest stay listed.
  onSubmit: (entries: FileEntry[]) => Promise<string[]>
}

function getGdocsUrlError(url: string): string {
  if (!url.trim() || GOOGLE_DOCS_URL_PATTERN.test(url)) return ""
  return "Invalid Google Docs URL. Expected: https://docs.google.com/document/d/DOC_ID/edit"
}

export default function FileUpload({ onSubmit }: FileUploadProps) {
  const [items, setItems] = useState<UploadItem[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [fileError, setFileError] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const nextId = useRef(0)

  const updateItem = useCallback((id: string, patch: Partial<UploadItem>) => {
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item))
  }, [])

  // Reads each transcript's real length so its page target starts at a sensible value
  // instead of an arbitrary default the user has to guess at.
  const analyzeFile = useCallback(async (id: string, candidate: File) => {
    try {
      const formData = new FormData()
      formData.append("file", candidate)
      const response = await fetch("/api/analyze", { method: "POST", body: formData })
      const data = await response.json()
      if (response.ok && typeof data.recommendedPages === "number") {
        updateItem(id, { estimate: data, pages: data.recommendedPages })
      }
    } catch {
      // A failed estimate is not worth interrupting the user for; the manual page input still works.
    } finally {
      updateItem(id, { isAnalyzing: false })
    }
  }, [updateItem])

  const addFiles = useCallback((candidates: File[]) => {
    const rejected: string[] = []
    const added: UploadItem[] = []
    for (const candidate of candidates) {
      const ext = candidate.name.toLowerCase().slice(candidate.name.lastIndexOf("."))
      if (![".docx", ".txt"].includes(ext)) {
        rejected.push(`${candidate.name} is not a .docx or .txt file.`)
        continue
      }
      if (candidate.size > MAX_UPLOAD_BYTES) {
        rejected.push(`${candidate.name} is larger than ${MAX_UPLOAD_LABEL}.`)
        continue
      }
      added.push({
        id: `file-${nextId.current++}`,
        file: candidate,
        pages: 5,
        titleName: candidate.name.replace(/\.(docx|txt)$/i, "").replace(/[_-]+/g, " ").trim().slice(0, 150),
        duration: "",
        gdocsUrl: "",
        estimate: null,
        isAnalyzing: true,
        gdocsUrlError: "",
      })
    }
    setFileError(rejected.join(" "))
    if (!added.length) return
    setItems((current) => [...current, ...added])
    for (const item of added) void analyzeFile(item.id, item.file)
  }, [analyzeFile])

  const handleDrag = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(event.type === "dragenter" || event.type === "dragover")
  }, [])

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(false)
    if (isProcessing) return
    addFiles(Array.from(event.dataTransfer.files))
  }, [addFiles, isProcessing])

  const isAnalyzing = items.some((item) => item.isAnalyzing)
  const hasGdocsError = items.some((item) => item.gdocsUrlError)
  const gdocsCount = items.filter((item) => item.gdocsUrl.trim() && !item.gdocsUrlError).length

  const handleSubmit = useCallback(async () => {
    if (!items.length || isProcessing || isAnalyzing) return
    const checked = items.map((item) => ({ ...item, gdocsUrlError: getGdocsUrlError(item.gdocsUrl) }))
    if (checked.some((item) => item.gdocsUrlError)) {
      setItems(checked)
      return
    }

    setIsProcessing(true)
    try {
      // Called without awaiting first so a Google sign-in popup still counts as a response to the click.
      const processedIds = await onSubmit(items.map(({ id, file, pages, titleName, duration, gdocsUrl }) => ({
        id, file, pages, titleName, duration, gdocsUrl: gdocsUrl.trim(),
      })))
      setItems((current) => current.filter((item) => !processedIds.includes(item.id)))
    } finally {
      setIsProcessing(false)
    }
  }, [items, isProcessing, isAnalyzing, onSubmit])

  return (
    <Card className="overflow-hidden border-border/70 bg-card/95 shadow-xl shadow-primary/5 backdrop-blur">
      <CardHeader className="border-b bg-muted/25 p-6 sm:p-7">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
          <span className="flex size-5 items-center justify-center rounded-md bg-primary/10">1</span>
          Add your sources
        </div>
        <CardTitle className="text-2xl">Create new study guides</CardTitle>
        <CardDescription className="leading-6">Upload one or more class transcripts. Each file is processed in order, one at a time.</CardDescription>
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
            "group relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-5 text-center outline-none transition-all focus-visible:ring-4 focus-visible:ring-ring/20",
            items.length ? "min-h-32 py-6" : "min-h-52",
            isDragging ? "border-primary bg-primary/10" : "border-border bg-muted/20 hover:border-primary/50 hover:bg-primary/[0.035]"
          )}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".docx,.txt,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            className="hidden"
            onChange={(event) => {
              addFiles(Array.from(event.target.files || []))
              event.target.value = ""
            }}
          />
          <div className="mb-4 flex size-14 items-center justify-center rounded-2xl border bg-background text-muted-foreground shadow-sm transition-transform group-hover:-translate-y-0.5"><Upload className="size-6" /></div>
          <p className="text-sm font-semibold">{items.length ? "Drop more transcripts here" : "Drop your transcripts here"}</p>
          <p className="mt-1 text-sm text-muted-foreground">or click to browse your files</p>
          <p className="mt-4 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">DOCX, TXT · up to {MAX_UPLOAD_LABEL} each · multiple files allowed</p>
        </div>

        {fileError && (
          <p className="-mt-4 flex items-start gap-1.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {fileError}
          </p>
        )}

        {items.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
              <span className="flex size-5 items-center justify-center rounded-md bg-primary/10">2</span>
              Set up each file
            </div>
            <p className="mb-3 text-sm text-muted-foreground">
              Choose the page count and labels for each transcript. Add a Google Docs link to write that file&apos;s notes
              into the document instead of downloading them. The document must be editable by your Google account, and its
              existing content will be replaced.
            </p>
            <ol className="space-y-4">
              {items.map((item, index) => (
                <li key={item.id} className="rounded-xl border bg-muted/10 p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><FileText className="size-5" /></div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{index + 1}. {item.file.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {item.isAnalyzing
                          ? "Measuring transcript length…"
                          : item.estimate
                            ? `${item.estimate.words.toLocaleString()} words · Recommended ${item.estimate.recommendedPages} ${item.estimate.recommendedPages === 1 ? "page" : "pages"}`
                            : `${(item.file.size / 1024).toFixed(1)} KB`}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${item.file.name}`}
                      disabled={isProcessing}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                      onClick={() => setItems((current) => current.filter((candidate) => candidate.id !== item.id))}
                    ><X className="size-4" /></button>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-[8.5rem_1fr_9rem]">
                    <div>
                      <label htmlFor={`${item.id}-pages`} className="mb-1.5 block text-xs font-medium text-muted-foreground">Pages</label>
                      <div className="relative">
                        <Input
                          id={`${item.id}-pages`}
                          type="number"
                          min={1}
                          max={80}
                          step={1}
                          inputMode="numeric"
                          value={item.pages}
                          disabled={isProcessing}
                          onChange={(event) => {
                            const value = event.target.valueAsNumber
                            if (!Number.isNaN(value)) updateItem(item.id, { pages: Math.min(80, Math.max(1, Math.round(value))) })
                          }}
                          className="h-11 rounded-xl pr-14 text-sm font-semibold tabular-nums"
                          aria-label={`Target number of pages for ${item.file.name}`}
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                          {item.isAnalyzing ? <Loader2 className="size-3.5 animate-spin" /> : item.pages === 1 ? "page" : "pages"}
                        </span>
                      </div>
                      {item.estimate && !item.isAnalyzing && item.pages !== item.estimate.recommendedPages && (
                        <button
                          type="button"
                          disabled={isProcessing}
                          onClick={() => updateItem(item.id, { pages: item.estimate!.recommendedPages })}
                          className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                        >
                          <Wand2 className="size-3" />
                          Use recommended ({item.estimate.recommendedPages})
                        </button>
                      )}
                    </div>
                    <div>
                      <label htmlFor={`${item.id}-title`} className="mb-1.5 block text-xs font-medium text-muted-foreground">Class or course name</label>
                      <Input
                        id={`${item.id}-title`}
                        type="text"
                        placeholder="e.g. Environmental Law"
                        value={item.titleName}
                        disabled={isProcessing}
                        onChange={(event) => updateItem(item.id, { titleName: event.target.value.slice(0, 150) })}
                        className="h-11 rounded-xl text-sm"
                      />
                    </div>
                    <div>
                      <label htmlFor={`${item.id}-duration`} className="mb-1.5 block text-xs font-medium text-muted-foreground">Duration (minutes)</label>
                      <Input
                        id={`${item.id}-duration`}
                        type="text"
                        inputMode="decimal"
                        placeholder="e.g. 82.55"
                        value={item.duration}
                        disabled={isProcessing}
                        onChange={(event) => updateItem(item.id, { duration: event.target.value.slice(0, 40) })}
                        className="h-11 rounded-xl text-sm"
                      />
                    </div>
                  </div>

                  <div className="mt-3">
                    <label htmlFor={`${item.id}-gdocs`} className="mb-1.5 block text-xs font-medium text-muted-foreground">Google Docs link (optional)</label>
                    <div className="relative">
                      <Link2 className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id={`${item.id}-gdocs`}
                        type="url"
                        placeholder="https://docs.google.com/document/d/your-doc-id/edit"
                        value={item.gdocsUrl}
                        disabled={isProcessing}
                        onChange={(event) => updateItem(item.id, { gdocsUrl: event.target.value, gdocsUrlError: getGdocsUrlError(event.target.value) })}
                        className={cn(
                          "h-11 rounded-xl pl-11 pr-4 text-sm",
                          item.gdocsUrlError && "border-destructive focus-visible:ring-destructive"
                        )}
                      />
                    </div>
                    {item.gdocsUrlError && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-sm text-destructive">
                        <AlertTriangle className="size-3.5" />
                        {item.gdocsUrlError}
                      </p>
                    )}
                    {item.gdocsUrl.trim() && !item.gdocsUrlError && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-sm text-emerald-600">
                        <CheckCircle2 className="size-3.5" />
                        Notes for this file will be written to this Google Doc
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        <Button size="lg" onClick={handleSubmit} disabled={!items.length || isProcessing || isAnalyzing || hasGdocsError} className="h-12 w-full rounded-xl text-sm shadow-md shadow-primary/15">
          {isProcessing
            ? <><Loader2 className="animate-spin" />Creating your notes</>
            : isAnalyzing
              ? <><Loader2 className="animate-spin" />Analyzing transcripts</>
              : <><Sparkles />{items.length > 1 ? `Generate notes for ${items.length} files` : "Generate smart notes"}</>}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          {gdocsCount > 0
            ? `${gdocsCount} of ${items.length} ${items.length === 1 ? "file" : "files"} will be written to Google Docs (requires Google sign-in); the rest will download.`
            : "Your documents are used only to create your notes."}
        </p>
      </CardContent>
    </Card>
  )
}
