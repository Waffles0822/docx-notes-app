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
  const match = new RegExp(`<section[^>]*class="${cls}"[^>]*>([\\s\\S]*?)<\\/section>`, "i").exec(html)
  return match ? extractSubsections(match[1]) : []
}

// Reminders (quizzes, exams, deadlines) always lead the notes. Chunked transcripts are
// merged section by section, so the model can emit a Reminders sub-header per chunk and
// not necessarily first; this folds them into one and moves it to the front.
function hoistReminders(subs: SubSection[]): SubSection[] {
  const isReminders = (sub: SubSection) => /^reminders?$/i.test(sub.heading.trim())
  const reminders = subs.filter(isReminders)
  if (!reminders.length) return subs

  const merged: SubSection = {
    heading: "Reminders",
    bullets: reminders.flatMap((sub) => sub.bullets),
  }
  return [merged, ...subs.filter((sub) => !isReminders(sub))]
}

export function parseNotes(html: string): { announcements: SubSection[]; lecture: SubSection[] } {
  return {
    announcements: hoistReminders(extractGroupSection(html, "announcements")),
    lecture: extractGroupSection(html, "lecture"),
  }
}

// Shaded circle bullets for all levels (fisheye ◉, hollow circle ○, filled square ■, repeat).
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

export async function createNotesDocx(html: string, meta: NotesMeta = {}): Promise<Buffer> {
  const { announcements, lecture } = parseNotes(html)
  const titleName = meta.titleName?.trim() || "Untitled Class"
  const duration = meta.duration?.trim() || "N/A"

  const children: Paragraph[] = [
    new Paragraph({
      spacing: { after: 40, line: 240 },
      children: [new TextRun({ text: `Title Name : ${normalizeMathInProse(titleName)}`, size: BODY_SIZE, font: FONT })],
    }),
    new Paragraph({
      spacing: { after: 40, line: 240 },
      children: [new TextRun({ text: `Duration: ${duration}`, size: BODY_SIZE, font: FONT })],
    }),
    new Paragraph({
      spacing: { after: 160, line: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "AAAAAA", space: 6 } },
      children: [
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
      // A first-level bullet carrying nested bullets is written as a Title Case heading
      // rather than a sentence, so it is bolded to show that role on the page. A
      // first-level bullet with no children is an ordinary sentence and stays plain.
      const isHeading = level === 0 && bullet.children.length > 0
      children.push(new Paragraph({
        numbering: { reference: BULLET_REFERENCE, level },
        // keepNext holds a parent bullet with the children that explain it, so a nested
        // group never splits away from the point it belongs to.
        keepNext: bullet.children.length > 0,
        spacing: { after: 20, line: 259 },
        children: buildRichRuns(bullet.text, { font: FONT, size: BODY_SIZE, bold: isHeading }),
      }))
      if (bullet.children.length) renderBullets(bullet.children, Math.min(level + 1, MAX_BULLET_LEVEL))
    }
  }

  function renderGroup(label: string, subs: SubSection[], isFirstGroup: boolean) {
    if (!subs.length) return
    children.push(new Paragraph({
      keepNext: true,
      spacing: { before: isFirstGroup ? 0 : 200, after: 60, line: 240 },
      children: [new TextRun({ text: label, bold: true, underline: {}, size: GROUP_HEADING_SIZE, font: FONT })],
    }))

    subs.forEach((sub, subIndex) => {
      children.push(new Paragraph({
        keepNext: true,
        spacing: { before: subIndex === 0 ? 20 : 140, after: 40, line: 240 },
        children: buildRichRuns(sub.heading, { font: FONT, size: BODY_SIZE, bold: true }),
      }))
      renderBullets(sub.bullets, 0)
    })
  }

  renderGroup("ANNOUNCEMENTS", announcements, true)
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
