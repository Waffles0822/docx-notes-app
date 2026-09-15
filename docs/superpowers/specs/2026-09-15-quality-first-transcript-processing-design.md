# Quality-First Transcript Processing Design

## Goal

Prevent maximum-input-token failures and reduce API cost for very long transcripts while preserving the current note depth, requested page behavior, grounded HTML output, progress flow, and export integrations.

## Current problem

The application already creates background jobs for page allocations, but each job can send the full transcript as context in addition to its focus excerpt. This repeats the same large input across requests. Provider-specific single-request paths also use character-based truncation, which can discard the middle of a transcript. Expansion requests can resend broad context even when only one section needs correction.

## Design principles

- Preserve quality and completeness before optimizing token count.
- Never silently discard the middle of a long transcript.
- Keep short transcripts on the existing simple path.
- Use token budgets instead of character limits for model requests.
- Keep raw transcript material grounded and traceable through every stage.
- Make each stage independently retryable.
- Preserve existing public API routes, UI contracts, output HTML, and export behavior.

## Architecture

### Short-transcript path

Transcripts that fit safely within the selected provider's request budget continue through the existing direct generation path. Whitespace normalization and token estimation may be applied, but no intermediate summarization is required.

### Long-transcript path

Long transcripts use a hierarchical pipeline:

1. Normalize the extracted transcript without changing meaningful text.
2. Split the complete transcript into ordered, token-bounded chunks at sentence or paragraph boundaries when possible.
3. Include a small overlap or neighboring context window so definitions and transitions crossing boundaries remain understandable.
4. Generate a compact factual intermediate summary for each chunk, retaining concepts, definitions, examples, equations, relationships, conditions, and administrative details.
5. Extract announcements and logistics into a separately labeled intermediate collection.
6. Build a bounded synthesis input from the intermediate summaries, preserving source order and chunk metadata.
7. Generate the existing structured HTML notes with the current quality model and output rules.
8. Validate, merge, and export using the existing downstream flow.

The final synthesis receives summaries rather than the entire raw transcript. It may receive selected source excerpts for verification when a summary contains formulas, ambiguous wording, or other high-risk details.

## Component responsibilities

### Transcript preparation

Add focused utilities for whitespace normalization, approximate token counting, boundary-aware splitting, overlap management, and request-budget calculation. These utilities must preserve every source segment and expose chunk indexes and source ranges for logging and retries.

### Intermediate summarization

Add a provider-neutral operation that accepts one transcript chunk and returns structured, grounded source material. The internal representation should distinguish lecture facts from announcements and retain enough detail for final explanations rather than producing a terse topic list.

### Synthesis

Add a provider-neutral operation that accepts ordered intermediate material and the requested page allocation. It must reuse the current system requirements for third-person writing, no invention, deep nesting, formulas, deduplication, and HTML-only output.

### Background jobs

Extend existing job metadata only as needed to identify processing stage, chunk position, source version, and retry state. Existing status polling and progress callbacks remain compatible. A failed intermediate chunk is retried independently; successful chunks are not regenerated.

### Expansion

Expansion uses the intermediate material and the section's allocation context instead of resending the full transcript. Expansion remains bounded by the existing retry policy and runs only when the section is genuinely short or truncated and additional source material exists.

### Cost and observability

Record estimated input tokens, estimated output tokens, model, stage, chunk count, retry count, and duration. Add environment-configurable model choices for intermediate summarization and final synthesis. Caching is keyed by transcript hash, chunk boundaries, prompt version, and model so stale summaries are not reused after relevant changes.

## Provider strategy

The current quality model remains the default final synthesis model. A configurable lower-cost model may perform intermediate summarization for long transcripts. Provider adapters retain their existing error handling and response normalization. If a provider cannot support the hierarchical path, the service uses a safe provider-specific fallback with complete chunking rather than middle truncation where its context budget permits.

## Quality safeguards

- Every chunk has a source index and is included exactly once in the intermediate pipeline.
- Chunk overlap is context only and must not cause duplicate final facts.
- Announcement extraction is merged globally so the `Reminder` heading appears only once.
- Final synthesis performs cross-chunk deduplication and preserves first-occurrence ordering.
- Formulas, dates, figures, examples, and named entities receive preservation checks.
- Generated HTML is validated before export; malformed or empty output follows the existing error path.
- The direct path remains available for short inputs to avoid unnecessary cost and latency.

## Configuration

Introduce configuration for:

- Direct-path maximum input budget.
- Long-path chunk input budget.
- Chunk overlap size.
- Intermediate summarization model.
- Final synthesis model.
- Maximum intermediate and synthesis output budgets.
- Cache enablement and retention behavior.
- Processing mode defaults, with quality-first behavior as the default.

Configuration must have conservative defaults so deployments without new environment variables continue functioning.

## Testing strategy

Add unit tests for token estimates, boundary-aware chunking, complete source coverage, overlap metadata, deduplication inputs, and budget calculations. Add integration-level tests for direct and hierarchical paths, retrying one failed chunk, announcement consolidation, formula preservation, expansion without full-transcript resend, and cache invalidation. Run existing note-length and upload tests unchanged. Verify DOCX and Google Docs exports against representative generated HTML.

## Rollout sequence

1. Add measurement and token-aware preparation without changing short-transcript output.
2. Route long inputs through complete chunking and intermediate summaries.
3. Add final synthesis and preserve existing background progress semantics.
4. Update expansion and retries to use stage-specific material.
5. Add caching, model-tier configuration, processing modes, and cost reporting.
6. Compare quality, token estimates, latency, and failure rates on short, medium, and very long fixtures before making the hierarchical path the default for all inputs above the safe budget.

## Non-goals

- Redesigning the user interface.
- Changing the requested page/depth semantics.
- Replacing DOCX or Google Docs export.
- Intentionally shortening notes to reduce cost.
- Adding retrieval infrastructure or external databases.
- Changing the grounding policy or allowing general-knowledge supplementation.
