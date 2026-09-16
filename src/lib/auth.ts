import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { AUTH_COOKIE_NAME, createAuthToken, isConfigured, isValidAuthToken, passwordsMatch, REMEMBER_DAYS } from "./auth-core.mjs"

export { AUTH_COOKIE_NAME, REMEMBER_DAYS }

export async function isAuthenticated() {
  const token = (await cookies()).get(AUTH_COOKIE_NAME)?.value
  return Boolean(token && await isValidAuthToken(token))
}

export function unauthorizedResponse() {
  return NextResponse.json({ error: "Authentication required." }, { status: 401 })
}

export async function loginResponse(remember: boolean) {
  const response = NextResponse.json({ authenticated: true })
  response.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: await createAuthToken(),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    ...(remember ? { maxAge: REMEMBER_DAYS * 24 * 60 * 60 } : {}),
  })
  return response
}

export function clearLoginResponse() {
  const response = NextResponse.json({ authenticated: false })
  response.cookies.set({ name: AUTH_COOKIE_NAME, value: "", maxAge: 0, path: "/" })
  return response
}

export { isConfigured, passwordsMatch }
