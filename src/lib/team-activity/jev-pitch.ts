// ============================================================
// Jev's cold-pitch judgment for the hard restrictions (migration 204,
// spec S5). Reuses the compose check's `cold_pitch` question, asked as
// a start, whatever the account's compose-check mode says: the
// restriction has its own switch (enforce_jev), read by the SQL check.
//
// Fails open by contract: no TypeSafe, a gateway error, a model
// mismatch or the deadline all return null, and the message is sent.
// Only the redacted compose-check state leaves the server.
// ============================================================

import { getDecisionLayer } from '@/lib/typesafe';
import { insightsAvailable } from '@/lib/insights/settings';

/** The send waits at most this long for Jev. */
export const JEV_PITCH_DEADLINE_MS = 1500;

/** P(cold pitch) for a draft that would start a chat, or null. Never throws. */
export async function coldPitchProbability(
  accountId: string,
  text: string
): Promise<number | null> {
  try {
    if (!text.trim() || !insightsAvailable(accountId)) return null;
    const ts = getDecisionLayer();
    if (!ts) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), JEV_PITCH_DEADLINE_MS);
    });
    const judged = ts
      .composeCheck({
        accountId,
        draft: text,
        isStart: true,
        deadlineMs: JEV_PITCH_DEADLINE_MS,
      })
      .then((j) => {
        if (!j.ok) {
          if (j.errorCode !== 'DISABLED')
            console.warn(`[team-activity] Jev cold pitch: ${j.errorCode}`);
          return null;
        }
        const p = j.figures.cold_pitch;
        return typeof p === 'number' && Number.isFinite(p) ? p : null;
      })
      .catch((err: unknown) => {
        console.error(
          '[team-activity] Jev cold pitch failed:',
          err instanceof Error ? err.message : String(err)
        );
        return null;
      });
    try {
      return await Promise.race([judged, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error(
      '[team-activity] Jev cold pitch failed:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
