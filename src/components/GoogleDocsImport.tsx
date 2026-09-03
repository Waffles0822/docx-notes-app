"use client"

import { useState, useCallback } from "react"
import { FileText, Loader2, Link2, AlertTriangle, CheckCircle2, Upload, ArrowUpRight, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { cn } from "@/lib/utils"
import { MAX_UPLOAD_LABEL } from "@/lib/upload-limits"

type Mode = "import" | "export"

interface GoogleDocsImportProps {
  mode: Mode
  notesHtml?: string
  notesTitle?: string
  onProcessingStart: () => void
  onProgress: (progress: { completed: number; total: number; progressPercent?: number; jobStatuses?: Array<{ id: string; status: string; progress: number }> }) => void
  onProcessingComplete: (result: { file: Blob; downloadName: string }) => void
  onError: (error: string) => void
  onExportSuccess?: () => void
}

export default function GoogleDocsImport({ mode, notesHtml, notesTitle, onProcessingStart, onProgress, onProcessingComplete, onError, onExportSuccess }: GoogleDocsImportProps) {
  const [docUrl, setDocUrl] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [urlError, setUrlError] = useState("")
  const [showSuccess, setShowSuccess] = useState(false)

  const validateUrl = useCallback((url: string) => {
    if (!url.trim()) {
      setUrlError("Please enter a Google Docs URL")
      return false
    }
    const pattern = /^https:\/\/docs\.google\.com\/document\/d\/[a-zA-Z0-9-_]+\/?.*$/
    if (!pattern.test(url)) {
      setUrlError("Invalid Google Docs URL. Expected: https://docs.google.com/document/d/DOC_ID/edit")
      return false
    }
    setUrlError("")
    return true
  }, [])

  const handleImport = useCallback(async () => {
    if (!validateUrl(docUrl) || isLoading) return

    setIsLoading(true)
    onProcessingStart()

    try {
      const baseUrl = window.location.origin
      const authUrl = `${baseUrl}/api/auth/google?docUrl=${encodeURIComponent(docUrl)}&redirectTo=${encodeURIComponent(window.location.pathname)}`
      window.location.href = authUrl
    } catch (err) {
      setIsLoading(false)
      onError(err instanceof Error ? err.message : "Failed to start Google Docs import")
    }
  }, [docUrl, isLoading, onProcessingStart, onError])

  const handleExport = useCallback(async () => {
    if (!validateUrl(docUrl) || isLoading) return
    if (!notesHtml) {
      onError("No notes to export. Generate notes first.")
      return
    }

    setIsLoading(true)
    onProcessingStart()

    try {
      const baseUrl = window.location.origin
      const encodedNotesHtml = Buffer.from(notesHtml).toString("base64url")
      const encodedTitle = notesTitle ? Buffer.from(notesTitle).toString("base64url") : ""
      const authUrl = `${baseUrl}/api/auth/google?docUrl=${encodeURIComponent(docUrl)}&redirectTo=${encodeURIComponent(window.location.pathname)}&mode=export&write=true&notesHtml=${encodedNotesHtml}&title=${encodedTitle}`
      window.location.href = authUrl
    } catch (err) {
      setIsLoading(false)
      onError(err instanceof Error ? err.message : "Failed to start Google Docs export")
    }
  }, [docUrl, isLoading, notesHtml, notesTitle, onProcessingStart, onError])

  const isImport = mode === "import"
  const ButtonIcon = isImport ? Link2 : ArrowUpRight
  const buttonText = isImport ? "Import from Google Docs" : "Export to Google Docs"
  const loadingText = isImport ? "Connecting to Google…" : "Exporting to Google…"
  const description = isImport
    ? "Paste a Google Docs link and we'll fetch the content to create your study guide."
    : "Paste a Google Docs link and we'll write your generated notes into that document."
  const helpText = isImport
    ? "You'll be redirected to Google to grant read-only access to this document."
    : "You'll be redirected to Google to grant edit access. The document will be replaced with your notes."

  return (
    <Card className="overflow-hidden border-border/70 bg-card/95 shadow-xl shadow-primary/5 backdrop-blur">
      <CardHeader className="border-b bg-muted/25 p-6 sm:p-7">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
          <span className="flex size-5 items-center justify-center rounded-md bg-primary/10">1</span>
          {isImport ? "Import from Google Docs" : "Export to Google Docs"}
        </div>
        <CardTitle className="text-2xl">{isImport ? "Link a Google Doc" : "Select Target Document"}</CardTitle>
        <CardDescription className="leading-6">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-7 p-6 sm:p-7">
        {showSuccess && (
          <Alert className="border-emerald-500/30 bg-emerald-500/5 text-emerald-800">
            <CheckCircle2 className="size-4 text-emerald-600" />
            <AlertDescription>{isImport ? "Import started!" : "Export started!"} You&apos;ll be redirected to Google to authorize access.</AlertDescription>
          </Alert>
        )}

        <div className="relative">
          <Link2 className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            id="gdocs-url"
            type="url"
            placeholder="https://docs.google.com/document/d/your-doc-id/edit"
            value={docUrl}
            onChange={(e) => { setDocUrl(e.target.value); setShowSuccess(false); }}
            onKeyDown={(e) => e.key === "Enter" && (isImport ? handleImport() : handleExport())}
            className={cn(
              "h-12 rounded-xl pl-12 pr-12 text-sm",
              urlError && "border-destructive focus-visible:ring-destructive"
            )}
            aria-label="Google Docs URL"
            disabled={isLoading}
          />
          {isLoading && <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 size-4 animate-spin text-muted-foreground" />}
        </div>

        {urlError && (
          <Alert variant="destructive" className="text-sm">
            <AlertTriangle className="size-3.5" />
            <AlertDescription>{urlError}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <FileText className="size-3.5" />
          <span>{isImport ? `Supports Google Docs up to ${MAX_UPLOAD_LABEL}. Content is read once during import.` : "Document must be editable by your Google account. Existing content will be replaced."}</span>
        </div>

        <Button size="lg" onClick={isImport ? handleImport : handleExport} disabled={!docUrl.trim() || isLoading || !!urlError || (!isImport && !notesHtml)} className="h-12 w-full rounded-xl text-sm shadow-md shadow-primary/15">
          {isLoading
            ? <><Loader2 className="animate-spin" />{loadingText}</>
            : <><ButtonIcon className="size-3.5" />{buttonText}</>}
        </Button>

        <p className="text-center text-xs text-muted-foreground">{helpText}</p>
      </CardContent>
    </Card>
  )
}
