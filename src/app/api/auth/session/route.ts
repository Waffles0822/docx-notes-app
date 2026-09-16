import { NextResponse } from "next/server"
import { isAuthenticated, isConfigured } from "@/lib/auth"

export async function GET() {
  return NextResponse.json({ authenticated: isConfigured() && await isAuthenticated() })
}
