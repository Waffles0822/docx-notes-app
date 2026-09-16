import { NextRequest, NextResponse } from "next/server"
import { isConfigured, loginResponse, passwordsMatch } from "@/lib/auth"

export async function POST(request: NextRequest) {
  if (!isConfigured()) {
    return NextResponse.json({ error: "APP_PASSWORD is not configured." }, { status: 503 })
  }

  const body = await request.json().catch(() => null)
  const password = typeof body?.password === "string" ? body.password : ""
  const remember = body?.remember === true

  if (!passwordsMatch(password)) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 })
  }

  return await loginResponse(remember)
}
