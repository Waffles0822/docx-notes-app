import { NextResponse } from "next/server"
import { calculateRemainingCredits, getStartingCredits } from "@/lib/credits"

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
    const spent = (data.data || []).reduce((sum: number, bucket: { results?: Array<{ amount?: { value?: number } }> }) =>
      sum + (bucket.results || []).reduce((bucketSum, item) => bucketSum + Number(item.amount?.value || 0), 0), 0)
    return NextResponse.json({ available: true, remaining: calculateRemainingCredits(getStartingCredits(), spent), updatedAt: Date.now() })
  } catch {
    return NextResponse.json({ available: false }, { status: 502 })
  }
}
