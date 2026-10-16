// ============================================================
// WhatsApp groups — limits shared by the routes and the browser.
// No imports: client components read these, and anything that reaches
// ./server (next/server, node:dns) must stay out of the client bundle.
// ============================================================

export const ICON_TYPES = ['image/jpeg', 'image/png'] as const;
export const ICON_MAX_BYTES = 2 * 1024 * 1024;
export const INVITE_MESSAGE_MAX = 1000;
