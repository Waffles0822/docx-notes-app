import { google, docs_v1 } from "googleapis"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { parseNotes, sanitizeNotePunctuation, type Bullet, type SubSection } from "./docx-generator"
import { normalizeMathInProse } from "./math-format"
import { normalizeDurationMinutes } from "./transcript-metadata"

export interface GoogleTokens {
  access_token: string
  refresh_token?: string
  expiry_date?: number
  token_type: string
  scope: string
}

export interface GoogleDocContent {
  title: string
  text: string
}

// Read-only scope for import, read-write for export
const READ_SCOPES = ["https://www.googleapis.com/auth/documents.readonly"]
const WRITE_SCOPES = ["https://www.googleapis.com/auth/documents"]

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI in .env.local")
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri)
}

function getTokenEncryptionKey(): Buffer {
  const secret = process.env.GOOGLE_CLIENT_SECRET
  if (!secret) throw new Error("Google OAuth is not configured.")
  return createHash("sha256").update(secret).digest()
}

export function encryptGoogleTokens(tokens: GoogleTokens): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", getTokenEncryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")
}

export function decryptGoogleTokens(value: string): GoogleTokens {
  const payload = Buffer.from(value, "base64url")
  if (payload.length < 29) throw new Error("Invalid Google authorization data.")
  const decipher = createDecipheriv("aes-256-gcm", getTokenEncryptionKey(), payload.subarray(0, 12))
  decipher.setAuthTag(payload.subarray(12, 28))
  const decrypted = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()])
  return JSON.parse(decrypted.toString("utf8")) as GoogleTokens
}

export function getAuthUrl(state: string, writeAccess = false): string {
  const oauth2Client = getOAuth2Client()
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: writeAccess ? WRITE_SCOPES : READ_SCOPES,
    state,
    prompt: "consent",
  })
}

export async function getTokensFromCode(code: string): Promise<GoogleTokens> {
  const oauth2Client = getOAuth2Client()
  const { tokens } = await oauth2Client.getToken(code)
  return tokens as GoogleTokens
}

export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  const oauth2Client = getOAuth2Client()
  oauth2Client.setCredentials({ refresh_token: refreshToken })
  const { credentials } = await oauth2Client.refreshAccessToken()
  return credentials as GoogleTokens
}

export async function ensureFreshGoogleTokens(tokens: GoogleTokens): Promise<GoogleTokens> {
  if (!tokens.expiry_date || tokens.expiry_date > Date.now() + 60_000) return tokens
  if (!tokens.refresh_token) throw new Error("Google authorization has expired.")

  const refreshed = await refreshAccessToken(tokens.refresh_token)
  return {
    ...tokens,
    ...refreshed,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
  }
}

function extractDocId(url: string): string | null {
  const match = url.match(/\/document\/d\/([a-zA-Z0-9-_]+)/)
  return match ? match[1] : null
}

function parseDocContent(doc: docs_v1.Schema$Document): string {
  let text = ""
  const body = doc.body
  if (!body?.content) return text

  for (const element of body.content) {
    if (element.paragraph) {
      for (const pe of element.paragraph.elements || []) {
        if (pe.textRun?.content) {
          text += pe.textRun.content
        }
      }
    } else if (element.table) {
      for (const row of element.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          for (const content of cell.content || []) {
            if (content.paragraph) {
              for (const pe of content.paragraph.elements || []) {
                if (pe.textRun?.content) {
                  text += pe.textRun.content
                }
              }
            }
          }
          text += "\t"
        }
        text += "\n"
      }
    }
  }
  return text
}

export async function fetchGoogleDocContent(tokens: GoogleTokens, docUrl: string): Promise<GoogleDocContent> {
  const docId = extractDocId(docUrl)
  if (!docId) {
    throw new Error("Invalid Google Docs URL. Expected format: https://docs.google.com/document/d/DOC_ID/edit")
  }

  const oauth2Client = getOAuth2Client()
  oauth2Client.setCredentials(tokens)

  const docs = google.docs({ version: "v1", auth: oauth2Client })
  const response = await docs.documents.get({ documentId: docId })

  const title = response.data.title || "Untitled Document"
  const text = parseDocContent(response.data)

  if (!text.trim()) {
    throw new Error("Document appears to be empty or could not be parsed.")
  }

  return { title, text }
}

type GoogleDocParagraph = {
  text: string
  kind: "meta" | "feedback" | "group" | "subheading" | "bullet"
  level?: number
  bold?: boolean
}

type IndexedParagraph = GoogleDocParagraph & {
  startIndex: number
  textStartIndex: number
  endIndex: number
}

const pt = (magnitude: number): docs_v1.Schema$Dimension => ({ magnitude, unit: "PT" })

function flattenBullets(bullets: Bullet[], level = 0): GoogleDocParagraph[] {
  return bullets.flatMap((bullet) => [
    {
      text: normalizeMathInProse(bullet.text),
      kind: "bullet" as const,
      level,
      bold: false,
    },
    ...flattenBullets(bullet.children, Math.min(level + 1, 3)),
  ])
}

function buildGroup(label: string, sections: SubSection[]): GoogleDocParagraph[] {
  if (!sections.length) return []
  return [
    { text: label, kind: "group" },
    ...sections.flatMap((section) => [
      { text: normalizeMathInProse(section.heading), kind: "subheading" as const },
      ...flattenBullets(section.bullets),
    ]),
  ]
}

