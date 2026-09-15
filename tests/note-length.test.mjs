import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve, dirname } from "node:path"
import vm from "node:vm"
import test from "node:test"
import ts from "typescript"

const require = createRequire(import.meta.url)

// Run the real TypeScript modules with an isolated, mocked provider; no API key
// or running Next server is needed for these generation lifecycle regressions.
function loadModule(file, dependencies = {}, globals = {}) {
  const filename = resolve(file)
  const loaded = { exports: {} }
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  vm.runInNewContext(code, {
    module: loaded, exports: loaded.exports, console, Response, AbortSignal, setTimeout, Buffer,
    require: name => dependencies[name] ?? (name.startsWith(".")
      ? loadModule(resolve(dirname(filename), `${name}.ts`), dependencies, globals)
      : require(name)),
    ...globals,
  }, { filename })
  return loaded.exports
}

const docx = loadModule("src/lib/docx-generator.ts")
const credits = loadModule("src/lib/credits.ts")
const notes = words => `<div class="notes"><section class="lecture"><h3>Topic</h3><ul><li>${Array(words - 1).fill("detail").join(" ")}</li></ul></section></div>`

function harness() {
  const submissions = []
  const statuses = new Map()
  const ai = loadModule("src/lib/ai-service.ts", {}, {
    process: { env: { OPENAI_API_KEY: "mock-only" } },
    fetch: async (_url, options) => {
      submissions.push(JSON.parse(options.body))
      return Response.json({ id: `resp_mock${submissions.length}` })
    },
  })
  let exports = 0
  const route = loadModule("src/app/api/status/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/ai-service": {
      ...ai,
      getBackgroundNoteStatus: async id => ({ id, status: "completed", ...statuses.get(id) }),
    },
    "@/lib/docx-generator": {
      ...docx,
      createNotesDocx: async () => { exports++; return Buffer.from("docx") },
    },
    "@/lib/credits": credits,
  }, { process: { env: {} } })
  return {
    ai, submissions, statuses, exportCount: () => exports,
    poll: (jobs, html = true, pageCount) => route.POST({ json: async () => ({ jobs, returnNotesHtml: html, pageCount }) }),
  }
}

test("24 requested pages use 12 two-page jobs without reducing the writing budget", async () => {
  const h = harness()
  const transcript = Array.from({ length: 12000 }, (_, i) => `source${i}`).join(" ")
  const jobs = await h.ai.startBackgroundNotes(transcript, 24)

  assert.equal(jobs.length, 12)
  assert.ok(jobs.every((job, index) => job.targetWords === 600
    && job.pageNumber === index + 1
    && job.pageSpan === 2))
  assert.equal(jobs.reduce((sum, job) => sum + job.targetWords, 0), 7200)
  assert.equal(h.submissions.length, 12)
})

test("an odd page target ends with one single-page job", async () => {
  const h = harness()
  const jobs = await h.ai.startBackgroundNotes(Array(13000).fill("source").join(" "), 25)

  assert.equal(jobs.length, 13)
  assert.deepEqual(Array.from(jobs, job => job.pageSpan), [...Array(12).fill(2), 1])
  assert.deepEqual(Array.from(jobs, job => job.targetWords), [...Array(12).fill(600), 300])
  assert.equal(jobs.reduce((sum, job) => sum + job.targetWords, 0), 7500)
})

test("two-page jobs preserve all requested content without forced page breaks", async () => {
  const h = harness()
  const jobs = await h.ai.startBackgroundNotes(Array(12000).fill("source").join(" "), 24)
  jobs.forEach((job, index) => {
    const first = notes(300).replace("Topic", `Topic${index * 2 + 1}`)
    const second = notes(300).replace("Topic", `Topic${index * 2 + 2}`)
    h.statuses.set(job.id, { notes: first + second })
  })

  const result = await (await h.poll(jobs, true, 24)).json()
  assert.equal(result.status, "completed")
  const paragraphs = docx.buildNoteParagraphs(result.notesHtml)
  assert.equal(docx.parseNotes(result.notesHtml).lecture.length, 24)
  assert.equal(paragraphs.filter(paragraph => paragraph.pageBreakBefore).length, 0)
})

test("allocation prompts restrict note content and classification to the focus excerpt", async () => {
  const h = harness()
  await h.ai.startBackgroundNotes(
    "The quiz is Friday. Photosynthesis converts light energy. Submit the worksheet Monday. Chlorophyll absorbs light.",
    4
  )

  assert.equal(h.submissions.length, 2)
  for (const request of h.submissions) {
    assert.match(request.input, /Only facts stated inside the FOCUS EXCERPT may appear in this allocation/i)
    assert.match(request.input, /first occurrence/i)
    assert.match(request.input, /deadlines?.*announcements|announcements.*deadlines?/i)
    assert.match(request.input, /subject matter.*lecture|lecture.*subject matter/i)
    assert.doesNotMatch(request.instructions, /Housekeeping and Course Adjustments/i)
  }
})

