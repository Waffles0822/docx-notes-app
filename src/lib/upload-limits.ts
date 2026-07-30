// Vercel serverless functions reject request bodies above roughly 4.5 MB before any
// application code runs, which would surface as an opaque platform error. Staying under
// that ceiling keeps rejection inside our own validation, where the message is useful.
// Transcripts are plain text, so this is far more room than a class transcript needs.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024
export const MAX_UPLOAD_LABEL = "4 MB"