function buildParagraphs(notesHtml: string, title: string, duration: string): GoogleDocParagraph[] {
  const { announcements, lecture } = parseNotes(notesHtml)
  return [
    { text: `Title Name — ${normalizeMathInProse(sanitizeNotePunctuation(title.trim() || "Untitled Class"))}`, kind: "meta" },
    { text: `Duration — ${normalizeDurationMinutes(duration) || "N/A"}`, kind: "meta" },
    // Inserted through the Docs text API, so the feedback row and the content that
    // follows it remain normal selectable, copy-pastable document text.
    { text: "Click here to provide feedback", kind: "feedback" },
    ...buildGroup("ANNOUNCEMENT", announcements),
    ...buildGroup("LECTURE", lecture),
  ]
}

function buildDocRequests(notesHtml: string, title: string, duration: string, endIndex: number): docs_v1.Schema$Request[] {
  const requests: docs_v1.Schema$Request[] = []
  const paragraphs = buildParagraphs(notesHtml, title, duration)
  const indexed: IndexedParagraph[] = []
  let index = 1
  const textContent = paragraphs.map((paragraph) => {
    const tabs = paragraph.kind === "bullet" ? "\t".repeat(paragraph.level || 0) : ""
    const line = `${tabs}${paragraph.text}\n`
    indexed.push({
      ...paragraph,
      startIndex: index,
      textStartIndex: index + tabs.length,
      endIndex: index + line.length,
    })
    index += line.length
    return line
  }).join("")

  if (endIndex > 2) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: endIndex - 1 },
      },
    })
  }

  requests.push({
    insertText: {
      location: { index: 1 },
      text: textContent,
    },
  })

  requests.push({
    updateTextStyle: {
      range: { startIndex: 1, endIndex: 1 + textContent.length },
      textStyle: { weightedFontFamily: { fontFamily: "Verdana" }, fontSize: pt(12) },
      fields: "weightedFontFamily,fontSize",
    },
  })
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: 1, endIndex: 1 + textContent.length },
      paragraphStyle: { alignment: "START", direction: "LEFT_TO_RIGHT", lineSpacing: 108, spaceBelow: pt(1) },
      fields: "alignment,direction,lineSpacing,spaceBelow",
    },
  })

  for (const paragraph of indexed) {
    const range = { startIndex: paragraph.startIndex, endIndex: paragraph.endIndex }
    let paragraphStyle: docs_v1.Schema$ParagraphStyle | undefined

    if (paragraph.kind === "group") {
      paragraphStyle = { lineSpacing: 100, spaceAbove: pt(10), spaceBelow: pt(3), keepWithNext: true }
    } else if (paragraph.kind === "subheading") {
      paragraphStyle = { lineSpacing: 100, spaceAbove: pt(7), spaceBelow: pt(2), keepWithNext: true }
    } else if (paragraph.kind === "feedback") {
      paragraphStyle = {
        lineSpacing: 100,
        spaceBelow: pt(8),
        borderBottom: {
        color: { color: { rgbColor: { red: 0.67, green: 0.67, blue: 0.67 } } },
        width: pt(0.75),
        padding: pt(6),
        dashStyle: "SOLID",
        },
      }
    }

    if (paragraphStyle) {
      requests.push({
        updateParagraphStyle: {
          range,
          paragraphStyle,
          fields: "lineSpacing,spaceAbove,spaceBelow,keepWithNext,borderBottom",
        },
      })
    }

    if (paragraph.kind === "group" || paragraph.kind === "subheading" || paragraph.bold) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: paragraph.textStartIndex, endIndex: paragraph.endIndex - 1 },
          textStyle: {
            bold: true,
            ...(paragraph.kind === "group" ? { underline: true, fontSize: pt(12) } : {}),
          },
          fields: paragraph.kind === "group" ? "bold,underline,fontSize" : "bold",
        },
      })
    }

    if (paragraph.kind === "feedback") {
      requests.push({
        updateTextStyle: {
          range: { startIndex: paragraph.textStartIndex, endIndex: paragraph.endIndex - 1 },
          textStyle: {
            foregroundColor: { color: { rgbColor: { red: 0.07, green: 0.33, blue: 0.8 } } },
            underline: true,
          },
          fields: "foregroundColor,underline",
        },
      })
    }
  }

  const bulletRanges = indexed.reduce<Array<{ startIndex: number; endIndex: number }>>((ranges, paragraph) => {
    if (paragraph.kind !== "bullet") return ranges
    const previous = ranges.at(-1)
    if (previous?.endIndex === paragraph.startIndex) previous.endIndex = paragraph.endIndex
    else ranges.push({ startIndex: paragraph.startIndex, endIndex: paragraph.endIndex })
    return ranges
  }, [])

  // Creating nested bullets removes their leading tabs and shifts later indexes, so apply
  // each contiguous list from the end of the document toward the beginning.
  for (const range of bulletRanges.reverse()) {
    requests.push({
      createParagraphBullets: {
        range,
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    })
  }

  return requests
}

export async function writeNotesToGoogleDoc(
  tokens: GoogleTokens,
  docUrl: string,
  notesHtml: string,
  title: string,
  duration = ""
): Promise<void> {
  const docId = extractDocId(docUrl)
  if (!docId) {
    throw new Error("Invalid Google Docs URL. Expected format: https://docs.google.com/document/d/DOC_ID/edit")
  }

  const oauth2Client = getOAuth2Client()
  oauth2Client.setCredentials(tokens)

  const docs = google.docs({ version: "v1", auth: oauth2Client })
  const document = await docs.documents.get({ documentId: docId })
  const content = document.data.body?.content || []
  const endIndex = content.at(-1)?.endIndex || 1
  const requests = buildDocRequests(notesHtml, title, duration, endIndex)
  const generatedWords = notesHtml
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .split(/\s+/)
    .filter(Boolean).length
  console.info("Google Docs output layout", {
    generatedWords,
    estimatedPagesAt350Words: Number((generatedWords / 350).toFixed(1)),
    formatting: "Verdana 12pt, 108% line spacing, one-line bullets",
  })

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests },
  })
}
