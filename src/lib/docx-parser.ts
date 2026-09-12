import mammoth from "mammoth"
import JSZip from "jszip"

const PAGE_BREAK_SENTINEL = "\uE000DOCUNOTES_SOURCE_PAGE_BREAK\uE001"

function labelSourcePages(text: string): string {
  const pages = text
    .split(PAGE_BREAK_SENTINEL)
    .map((page) => page.trim())
    // Explicit and last-rendered breaks can describe the same boundary. Removing
    // empty spans prevents duplicate markers while retaining every text-bearing page.
    .filter(Boolean)

  if (pages.length <= 1) return pages[0] || text.trim()
  return pages.map((page, index) =>
    `<<<SOURCE PAGE ${index + 1} START>>>\n${page}\n<<<SOURCE PAGE ${index + 1} END>>>`
  ).join("\n\n")
}

function markDocxPageBreaks(documentXml: string): { xml: string; count: number } {
  let count = 0
  const xml = documentXml.replace(
    /<w:br\b(?=[^>]*\bw:type=(?:"page"|'page'))[^>]*\/>|<w:lastRenderedPageBreak\b[^>]*\/>/gi,
    () => {
      count++
      return `<w:t>${PAGE_BREAK_SENTINEL}</w:t>`
    }
  )
  return { xml, count }
}

export async function parseDocx(buffer: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(Buffer.from(buffer))
  const documentFile = zip.file("word/document.xml")
  if (!documentFile) {
    throw new Error("The DOCX file does not contain a readable main document.")
  }

  const documentXml = await documentFile.async("string")
  const marked = markDocxPageBreaks(documentXml)
  if (!marked.count) {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) })
    return result.value
  }

  zip.file("word/document.xml", marked.xml)
  const markedDocx = await zip.generateAsync({ type: "nodebuffer" })
  const result = await mammoth.extractRawText({ buffer: markedDocx })
  return labelSourcePages(result.value)
}

export async function parseTxt(buffer: ArrayBuffer): Promise<string> {
  const text = Buffer.from(buffer).toString("utf-8")
  return labelSourcePages(text.replace(/\f/g, PAGE_BREAK_SENTINEL))
}

export async function parseFile(buffer: ArrayBuffer, fileName: string): Promise<string> {
  const lowerName = fileName.toLowerCase()
  if (lowerName.endsWith(".txt")) {
    return parseTxt(buffer)
  }
  return parseDocx(buffer)
}
