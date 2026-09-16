"use client"

import { FormEvent, useState } from "react"
import { Loader2, LockKeyhole, Sparkles } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

export default function LoginGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("")
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError("")
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password, remember }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Could not sign in.")
      onAuthenticated()
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Could not sign in.")
    } finally {
      setLoading(false)
    }
  }

  return <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_var(--color-primary-soft),_transparent_38%)] px-4">
    <Card className="w-full max-w-sm shadow-xl shadow-primary/5">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Sparkles className="size-5" /></div>
        <CardTitle className="text-xl">Welcome to DocuNotes</CardTitle>
        <p className="text-sm text-muted-foreground">Enter the password to continue.</p>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <div className="relative"><LockKeyhole className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" className="pl-9" /></div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="size-4 rounded border-input" /> Remember me for 30 days</label>
          <Button type="submit" className="w-full" disabled={loading || !password}>{loading && <Loader2 className="animate-spin" />} Continue</Button>
        </form>
      </CardContent>
    </Card>
  </main>
}
