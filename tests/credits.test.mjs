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
