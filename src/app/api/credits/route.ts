import { NextResponse } from "next/server"
import { calculateRemainingCredits, getStartingCredits, summarizeCosts } from "@/lib/credits"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const adminKey = process.env.OPENAI_ADMIN_KEY
  if (!adminKey) return NextResponse.json({ available: false })

  const start = new Date()
  start.setUTCDate(1)
  start.setUTCHours(0, 0, 0, 0)
  const params = new URLSearchParams({
    start_time: String(Math.floor(start.getTime() / 1000)),
    bucket_width: "1d",
    limit: "31",
  })

  try {
    const response = await fetch(`https://api.openai.com/v1/organization/costs?${params}`, {
      headers: { Authorization: `Bearer ${adminKey}` },
      cache: "no-store",
    })
    if (!response.ok) return NextResponse.json({ available: false }, { status: 502 })
    const data = await response.json()
    const costs = summarizeCosts(data.data || [])
    return NextResponse.json({ available: true, remaining: calculateRemainingCredits(getStartingCredits(), costs.total), usedToday: costs.today, updatedAt: Date.now() })
  } catch {
    return NextResponse.json({ available: false }, { status: 502 })
  }
}
