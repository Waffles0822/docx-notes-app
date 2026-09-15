# Quality-First Transcript Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent long-transcript input-token failures and reduce repeated API input while preserving current note quality, page targets, HTML output, progress behavior, and exports.

**Architecture:** Keep the current direct provider path for short transcripts. For long OpenAI jobs, replace full-transcript repetition with complete token-aware allocation excerpts, then use compact source summaries and bounded final synthesis material. Keep job polling and export routes compatible.

**Tech Stack:** Next.js 16, TypeScript, OpenAI Responses API, Node test runner, existing DOCX and Google Docs generators.

**Spec:** `docs/superpowers/specs/2026-09-15-quality-first-transcript-processing-design.md`

## Global Constraints

- Preserve the existing HTML note structure and grounding instructions.
- Preserve requested page/depth semantics and current export contracts.
- Never silently discard the middle of a transcript.
- Keep short transcripts on the direct path.
- Use conservative defaults for new configuration.

### Task 1: Add token-aware transcript preparation utilities

**Files:**
- Modify: `src/lib/ai-service.ts`
- Test: `tests/note-length.test.mjs`

- [ ] Add exported helpers for approximate token count and complete boundary-aware chunking with source indexes and overlap metadata.
- [ ] Ensure chunks cover every source word and do not use character truncation.
- [ ] Add tests for complete coverage, ordering, no-middle-loss behavior, and token budget bounds.
- [ ] Run `npm test`.

### Task 2: Remove repeated full-transcript context from background jobs

**Files:**
- Modify: `src/lib/ai-service.ts`
- Modify: `src/app/api/status/route.ts`
- Modify: `tests/note-length.test.mjs`

- [ ] Change background submission input to carry only the allocation excerpt plus bounded neighboring context and source metadata.
- [ ] Preserve the existing allocation, grounding, announcement, and deep-nesting instructions.
- [ ] Keep legacy queued-job retry compatibility by recovering and replaying the stored request input.
- [ ] Update tests to assert no full transcript is repeated while all focus allocations remain represented.
- [ ] Run `npm test`.

### Task 3: Add hierarchical intermediate summaries for oversized transcripts

**Files:**
- Modify: `src/lib/ai-service.ts`
- Modify: `src/app/api/upload/route.ts`
- Modify: `src/app/api/import/gdocs/route.ts`
- Modify: `src/components/FileUpload.tsx`
- Test: `tests/note-length.test.mjs`

- [ ] Add a long-input path that submits bounded factual chunk-summary requests before final note allocation generation.
- [ ] Preserve lecture facts and announcements in the intermediate representation, including formulas, dates, figures, examples, and conditions.
- [ ] Keep direct generation for inputs that fit the safe provider budget.
- [ ] Extend job metadata and status progress without breaking current client validation.
- [ ] Add mocked tests for long-path routing, summary failure isolation, ordering, and announcement consolidation.
- [ ] Run `npm test` and `npm run lint`.

### Task 4: Make expansion stage-specific and configurable

**Files:**
- Modify: `src/lib/ai-service.ts`
- Modify: `.env.example`
- Modify: `src/app/api/status/route.ts`
- Test: `tests/note-length.test.mjs`

- [ ] Make expansion reuse bounded intermediate/source material instead of the full transcript.
- [ ] Add environment defaults for intermediate and final models, budgets, chunk size, overlap, and long-path threshold.
- [ ] Preserve the existing maximum expansion and retry limits.
- [ ] Test that a correction request contains no full-transcript resend and only the affected job is replaced.
- [ ] Run `npm test`, `npm run lint`, and `npm run build`.

### Task 5: Add observability and safe validation

**Files:**
- Modify: `src/lib/ai-service.ts`
- Modify: `src/app/api/status/route.ts`
- Test: `tests/note-length.test.mjs`

- [ ] Log or attach estimated input/output tokens, model, stage, chunk count, retries, and duration without logging transcript contents.
- [ ] Validate intermediate and final outputs for non-empty grounded content and valid HTML before export.
- [ ] Add tests for malformed responses, empty summaries, provider fallback, and cache-key/version behavior if caching is enabled in this iteration.
- [ ] Run the full verification suite.

### Task 6: Verify rollout and compatibility

**Files:**
- Modify: `README.md`
- Test: `tests/note-length.test.mjs`

- [ ] Document the new environment variables and quality-first long-transcript behavior.
- [ ] Test short, medium, and very long fixtures, including announcements, formulas, repeated facts, and exports.
- [ ] Confirm existing upload, note-length, DOCX, and Google Docs tests remain green.
- [ ] Review the diff for accidental UI or output-contract changes.