test("21-page request creates 11 writing tasks and rejects short drafts", async () => {
  const h = harness()
  const transcript = Array.from({ length: 18530 }, (_, i) => `word${i}${i % 20 === 19 ? "." : ""}`).join(" ")
  assert.equal(h.ai.estimateTranscript(transcript).recommendedPages, 21)
  let jobs = await h.ai.startBackgroundNotes(transcript, 21)
  assert.equal(jobs.length, 11)
  assert.equal(jobs.reduce((sum, job) => sum + job.targetWords, 0), 6300)
  // The full transcript is no longer repeated; primary allocations still cover it all.
  assert.ok(h.submissions.every(s => !s.input.includes(`TRANSCRIPT START\n${transcript}\nTRANSCRIPT END`)))
  const source = h.submissions.map(s => s.input.split("[PRIMARY ALLOCATION]\n")[1].split("\n\nFOCUS EXCERPT END")[0]).join(" ")
  const sourceWords = source.split(/\s+/)
  assert.equal(new Set(sourceWords.filter(word => /^word\d+\.?$/.test(word))).size, 18530)
  assert.ok(Array.from({ length: 18530 }, (_, index) => `word${index}${index % 20 === 19 ? "." : ""}`).every(word => source.includes(word)))
  for (let attempt = 0; attempt < 2; attempt++) {
    jobs.forEach(job => h.statuses.set(job.id, { notes: notes(40) }))
    const result = await (await h.poll(jobs)).json()
    assert.equal(result.status, "processing")
    jobs = result.jobs
    assert.ok(jobs.every(job => job.expansionAttempts === attempt + 1))
    assert.deepEqual(result.jobStatuses.map(job => job.id), jobs.map(job => job.id))
  }
  jobs.forEach(job => h.statuses.set(job.id, { notes: notes(40) }))
  for (const html of [true, false]) {
    const response = await h.poll(jobs, html)
    assert.equal(response.status, 422)
    assert.match((await response.json()).error, /40 words against a 600-word target/)
  }
  assert.equal(h.submissions.length, 33)
  assert.equal(h.exportCount(), 0)
})

test("a corrected draft meeting the threshold completes for both exports", async () => {
  const h = harness()
  const jobs = [{ id: "resp_good", targetWords: 1000, expanded: true, expansionAttempts: 2 }]
  h.statuses.set("resp_good", { notes: notes(800) })
  assert.equal((await (await h.poll(jobs)).json()).status, "completed")
  assert.equal((await h.poll(jobs, false)).status, 200)
  assert.equal(h.exportCount(), 1)
  assert.equal(h.submissions.length, 0)
})

test("a 599-word draft satisfies a 600-word paginated target", async () => {
  const h = harness()
  const jobs = [{ id: "resp_allowance", targetWords: 600, pageNumber: 1, pageSpan: 2, expanded: false }]
  h.statuses.set("resp_allowance", { notes: notes(599) })

  const result = await (await h.poll(jobs)).json()
  assert.equal(result.status, "completed")
  assert.equal(h.submissions.length, 0)
})

test("the exact 588-word allowance boundary satisfies a 600-word target", async () => {
  const h = harness()
  const jobs = [{ id: "resp_boundary", targetWords: 600, pageNumber: 1, pageSpan: 2, expanded: false }]
  h.statuses.set("resp_boundary", { notes: notes(588) })

  assert.equal((await (await h.poll(jobs)).json()).status, "completed")
  assert.equal(h.submissions.length, 0)
})

test("a draft below the two-percent allowance still triggers correction", async () => {
  const h = harness()
  const jobs = [{ id: "resp_too_short", targetWords: 600, pageNumber: 1, pageSpan: 2, expanded: false }]
  h.statuses.set("resp_too_short", { notes: notes(587) })

  const result = await (await h.poll(jobs)).json()
  assert.equal(result.status, "processing")
  assert.equal(result.jobs[0].expansionAttempts, 1)
  assert.equal(h.submissions.length, 1)
})

test("truncated replacements cannot export even when long enough", async () => {
  const h = harness()
  const jobs = [{ id: "resp_cut", targetWords: 1000, pageNumber: 1, pageSpan: 2, expanded: true, expansionAttempts: 2 }]
  h.statuses.set("resp_cut", { notes: notes(1100), truncated: true })
  const response = await h.poll(jobs)
  assert.equal(response.status, 422)
  assert.match((await response.json()).error, /still cut off/)
})

