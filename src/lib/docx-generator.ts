import { AlignmentType, BorderStyle, Document, LevelFormat, Packer, Paragraph, TextRun } from "docx"
import { buildRichRuns, normalizeMathInProse } from "./math-format"
import { normalizeDurationMinutes } from "./transcript-metadata"

export type Bullet = {
  text: string
  children: Bullet[]
}

export type SubSection = {
  heading: string
  bullets: Bullet[]
}

export type NotesMeta = {
  titleName?: string
  duration?: string
}

const BULLET_REFERENCE = "notes-bullets"
const MAX_BULLET_LEVEL = 3
// Half-points: 24 = 12pt. Every visible run uses the same Verdana 12pt base.
const BODY_SIZE = 24
const GROUP_HEADING_SIZE = 24
const FONT = "Verdana"

function decodeHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    // Formula spans must survive tag stripping, so fold <math> into the \(..\) delimiter
    // form that the math formatter also recognises.
    .replace(/<math>([\s\S]*?)<\/math>/gi, (_, body) => `\\(${body}\\)`)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
}

function isProgrammingContext(value: string): boolean {
  return /\b(?:computer programming|programming|coding|source code|software development|software developer|compiler|terminal|command line|api|http|url|html|css|javascript|typescript|python|java|c\+\+|c#|sql|json|xml|git|npm|node\.js|react|next\.js)\b/i.test(value)
    || /(?:=>|::|:\/\/|[{}]|`[^`]+`|\b(?:const|let|var|return|import|export|SELECT|INSERT|UPDATE|DELETE)\b)/.test(value)
}

export function sanitizeNotePunctuation(value: string): string {
  if (!value || isProgrammingContext(value)) return value
  return value
    .replace(/\b(\d{1,2}):(\d{2}):(\d{2})\b/g, "$1h $2m $3s")
    .replace(/\b(\d{1,2}):(\d{2})\b/g, "$1.$2")
    .replace(/(\d)\s*:\s*(\d)/g, "$1 to $2")
    .replace(/\s*;\s*/g, ". ")
    .replace(/\s*:\s*/g, " — ")
    .replace(/\s{2,}/g, " ")
    .trim()
}

function normalizeNoteText(value: string): string {
  return sanitizeNotePunctuation(decodeHtml(value))
    .replace(/\s+([.,;!?])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s{2,}/g, " ")
    .replace(/\n+/g, " ")
    .trim()
}

// Short leaf bullets are legitimate and common ("Stationary sources", "Ozone (O3)"),
// so length alone must never disqualify a bullet — only genuinely empty text and the
// placeholder section names we explicitly told the model not to produce.
function isGenericOrEmptyBullet(value: string): boolean {
  const text = normalizeNoteText(value)
  if (!text) return true
  if (!/[a-z0-9]/i.test(text)) return true
  return /^(the instructor will answer questions during class|we will talk about this later|let us continue|class discussion|important information|supporting details|key takeaways|other notes|discussion topic|additional detail)\.?$/i.test(text)
}

// Splits `content` into the inner-content strings of every top-level (unnested) <tagName>...</tagName>
// pair it contains, correctly skipping past any same-named tags nested inside.
function splitBalancedTags(content: string, tagName: string): string[] {
  const tagRe = new RegExp(`<${tagName}[^>]*>|<\\/${tagName}>`, "gi")
  const blocks: string[] = []
  let depth = 0
  let start = -1
  let match: RegExpExecArray | null

  while ((match = tagRe.exec(content)) !== null) {
    const isClose = match[0][1] === "/"
    if (!isClose) {
      if (depth === 0) start = tagRe.lastIndex
      depth++
    } else {
      depth--
      if (depth === 0 && start !== -1) {
        blocks.push(content.slice(start, match.index))
        start = -1
      }
    }
  }
  return blocks
}

function parseBullets(ulContent: string): Bullet[] {
  const liBlocks = splitBalancedTags(ulContent, "li")
  const bullets: Bullet[] = []

  for (const li of liBlocks) {
    const nestedListOpen = /<(?:ul|ol)[^>]*>/i.exec(li)
    let text: string
    let children: Bullet[] = []

    if (nestedListOpen) {
      text = normalizeNoteText(li.slice(0, nestedListOpen.index))
      const rest = li.slice(nestedListOpen.index)
      const tagName = /^<ol/i.test(rest) ? "ol" : "ul"
      const nestedContent = splitBalancedTags(rest, tagName)[0] || ""
      if (nestedContent) children = parseBullets(nestedContent)
    } else {
      text = normalizeNoteText(li)
    }

    if (text && !isGenericOrEmptyBullet(text)) {
      bullets.push({ text, children })
    } else if (children.length) {
      // A parent whose own text was empty or filler still carries real children —
      // promote them rather than discarding the whole branch.
      bullets.push(...children)
    }
  }

  return bullets
}

// Conservative usable widths for Google Docs and DOCX after each bullet indent.
// Width, not word count, determines whether a supporting bullet must be divided.
const MAX_BULLET_WIDTH_POINTS = [430, 405, 380, 355]
const TITLE_FILLER_WORDS = new Set([
  "a", "an", "and", "are", "at", "be", "been", "being", "but", "by", "can",
  "could", "did", "do", "does", "for", "had", "has", "have", "in", "is", "may",
  "might", "must", "of", "on", "or", "should", "that", "the", "these", "this",
  "those", "to", "was", "were", "will", "with", "would",
])

function estimateVerdana12Width(text: string): number {
  return [...text].reduce((width, character) => {
    if (/\s/.test(character)) return width + 3.5
    if (/[ilI.,'`!|]/.test(character)) return width + 3.25
    if (/[mwMW@%&]/.test(character)) return width + 9.5
    if (/[A-Z0-9]/.test(character)) return width + 7
    return width + 6
  }, 0)
}

