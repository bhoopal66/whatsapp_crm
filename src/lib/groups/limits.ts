// ============================================================
// WhatsApp groups — limits shared by the routes and the browser.
// No imports (not even a comment naming a Node module): client components read these, and anything that reaches
// ./server (next/server, node:dns) must stay out of the client bundle.
// ============================================================

export const ICON_TYPES = ['image/jpeg', 'image/png'] as const;
export const ICON_MAX_BYTES = 2 * 1024 * 1024;
export const INVITE_MESSAGE_MAX = 1000;

/**
 * Anti-ban pacing for adding people. Whapi warns that WhatsApp's
 * anti-spam rules refuse some adds and that mass-adding is what gets a
 * number restricted
 * (https://support.whapi.cloud/help-desk/groups/add-new-member-to-group);
 * it publishes no exact figures, so these are this CRM's conservative
 * choice: a handful per call, a pause between calls, and a ceiling per
 * operation. Anyone past the ceiling should get the invite link instead.
 */
export const GROUP_ADD_POLICY = {
  batchSize: 5,
  pauseMs: 3_000,
  maxPerOperation: 50,
} as const;
