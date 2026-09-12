import mammoth from "mammoth"

export async function parseDocx(buffer: ArrayBuffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) })
  return result.value
}

export async function parseTxt(buffer: ArrayBuffer): Promise<string> {
  return Buffer.from(buffer).toString("utf-8")
}

export async function parseFile(buffer: ArrayBuffer, fileName: string): Promise<string> {
  const lowerName = fileName.toLowerCase()
  if (lowerName.endsWith(".txt")) {
    return parseTxt(buffer)
  }
  return parseDocx(buffer)
}
