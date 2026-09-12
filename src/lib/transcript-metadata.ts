export type TranscriptTimeline = {
  timestampCount: number
  firstTimestamp: string | null
  lastTimestamp: string | null
  maxTimestamp: string | null
  durationSeconds: number
  durationMinutes: number
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
  return `${Math.ceil(safeSeconds / 60)} mins`
}

export function normalizeDurationMinutes(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ""

  const numeric = /^(\d{1,5})(?:\s*(?:m|min|mins|minute|minutes))?$/i.exec(trimmed)
  if (numeric) {
    const minutes = Number(numeric[1])
    return minutes > 0 ? `${minutes} mins` : ""
  }

  // Preserve compatibility with previously saved HH:MM:SS or MM:SS values while
  // converting them to the new whole-minute display format.
  const timestamp = /^(?:(\d{1,3}):([0-5]\d):([0-5]\d)|(\d{1,3}):([0-5]\d))$/.exec(trimmed)
  if (!timestamp) return ""
  const hours = timestamp[1] === undefined ? 0 : Number(timestamp[1])
  const minutes = Number(timestamp[1] === undefined ? timestamp[4] : timestamp[2])
  const seconds = Number(timestamp[1] === undefined ? timestamp[5] : timestamp[3])
  return formatTranscriptDuration(hours * 3600 + minutes * 60 + seconds)
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
      durationMinutes: 0,
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
    durationMinutes: Math.ceil(maximum.seconds / 60),
    durationLabel: formatTranscriptDuration(maximum.seconds),
  }
}

export function countMarkedSourcePages(text: string): number {
  return text.match(/<<<SOURCE PAGE \d+ START>>>/g)?.length || 0
}
