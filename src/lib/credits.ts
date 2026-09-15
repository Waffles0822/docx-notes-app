export function calculateRemainingCredits(startingCredits: number, reportedSpend: number): number {
  return Math.max(0, Math.round((startingCredits - reportedSpend) * 100) / 100)
}

export function getStartingCredits(): number {
  const value = Number(process.env.OPENAI_INITIAL_CREDITS ?? "4.96")
  return Number.isFinite(value) && value >= 0 ? value : 0
}

export function getAdaptiveContextWords(text: string): number {
  return /[.!?]\s*$/.test(text.trim()) ? 80 : 180
}

export function summarizeCosts(buckets: Array<{ start_time?: number; results?: Array<{ amount?: { value?: number } }>; amount?: { value?: number } }>) {
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const todayStart = today.getTime() / 1000
  return buckets.reduce((summary, bucket) => {
    const amount = bucket.results?.reduce((sum, item) => sum + Number(item.amount?.value || 0), 0) ?? Number(bucket.amount?.value || 0)
    summary.total += amount
    if (Number(bucket.start_time || 0) >= todayStart) summary.today += amount
    return summary
  }, { total: 0, today: 0 })
}

export function estimateDocumentCost(
  usage: { input: number; cached: number; output: number },
  rates: { input: number; cached: number; output: number }
): number {
  return Math.round((usage.input * rates.input + usage.cached * rates.cached + usage.output * rates.output) / 1_000_000 * 1_000_000) / 1_000_000
}
