import test from "node:test"
import assert from "node:assert/strict"
import { createAuthToken, isValidAuthToken, passwordsMatch, REMEMBER_DAYS } from "../src/lib/auth-core.mjs"

const now = 1_700_000_000_000

test("accepts the configured password and rejects another password", () => {
  process.env.APP_PASSWORD = "correct horse"
  assert.equal(passwordsMatch("correct horse"), true)
  assert.equal(passwordsMatch("wrong horse"), false)
})

test("creates a token that is valid for the remember-me window", async () => {
  process.env.APP_PASSWORD = "correct horse"
  const token = await createAuthToken(now)
  assert.equal(await isValidAuthToken(token, now + (REMEMBER_DAYS - 1) * 24 * 60 * 60 * 1000), true)
  assert.equal(await isValidAuthToken(token, now + (REMEMBER_DAYS + 1) * 24 * 60 * 60 * 1000), false)
})

test("rejects a tampered token", async () => {
  process.env.APP_PASSWORD = "correct horse"
  const token = await createAuthToken(now)
  const [timestamp, signature] = token.split(".")
  const tamperedSignature = `${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`
  assert.equal(await isValidAuthToken(`${timestamp}.${tamperedSignature}`, now), false)
})