function splitOneLineBullet(text: string, level: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const maxWidth = MAX_BULLET_WIDTH_POINTS[Math.min(level, MAX_BULLET_WIDTH_POINTS.length - 1)]
  if (estimateVerdana12Width(text) <= maxWidth) return [text]

  const lines: string[][] = []
  let current: string[] = []
  for (const word of words) {
    const candidate = [...current, word].join(" ")
    if (current.length && estimateVerdana12Width(candidate) > maxWidth) {
      lines.push(current)
      current = [word]
    } else {
      current.push(word)
    }
  }
  if (current.length) lines.push(current)

  const last = lines.at(-1)
  const previous = lines.at(-2)
  while (last && previous && last.length < 3 && previous.length > 3) {
    const candidate = [previous.at(-1) || "", ...last].join(" ")
    if (estimateVerdana12Width(candidate) > maxWidth) break
    last.unshift(previous.pop() || "")
  }
  return lines.map((line) => line.join(" "))
}

function toTitleWord(word: string): string {
  if (/^[A-Z0-9][A-Z0-9-]*$/.test(word)) return word
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function deriveDarkBulletTitle(text: string): string {
  const words = text
    .replace(/[.!?]+$/g, "")
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})-]+$/gu, ""))
    .filter(Boolean)
  const meaningful = words.filter((word) => !TITLE_FILLER_WORDS.has(word.toLowerCase()))
  const selected = (meaningful.length >= 3 ? meaningful : words).slice(0, 6)
  return selected.map(toTitleWord).join(" ") || "Source Detail"
}

// Model instructions normally produce the requested layout. This deterministic
// export guard prevents occasional long responses from wrapping in Verdana 12pt.
// No source text is discarded. A long top-level statement becomes a short title,
// and its full wording is retained in one-line child bullets.
function normalizeBulletLayout(bullets: Bullet[], level = 0): Bullet[] {
  return bullets.flatMap((bullet) => {
    const normalizedChildren = normalizeBulletLayout(bullet.children, Math.min(level + 1, MAX_BULLET_LEVEL))
    const wordCount = bullet.text.split(/\s+/).filter(Boolean).length
    const isShortTitle = level === 0 && wordCount <= 6 && !/[.!?]$/.test(bullet.text)

    if (level === 0) {
      if (isShortTitle) return [{ text: bullet.text, children: normalizedChildren }]
      const retainedDetail = splitOneLineBullet(bullet.text, 1).map((text) => ({ text, children: [] }))
      return [{
        text: deriveDarkBulletTitle(bullet.text),
        children: [...retainedDetail, ...normalizedChildren],
      }]
    }

    const lines = splitOneLineBullet(bullet.text, level)
    return lines.map((text, index) => ({
      text,
      children: index === lines.length - 1 ? normalizedChildren : [],
    }))
  })
}

function extractSubsections(sectionHtml: string): SubSection[] {
  const headingRe = /<h[34][^>]*>([\s\S]*?)<\/h[34]>/gi
  const headings: { heading: string; start: number; end: number }[] = []
  let match: RegExpExecArray | null

  while ((match = headingRe.exec(sectionHtml)) !== null) {
    headings.push({ heading: normalizeNoteText(match[1]), start: match.index, end: headingRe.lastIndex })
  }

  return headings
    .map((current, index) => {
      const contentEnd = index + 1 < headings.length ? headings[index + 1].start : sectionHtml.length
      const content = sectionHtml.slice(current.end, contentEnd)
      const bullets = normalizeBulletLayout(splitBalancedTags(content, "ul").flatMap((ul) => parseBullets(ul)))
      return { heading: current.heading, bullets }
    })
    .filter((section) => section.heading && section.bullets.length)
}

function extractGroupSection(html: string, cls: "announcements" | "lecture"): SubSection[] {
  const match = new RegExp(`<section[^>]*class="${cls}"[^>]*>([\\s\\S]*?)<\\/section>`, "i").exec(html)
  return match ? extractSubsections(match[1]) : []
}

