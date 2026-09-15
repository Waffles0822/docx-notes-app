import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import ts from "typescript"
import vm from "node:vm"

const loaded = { exports: {} }
vm.runInNewContext(ts.transpileModule(readFileSync("src/lib/credits.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: loaded, exports: loaded.exports, process })
const { calculateRemainingCredits } = loaded.exports

test("calculates remaining credits from starting credits and reported spend", () => {
  assert.equal(calculateRemainingCredits(4.96, 0.82), 4.14)
})

test("never displays a negative remaining credit balance", () => {
  assert.equal(calculateRemainingCredits(4.96, 6), 0)
})

test("uses a smaller context window when an allocation has clean boundaries", async () => {
  const { getAdaptiveContextWords } = loaded.exports
  assert.equal(getAdaptiveContextWords("A complete sentence.\n\nAnother complete sentence."), 80)
  assert.equal(getAdaptiveContextWords("An unfinished sentence"), 180)
})

test("summarizes daily and total costs from OpenAI cost buckets", () => {
  const { summarizeCosts } = loaded.exports
  const result = summarizeCosts([
    { start_time: 1, results: [{ amount: { value: 0.8 } }] },
    { start_time: Math.floor(Date.now() / 1000), results: [{ amount: { value: 0.12 } }] },
  ])
  assert.equal(result.total, 0.92)
  assert.equal(result.today, 0.12)
})

test("estimates a document cost from input, cached, and output tokens", () => {
  const { estimateDocumentCost } = loaded.exports
  assert.equal(estimateDocumentCost({ input: 1_000_000, cached: 500_000, output: 1_000_000 }, { input: 2, cached: 0.5, output: 8 }), 10.25)
})
