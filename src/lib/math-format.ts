import {
  Math as DocxMath,
  MathFraction,
  MathRadical,
  MathRun,
  MathSubScript,
  MathSuperScript,
  TextRun,
} from "docx"

// Language models describe formulas in LaTeX even when asked for plain prose, so notes
// arrive containing fragments like \(2\pi-\arctan(3/2)\). Rendering those verbatim leaks
// markup into the document. This module turns them into native Word equation objects
// (OMML), which Word displays with proper fraction bars, radicals, and raised exponents.

type MathChild = MathRun | MathFraction | MathRadical | MathSuperScript | MathSubScript

const SYMBOLS: Record<string, string> = {
  // Greek
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ",
  tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // Operators and relations
  times: "×", div: "÷", cdot: "·", pm: "±", mp: "∓", ast: "∗",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", equiv: "≡",
  approx: "≈", cong: "≅", sim: "∼", simeq: "≃", propto: "∝", ll: "≪", gg: "≫",
  // Calculus and set notation
  infty: "∞", partial: "∂", nabla: "∇", int: "∫", iint: "∬", iiint: "∭",
  oint: "∮", sum: "∑", prod: "∏", coprod: "∐", surd: "√",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃",
  supseteq: "⊇", cup: "∪", cap: "∩", emptyset: "∅", varnothing: "∅",
  forall: "∀", exists: "∃", nexists: "∄", neg: "¬", land: "∧", lor: "∨",
  // Arrows
  to: "→", rightarrow: "→", Rightarrow: "⇒", leftarrow: "←", Leftarrow: "⇐",
  leftrightarrow: "↔", Leftrightarrow: "⇔", mapsto: "↦", implies: "⇒", iff: "⇔",
  // Punctuation and misc
  ldots: "…", dots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱",
  angle: "∠", degree: "°", circ: "∘", prime: "′", therefore: "∴", because: "∵",
  perp: "⊥", parallel: "∥", triangle: "△", square: "□", pi_: "π",
  Re: "ℜ", Im: "ℑ", aleph: "ℵ", hbar: "ℏ", ell: "ℓ", Alpha: "Α", Beta: "Β",
}

// Upright multi-letter function names. Kept as literal text so Word does not italicise them.
const FUNCTIONS = new Set([
  "arcsin", "arccos", "arctan", "arccot", "arcsec", "arccsc",
  "sin", "cos", "tan", "cot", "sec", "csc",
  "sinh", "cosh", "tanh", "coth", "arg", "deg",
  "ln", "log", "lg", "exp", "lim", "limsup", "liminf",
  "max", "min", "sup", "inf", "det", "dim", "ker", "gcd", "lcm", "mod", "bmod",
])

// Commands whose sole braced argument should be unwrapped to its contents.
const UNWRAP = new Set(["text", "mathrm", "mathbf", "mathit", "mathsf", "mathtt", "operatorname", "textbf", "textit", "mbox", "hbox"])

// Spacing commands that carry no visible content.
const SPACERS = new Set(["quad", "qquad", "thinspace", "medspace", "thickspace", "!", ",", ";", ":", " "])

/**
 * Reads a single LaTeX group starting at `index`. If the character there is `{`, returns the
 * balanced brace contents; otherwise returns just that one character (or whole command).
 */
function readGroup(latex: string, index: number): { body: string; next: number } {
  while (index < latex.length && /\s/.test(latex[index])) index++
  if (index >= latex.length) return { body: "", next: index }

  if (latex[index] === "{") {
    let depth = 0
    for (let i = index; i < latex.length; i++) {
      if (latex[i] === "{") depth++
      else if (latex[i] === "}") {
        depth--
        if (depth === 0) return { body: latex.slice(index + 1, i), next: i + 1 }
      }
    }
    return { body: latex.slice(index + 1), next: latex.length }
  }

  if (latex[index] === "\\") {
    const command = /^\\([a-zA-Z]+|.)/.exec(latex.slice(index))
    if (command) return { body: command[0], next: index + command[0].length }
  }

  return { body: latex[index], next: index + 1 }
}

/** Reads an optional bracket argument, e.g. the `n` in \sqrt[n]{x}. */
function readOptional(latex: string, index: number): { body: string | null; next: number } {
  let i = index
  while (i < latex.length && /\s/.test(latex[i])) i++
  if (latex[i] !== "[") return { body: null, next: index }
  const close = latex.indexOf("]", i)
  if (close === -1) return { body: null, next: index }
  return { body: latex.slice(i + 1, close), next: close + 1 }
}

/**
 * Converts LaTeX into a flat list of OMML components. Structural constructs (fractions,
 * radicals, scripts) become real equation objects; everything else accumulates into
 * MathRun text with LaTeX symbols mapped to their Unicode equivalents.
 */
