export type TranscriptTimeline = {
  timestampCount: number
  firstTimestamp: string | null
  lastTimestamp: string | null
  maxTimestamp: string | null
  durationSeconds: number
  durationLabel: string
}

type TimestampMatch = {
  raw: string
  seconds: number
}

// Transcript timestamps normally use HH:MM:SS, but accept MM:SS as well. The
// complete string is scanned so the detected duration cannot stop at a chunk boundary.
const TIMESTAMP_PATTERN = /(?<!\d)(?:(\d{1,3}):([0-5]\d):([0-5]\d)|(\d{1,3}):([0-5]\d))(?!\d)/g

function parseTranscriptTimestamps(text: string): TimestampMatch[] {
  const matches: TimestampMatch[] = []
  for (const match of text.matchAll(TIMESTAMP_PATTERN)) {
    const hasHours = match[1] !== undefined
    const hours = hasHours ? Number(match[1]) : 0
    const minutes = Number(hasHours ? match[2] : match[4])
    const seconds = Number(hasHours ? match[3] : match[5])
    matches.push({ raw: match[0], seconds: hours * 3600 + minutes * 60 + seconds })
  }
  return matches
}

export function formatTranscriptDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const seconds = safeSeconds % 60
  const paddedMinutes = String(minutes).padStart(2, "0")
  const paddedSeconds = String(seconds).padStart(2, "0")
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${paddedMinutes}:${paddedSeconds}`
    : `${paddedMinutes}:${paddedSeconds}`
}

export function analyzeTranscriptTimeline(text: string): TranscriptTimeline {
  const timestamps = parseTranscriptTimestamps(text)
  if (!timestamps.length) {
    return {
      timestampCount: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      maxTimestamp: null,
      durationSeconds: 0,
      durationLabel: "",
    }
  }

  const maximum = timestamps.reduce((current, candidate) =>
    candidate.seconds > current.seconds ? candidate : current
  )
  return {
    timestampCount: timestamps.length,
    firstTimestamp: timestamps[0].raw,
    lastTimestamp: timestamps[timestamps.length - 1].raw,
    maxTimestamp: maximum.raw,
    durationSeconds: maximum.seconds,
    durationLabel: formatTranscriptDuration(maximum.seconds),
  }
}

export function countMarkedSourcePages(text: string): number {
  return text.match(/<<<SOURCE PAGE \d+ START>>>/g)?.length || 0
}
