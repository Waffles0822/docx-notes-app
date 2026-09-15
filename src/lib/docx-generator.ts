import { AlignmentType, BorderStyle, Document, LevelFormat, Packer, Paragraph, TextRun } from "docx"
import { buildRichRuns, normalizeMathInProse } from "./math-format"

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
// Half-points: 22 = 11pt body text, 24 = 12pt group headings.
const BODY_SIZE = 22
const GROUP_HEADING_SIZE = 24
const FONT = "Arial"

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

function normalizeNoteText(value: string): string {
  return decodeHtml(value)
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
      const bullets = splitBalancedTags(content, "ul").flatMap((ul) => parseBullets(ul))
      return { heading: current.heading, bullets }
    })
    .filter((section) => section.heading && section.bullets.length)
}

function extractGroupSection(html: string, cls: "announcements" | "lecture"): SubSection[] {
  const matches = html.matchAll(new RegExp(`<section[^>]*class=["']${cls}["'][^>]*>([\\s\\S]*?)<\\/section>`, "gi"))
  return Array.from(matches).flatMap((match) => extractSubsections(match[1]))
}

function mergeTopics(sections: SubSection[]): SubSection[] {
  const topics = new Map<string, SubSection>()
  for (const section of sections) {
    const key = section.heading.toLowerCase().replace(/\s+/g, " ").trim()
    const existing = topics.get(key)
    if (existing) existing.bullets.push(...section.bullets)
    else topics.set(key, { ...section, bullets: [...section.bullets] })
  }
  // Merge repeated parent headings while keeping their distinct nested details.
  const mergeBullets = (bullets: Bullet[]): Bullet[] => {
    const merged = new Map<string, Bullet>()
    for (const bullet of bullets) {
      const key = bullet.text.toLowerCase().trim()
      const existing = merged.get(key)
      if (existing) existing.children.push(...bullet.children)
      else merged.set(key, { ...bullet, children: [...bullet.children] })
    }
    return Array.from(merged.values(), (bullet) => ({ ...bullet, children: mergeBullets(bullet.children) }))
  }
  return Array.from(topics.values(), (topic) => ({ ...topic, bullets: mergeBullets(topic.bullets) }))
}

// Normalize older output and chunked responses to one reminder heading.
// Other announcement headings become parent bullets, preserving their details.
function hoistReminders(subs: SubSection[]): SubSection[] {
  if (!subs.length) return []
  const isReminder = (sub: SubSection) => /^reminders?$/i.test(sub.heading.trim())
  return [{
    heading: "Reminder",
    bullets: [
      ...subs.filter(isReminder).flatMap((sub) => sub.bullets),
      ...subs.filter((sub) => !isReminder(sub)).map((sub) => ({
        text: sub.heading,
        children: sub.bullets,
      })),
    ],
  }]
}

export function parseNotes(html: string): { announcements: SubSection[]; lecture: SubSection[] } {
  return {
    announcements: mergeTopics(hoistReminders(extractGroupSection(html, "announcements"))),
    lecture: mergeTopics(extractGroupSection(html, "lecture")),
  }
}

// Shaded circle, hollow circle, and square bullets distinguish nesting levels.
// Each level indents by 0.25" with a hanging indent so wrapped lines align under the text.
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

export type NoteParagraph = {
  text: string
  kind: "meta" | "feedback" | "group" | "subheading" | "bullet"
  level?: number
  bold?: boolean
  keepNext?: boolean
  pageBreakBefore?: boolean
}

// Both exports consume this single outline. Writing allocations supply a length
// budget; they must never create repeated document groups or independent lectures.
export function buildNoteParagraphs(html: string, title = "", duration = ""): NoteParagraph[] {
  const { announcements, lecture } = parseNotes(html)
  const paragraphs: NoteParagraph[] = [
    { text: `Title Name : ${normalizeMathInProse(title.trim() || "Untitled Class")}`, kind: "meta" },
    { text: `Duration: ${duration.trim() || "N/A"}`, kind: "meta" },
    { text: "Click here to provide feedback", kind: "feedback" },
  ]
  function bullets(items: Bullet[], level: number) {
    for (const bullet of items) {
      paragraphs.push({ text: bullet.text, kind: "bullet", level,
        bold: false,
        keepNext: bullet.children.length > 0 })
      bullets(bullet.children, Math.min(level + 1, MAX_BULLET_LEVEL))
    }
  }
  function group(text: string, sections: SubSection[]) {
    if (!sections.length) return
    paragraphs.push({ text, kind: "group", keepNext: true })
    for (const section of sections) {
      paragraphs.push({ text: section.heading, kind: "subheading", keepNext: true })
      bullets(section.bullets, 0)
    }
  }
  group("ANNOUNCEMENTS", announcements)
  group("LECTURE", lecture)
  return paragraphs
}

export async function createNotesDocx(html: string, meta: NotesMeta = {}): Promise<Buffer> {
  const titleName = meta.titleName?.trim() || "Untitled Class"
  const outline = buildNoteParagraphs(html, titleName, meta.duration)
  const children = outline.map((item, index) => {
    const group = item.kind === "group"
    const heading = group || item.kind === "subheading"
    const feedback = item.kind === "feedback"
    return new Paragraph({
      pageBreakBefore: item.pageBreakBefore,
      keepNext: item.keepNext,
      ...(item.kind === "bullet" ? { numbering: { reference: BULLET_REFERENCE, level: item.level || 0 } } : {}),
      spacing: {
        before: group ? (index === 3 ? 0 : 200) : item.kind === "subheading" ? (outline[index - 1]?.kind === "group" ? 20 : 140) : 0,
        after: feedback ? 160 : group ? 60 : heading || item.kind === "meta" ? 40 : 20,
        line: heading || feedback || item.kind === "meta" ? 240 : 259,
      },
      ...(feedback ? { border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "AAAAAA", space: 6 } } } : {}),
      children: feedback
        ? [new TextRun({ text: item.text, size: BODY_SIZE, font: FONT, color: "1155CC", underline: {} })]
        : group
          ? [new TextRun({ text: item.text, bold: true, underline: {}, size: GROUP_HEADING_SIZE, font: FONT })]
          : buildRichRuns(item.text, { font: FONT, size: BODY_SIZE, bold: heading || item.bold }),
    })
  })

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
          paragraph: { spacing: { line: 259, after: 20 } },
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