function parseLatex(latex: string): MathChild[] {
  const children: MathChild[] = []
  let buffer = ""

  const flush = () => {
    if (buffer.trim()) children.push(new MathRun(buffer.replace(/\s+/g, " ").trim()))
    buffer = ""
  }

  // Scripts attach to whatever came immediately before them. Prefer the pending text buffer's
  // last token; fall back to the previous structural component.
  const takeBase = (): MathChild[] => {
    const trimmed = buffer.replace(/\s+$/, "")
    if (trimmed) {
      // A base is a single symbol, a parenthesised group, or a trailing word/number.
      const match = /(\)|\]|\}|[A-Za-z0-9π∞]+)$/.exec(trimmed)
      if (match) {
        buffer = trimmed.slice(0, trimmed.length - match[0].length)
        const base = match[0]
        flush()
        return [new MathRun(base)]
      }
    }
    flush()
    const previous = children.pop()
    return previous ? [previous] : [new MathRun("")]
  }

  let i = 0
  while (i < latex.length) {
    const char = latex[i]

    if (char === "\\") {
      const commandMatch = /^\\([a-zA-Z]+|.)/.exec(latex.slice(i))
      if (!commandMatch) { i++; continue }
      const command = commandMatch[1]
      i += commandMatch[0].length

      if (command === "frac" || command === "dfrac" || command === "tfrac") {
        const numerator = readGroup(latex, i)
        const denominator = readGroup(latex, numerator.next)
        i = denominator.next
        flush()
        children.push(new MathFraction({
          numerator: parseLatex(numerator.body),
          denominator: parseLatex(denominator.body),
        }))
        continue
      }

      if (command === "sqrt") {
        const degree = readOptional(latex, i)
        const radicand = readGroup(latex, degree.next)
        i = radicand.next
        flush()
        children.push(new MathRadical({
          children: parseLatex(radicand.body),
          ...(degree.body ? { degree: parseLatex(degree.body) } : {}),
        }))
        continue
      }

      if (UNWRAP.has(command)) {
        const group = readGroup(latex, i)
        i = group.next
        buffer += group.body.replace(/[{}]/g, "")
        continue
      }

      // \left( and \right) only signal delimiter sizing; keep the bracket itself.
      if (command === "left" || command === "right") {
        const group = readGroup(latex, i)
        i = group.next
        if (group.body !== "." && !group.body.startsWith("\\")) buffer += group.body
        continue
      }

      if (SPACERS.has(command)) { buffer += " "; continue }
      if (FUNCTIONS.has(command)) { buffer += command; continue }
      if (SYMBOLS[command]) { buffer += SYMBOLS[command]; continue }
      if (command === "%" || command === "$" || command === "&" || command === "#" || command === "_") {
        buffer += command
        continue
      }
      // Unknown command: keep its name so no information is silently lost.
      buffer += command
      continue
    }

    if (char === "^" || char === "_") {
      const group = readGroup(latex, i + 1)
      i = group.next
      const base = takeBase()
      const script = parseLatex(group.body)
      children.push(char === "^"
        ? new MathSuperScript({ children: base, superScript: script })
        : new MathSubScript({ children: base, subScript: script }))
      continue
    }

    if (char === "{" || char === "}") { i++; continue }

    buffer += char
    i++
  }

  flush()
  return children.length ? children : [new MathRun("")]
}

/**
 * Replaces LaTeX symbol commands with Unicode inside ordinary prose. Used as a safety net
 * for stray commands that appear outside any math delimiter.
 */
export function normalizeMathInProse(text: string): string {
  let output = text
  for (const [command, glyph] of Object.entries(SYMBOLS)) {
    output = output.replace(new RegExp(`\\\\${command}(?![a-zA-Z])`, "g"), glyph)
  }
  for (const name of FUNCTIONS) {
    output = output.replace(new RegExp(`\\\\${name}(?![a-zA-Z])`, "g"), name)
  }
  return output
    .replace(/\\left\s*/g, "")
    .replace(/\\right\s*/g, "")
    .replace(/\\[,;:!]/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\s{2,}/g, " ")
}

type Segment = { type: "text"; value: string } | { type: "math"; value: string }

// Matches <math>..</math> tags plus the inline/display LaTeX delimiters models emit
// unprompted: \(..\), \[..\], $$..$$ and $..$.
const MATH_PATTERN = /<math>([\s\S]*?)<\/math>|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\$([^$\n]+?)\$/g

export function segmentMath(text: string): Segment[] {
  const segments: Segment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  MATH_PATTERN.lastIndex = 0
  while ((match = MATH_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, match.index) })
    }
    const body = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? ""
    if (body.trim()) segments.push({ type: "math", value: body.trim() })
    lastIndex = MATH_PATTERN.lastIndex
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) })
  }
  return segments
}

/**
 * Decides whether a formula is simple enough to read as inline text. Short expressions with
 * no structural LaTeX (fractions, radicals, scripts) look better as normal prose than as an
 * equation object, which Word renders in a different typeface.
 */
function isTriviallyInline(latex: string): boolean {
  if (/\\(frac|dfrac|tfrac|sqrt|sum|int|prod|binom|over)/.test(latex)) return false
  if (/[\^_]/.test(latex)) return false
  return normalizeMathInProse(latex).length <= 24
}

export type RunStyle = {
  font: string
  size: number
  bold?: boolean
  color?: string
  underline?: boolean
}

/**
 * Builds paragraph children for a note line, emitting native Word equations for formula
 * spans and styled text runs for everything else.
 */
export function buildRichRuns(text: string, style: RunStyle): (TextRun | DocxMath)[] {
  const runs: (TextRun | DocxMath)[] = []

  const pushText = (value: string) => {
    if (!value) return
    runs.push(new TextRun({
      text: value,
      font: style.font,
      size: style.size,
      bold: style.bold,
      color: style.color,
      ...(style.underline ? { underline: {} } : {}),
    }))
  }

  for (const segment of segmentMath(text)) {
    if (segment.type === "text") {
      pushText(normalizeMathInProse(segment.value))
      continue
    }
    if (isTriviallyInline(segment.value)) {
      pushText(normalizeMathInProse(segment.value))
      continue
    }
    try {
      runs.push(new DocxMath({ children: parseLatex(segment.value) }))
    } catch {
      // Never let an unparseable formula cost the reader the content itself.
      pushText(normalizeMathInProse(segment.value))
    }
  }

  if (!runs.length) pushText(" ")
  return runs
}
