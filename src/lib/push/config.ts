/**
 * VAPID keys for web push, read on every call so a restart with new
 * values is all a change takes. Any of the three unset means push is
 * off: the routes answer 503 push_not_configured and the dispatcher
 * leaves the outbox alone.
 */
export interface PushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function pushConfig(): PushConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}
