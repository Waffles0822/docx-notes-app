This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

Create `.env.local` with an OpenAI API key before processing documents. The defaults
use the cost-focused Luna model with no reasoning tokens for this extraction workflow:

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=your_openai_api_key_here
# Optional overrides
OPENAI_MODEL=gpt-5.6-luna
OPENAI_REASONING_EFFORT=none
```

Gemini remains available by setting `AI_PROVIDER=gemini` and adding `GEMINI_API_KEY`.

### Document context diagnostics

Every background section logs a safe context manifest containing the section number,
context strategy, source/focus/reference character counts, and estimated input tokens.
The same manifest is returned with each generation job and attached to the AI
provider request where supported.

Multi-section OpenAI runs place the stable document reference before each changing
focus section and use an explicit 30-minute prompt-cache breakpoint. Completion logs
include input, cache-write, cached-input, output, and total token counts so cache
effectiveness can be verified without logging document contents.

To log the exact model input for every section while debugging locally, add:

```bash
AI_CONTEXT_DEBUG=full
```

Exact inputs can contain the complete uploaded document. Do not enable full context
logging in production or anywhere logs are retained or shared.

DOCX manual page breaks and Word-saved rendered page breaks are preserved as strict
`SOURCE PAGE` boundaries. Form-feed characters provide the equivalent boundary in
plain-text uploads. Each detected source page receives its own processing job (up to
the 80-page application limit), while wider document context is used only for wording
and terminology consistency—not as a source of page-local facts.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