test("the legacy non-paginated threshold still corrects 799 of 1000 words", async () => {
  const h = harness()
  const jobs = [{ id: "resp_legacy_short", targetWords: 1000, expanded: false }]
  h.statuses.set("resp_legacy_short", { notes: notes(799) })

  assert.equal((await (await h.poll(jobs)).json()).status, "processing")
  assert.equal(h.submissions.length, 1)
})

test("unexportable text does not satisfy the length check", async () => {
  const h = harness()
  const jobs = [{ id: "resp_badhtml", targetWords: 1000, expanded: false }]
  h.statuses.set("resp_badhtml", { notes: `<p>${Array(1500).fill("detail").join(" ")}</p>` })
  const result = await (await h.poll(jobs)).json()
  assert.equal(result.status, "processing")
  assert.equal(result.jobs[0].expansionAttempts, 1)
})

test("legacy expanded jobs get one remaining correction", async () => {
  const h = harness()
  const jobs = [{ id: "resp_legacy", targetWords: 1000, expanded: true }]
  h.statuses.set("resp_legacy", { notes: notes(100) })
  const result = await (await h.poll(jobs)).json()
  assert.equal(result.jobs[0].expansionAttempts, 2)
})

test("invalid jobs are rejected instead of silently dropping sections", async () => {
  const h = harness()
  const response = await h.poll([
    { id: "resp_valid", targetWords: 1000, expanded: false },
    { id: "resp_invalid", targetWords: 1000, expanded: true, expansionAttempts: -1 },
  ])
  assert.equal(response.status, 400)
})

test("10-page length target retains 3000 words without forced boundaries in both exports", async () => {
  const h = harness()
  const jobs = await h.ai.startBackgroundNotes(Array(9000).fill("source").join(" "), 10)
  assert.equal(jobs.length, 5)
  assert.ok(jobs.every((job, i) => job.targetWords === 600 && job.pageNumber === i + 1 && job.pageSpan === 2))
  jobs.forEach((job, i) => h.statuses.set(job.id, {
    notes: notes(300).replace("Topic", `Topic${i * 2 + 1}`)
      + notes(300).replace("Topic", `Topic${i * 2 + 2}`),
  }))
  const result = await (await h.poll(jobs)).json()
  assert.equal(result.status, "completed")
  assert.equal(docx.parseNotes(result.notesHtml).lecture.length, 10)
  assert.equal(docx.buildNoteParagraphs(result.notesHtml).filter(p => p.text === "LECTURE").length, 1)
  const buffer = await docx.createNotesDocx(result.notesHtml)
  const zip = await require("jszip").loadAsync(buffer)
  const xml = await zip.file("word/document.xml").async("string")
  assert.equal((xml.match(/<w:pageBreakBefore(?:\s[^>]*)?\/>/g) || []).filter(tag => !tag.includes('w:val="false"')).length, 0)
  for (let i = 1; i <= 10; i++) assert.ok(xml.includes(`Topic${i}`))
  const googleDocs = loadModule("src/lib/google-docs.ts")
  const requests = googleDocs.buildDocRequests(result.notesHtml, "Test", "", 1)
  assert.equal(requests.filter(request => request.updateParagraphStyle?.paragraphStyle?.pageBreakBefore === true).length, 0)
  const pageBreakReset = requests.find(request => request.updateParagraphStyle?.range?.startIndex === 1
    && request.updateParagraphStyle?.paragraphStyle?.pageBreakBefore === false)
  assert.ok(pageBreakReset)
  assert.match(pageBreakReset.updateParagraphStyle.fields, /pageBreakBefore/)
  const inserted = requests.find(request => request.insertText).insertText.text
  assert.equal((inserted.match(/detail/g) || []).length, 2990)
})

test("page targets never shrink to match a short transcript", async () => {
  const h = harness()
  const jobs = await h.ai.startBackgroundNotes("One sentence about a topic.", 10)
  assert.equal(jobs.length, 5)
  assert.equal(jobs.reduce((sum, job) => sum + job.targetWords, 0), 3000)
})

test("258 words triggers correction of one allocation, not another full summary", async () => {
  const h = harness()
  let jobs = await h.ai.startBackgroundNotes(Array(9000).fill("source").join(" "), 10)
  jobs.forEach((job, i) => h.statuses.set(job.id, { notes: notes(i === 0 ? 258 : 600) }))
  const correction = await (await h.poll(jobs)).json()
  assert.equal(correction.status, "processing")
  assert.equal(h.submissions.length, 6)
  assert.match(h.submissions[5].input, /Write 600 to 648 visible words/)
  jobs = correction.jobs
  h.statuses.set(jobs[0].id, { notes: notes(600) })
  assert.equal((await (await h.poll(jobs)).json()).status, "completed")
})

