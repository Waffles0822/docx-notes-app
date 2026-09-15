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
