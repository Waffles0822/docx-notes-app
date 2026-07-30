import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "DocuNotes — Transcript to Study Guide",
  description: "Turn class transcripts into clear, structured study guides.",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full font-sans bg-background text-foreground">{children}</body>
    </html>
  )
}