test("multiple generated sections survive merging, including single-quoted HTML", () => {
  const h = harness()
  const html = notes(150) + notes(150).replaceAll('class="lecture"', "class='lecture'").replace("Topic", "Second")
  const merged = h.ai.mergeNoteSections([html])
  assert.equal(docx.parseNotes(merged).lecture.length, 2)
})

test("all 80 supported pages survive status validation", async () => {
  const h = harness()
  const jobs = await h.ai.startBackgroundNotes(Array(8000).fill("source").join(" "), 80)
  jobs.forEach((job, index) => h.statuses.set(job.id, {
    notes: notes(300).replace("Topic", `Topic${index * 2}`)
      + notes(300).replace("Topic", `Topic${index * 2 + 1}`),
  }))
  const result = await (await h.poll(jobs)).json()
  assert.equal(result.status, "completed")
  assert.equal(docx.parseNotes(result.notesHtml).lecture.length, 80)
})

test("allocations keep full context and the original deep outline instructions", async () => {
  const h = harness()
  const source = "An early definition establishes the symbol. A later example applies that same symbol."
  await h.ai.startBackgroundNotes(source, 10)
  for (const request of h.submissions) {
    assert.doesNotMatch(request.input, new RegExp(`TRANSCRIPT START\\n${source}\\nTRANSCRIPT END`))
    assert.match(request.input, /ONE continuous document/)
    assert.match(request.instructions, /three to four levels/)
    assert.doesNotMatch(request.input, /2-3 topic headings|exactly one page/)
  }
})

test("repeated topics combine under one lecture and one reminder with nested detail preserved", async () => {
  const wrap = content => `<article class="notes-page">${content}</article>`
  const announcement = detail => `<section class="announcements"><h3>Reminder</h3><ul><li>Exam<ul><li>${detail}</li></ul></li></ul></section>`
  const lecture = detail => `<section class="lecture"><h3>Shared Topic</h3><ul><li>Shared Parent<ul><li>${detail}<ul><li>Supporting ${detail}</li></ul></li></ul></li></ul></section>`
  const html = wrap(announcement("Friday") + lecture("Definition")) + wrap(announcement("Chapter 5") + lecture("Application"))
  const parsed = docx.parseNotes(html)
  assert.equal(parsed.announcements.length, 1)
  assert.equal(parsed.announcements[0].bullets.length, 1)
  assert.equal(parsed.announcements[0].bullets[0].children.length, 2)
  assert.equal(parsed.lecture.length, 1)
  assert.equal(parsed.lecture[0].bullets.length, 1)
  assert.equal(parsed.lecture[0].bullets[0].children.length, 2)
  assert.equal(parsed.lecture[0].bullets[0].children[1].children[0].text, "Supporting Application")
  const paragraphs = docx.buildNoteParagraphs(html)
  for (const label of ["ANNOUNCEMENTS", "LECTURE", "Reminder", "Shared Topic"]) {
    assert.equal(paragraphs.filter(p => p.text === label).length, 1)
  }
  const zip = await require("jszip").loadAsync(await docx.createNotesDocx(html))
  const xml = await zip.file("word/document.xml").async("string")
  assert.equal((xml.match(/>LECTURE</g) || []).length, 1)
  const googleDocs = loadModule("src/lib/google-docs.ts")
  const text = googleDocs.buildDocRequests(html, "", "", 1).find(r => r.insertText).insertText.text
  assert.equal((text.match(/^LECTURE$/gm) || []).length, 1)
  assert.ok(text.includes("Supporting Application"))
})

test("nested bullets use the historical circle hollow-circle square hierarchy in both exports", async () => {
  const html = `<div class="notes"><section class="lecture"><h3>Topic</h3><ul><li>Parent<ul><li>Child<ul><li>Grandchild</li></ul></li></ul></li></ul></section></div>`

  const zip = await require("jszip").loadAsync(await docx.createNotesDocx(html))
  const numberingXml = await zip.file("word/numbering.xml").async("string")
  const glyphs = Array.from(numberingXml.matchAll(/<w:lvlText w:val="([^"]+)"\/>/g), match => match[1])
  assert.ok(glyphs.some((glyph, index) => glyph === "◉"
    && glyphs[index + 1] === "○"
    && glyphs[index + 2] === "■"
    && glyphs[index + 3] === "◉"))

  const googleDocs = loadModule("src/lib/google-docs.ts")
  const requests = googleDocs.buildDocRequests(html, "", "", 1)
  const inserted = requests.find(request => request.insertText).insertText.text
  assert.ok(inserted.includes("Parent\n\tChild\n\t\tGrandchild\n"))
  assert.ok(requests.some(request => request.createParagraphBullets?.bulletPreset === "BULLET_DISC_CIRCLE_SQUARE"))
})