// Announcement rendering has one invariant: Reminder is its only sub-heading. Merge
// every model-produced announcement subsection beneath it as a final safety net.
function normalizeAnnouncements(subs: SubSection[]): SubSection[] {
  if (!subs.length) return []
  return [{ heading: "Reminder", bullets: subs.flatMap((sub) => sub.bullets) }]
}

export function parseNotes(html: string): { announcements: SubSection[]; lecture: SubSection[] } {
  return {
    announcements: normalizeAnnouncements(extractGroupSection(html, "announcements")),
    lecture: extractGroupSection(html, "lecture"),
  }
}

// Shaded circle bullets for all levels (fisheye ◉, hollow circle ○, filled square ■, repeat).
// Each level indents by 0.25". The generator limits bullet text to one line.
function buildBulletLevels() {
  const glyphs = ["◉", "○", "■", "◉"]
  return glyphs.map((text, level) => ({
    level,
    format: LevelFormat.BULLET,
    text,
    alignment: AlignmentType.LEFT,
    style: {
      paragraph: { indent: { left: 360 + level * 360, hanging: 260 } },
      run: { font: FONT, size: BODY_SIZE },
    },
  }))
}

export async function createNotesDocx(html: string, meta: NotesMeta = {}): Promise<Buffer> {
  const { announcements, lecture } = parseNotes(html)
  const titleName = sanitizeNotePunctuation(meta.titleName?.trim() || "Untitled Class")
  const duration = normalizeDurationMinutes(meta.duration || "") || "N/A"

  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.LEFT,
      bidirectional: false,
      spacing: { after: 40, line: 240 },
      children: [new TextRun({ text: `Title Name — ${normalizeMathInProse(titleName)}`, size: BODY_SIZE, font: FONT })],
    }),
    new Paragraph({
      alignment: AlignmentType.LEFT,
      bidirectional: false,
      spacing: { after: 40, line: 240 },
      children: [new TextRun({ text: `Duration — ${duration}`, size: BODY_SIZE, font: FONT })],
    }),
    new Paragraph({
      alignment: AlignmentType.LEFT,
      bidirectional: false,
      spacing: { after: 160, line: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "AAAAAA", space: 6 } },
      children: [
        // Keep feedback content as an ordinary text run. It remains selectable and
        // copy-pastable in Word; no drawing, image, field, or inaccessible object is used.
        new TextRun({
          text: "Click here to provide feedback",
          size: BODY_SIZE,
          font: FONT,
          color: "1155CC",
          underline: {},
        }),
      ],
    }),
  ]

  function renderBullets(bullets: Bullet[], level: number) {
    for (const bullet of bullets) {
      children.push(new Paragraph({
        alignment: AlignmentType.LEFT,
        bidirectional: false,
        numbering: { reference: BULLET_REFERENCE, level },
        // keepNext holds a parent bullet with the children that explain it, so a nested
        // group never splits away from the point it belongs to.
        keepNext: bullet.children.length > 0,
        spacing: { after: 20, line: 259 },
        // Every bullet remains plain text, including a parent with nested children.
        // Bold is reserved exclusively for the group and subsection headers below.
        children: buildRichRuns(bullet.text, { font: FONT, size: BODY_SIZE, bold: false }),
      }))
      if (bullet.children.length) renderBullets(bullet.children, Math.min(level + 1, MAX_BULLET_LEVEL))
    }
  }

  function renderGroup(label: string, subs: SubSection[], isFirstGroup: boolean) {
    if (!subs.length) return
    children.push(new Paragraph({
      alignment: AlignmentType.LEFT,
      bidirectional: false,
      keepNext: true,
      spacing: { before: isFirstGroup ? 0 : 200, after: 60, line: 240 },
      children: [new TextRun({ text: label, bold: true, underline: {}, size: GROUP_HEADING_SIZE, font: FONT })],
    }))

    subs.forEach((sub, subIndex) => {
      children.push(new Paragraph({
        alignment: AlignmentType.LEFT,
        bidirectional: false,
        keepNext: true,
        spacing: { before: subIndex === 0 ? 20 : 140, after: 40, line: 240 },
        children: buildRichRuns(sub.heading, { font: FONT, size: BODY_SIZE, bold: true }),
      }))
      renderBullets(sub.bullets, 0)
    })
  }

  renderGroup("ANNOUNCEMENT", announcements, true)
  renderGroup("LECTURE", lecture, announcements.length === 0)

  const document = new Document({
    creator: "DocuNotes",
    title: titleName,
    description: "Organized class notes generated from a transcript",
    numbering: {
      config: [{ reference: BULLET_REFERENCE, levels: buildBulletLevels() }],
    },
    styles: {
      default: {
        document: {
          run: { font: FONT, size: BODY_SIZE },
          paragraph: { alignment: AlignmentType.LEFT, spacing: { line: 259, after: 20 } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
        },
      },
      children,
    }],
  })

  return Packer.toBuffer(document)
}
