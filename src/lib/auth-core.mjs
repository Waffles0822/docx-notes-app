export const AUTH_COOKIE_NAME = "docunotes_auth"
export const REMEMBER_DAYS = 30

function secret() {
  return process.env.APP_PASSWORD || ""
}

export function isConfigured() {
  return Boolean(secret())
}

async function sign(timestamp) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp))
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function createAuthToken(now = Date.now()) {
  const timestamp = String(now)
  const signature = await sign(timestamp)
  return `${timestamp}.${signature}`
}

export async function isValidAuthToken(token, now = Date.now()) {
  if (!secret()) return false
  const [timestamp, signature] = token.split(".")
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false
  const age = now - Number(timestamp)
  if (age < 0 || age > REMEMBER_DAYS * 24 * 60 * 60 * 1000) return false
  const expected = await sign(timestamp)
  return signature.length === expected.length && signature === expected
}

export function passwordsMatch(password) {
  return isConfigured() && password === secret()
}
