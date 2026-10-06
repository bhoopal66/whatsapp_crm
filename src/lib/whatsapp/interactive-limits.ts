/**
 * Limits enforced locally so a misconfigured Flow fails when it is
 * saved rather than mid-conversation with a live customer.
 *
 * These mirror WhatsApp's own client-side limits, which Whapi passes
 * through unchanged — they are a property of WhatsApp, not of the
 * gateway, so they survived the Meta → Whapi move intact.
 *
 * Lives in its own dependency-free module because the interactive
 * builder (a client component) needs it: importing it from
 * `whapi-api.ts` dragged the gateway client — and, through the SSRF
 * guard, `node:dns` — into the browser bundle, which fails the build.
 */
export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const
