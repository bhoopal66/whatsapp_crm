// ============================================================
// Why Meta failed a message it had already accepted.
//
// A Cloud API send answers 200 with a wamid; the verdict comes later,
// as a `failed` status receipt carrying `errors[0]`. Stored as-is, that
// is a bare numeric code on a broadcast recipient, and an operator who
// cannot tell "never retry this number" from "window closed, send a
// template" presses Retry failed — which, for the codes below, only
// fails again (every one of 155 blind retries did).
//
// `describeSendFailure` in provider.ts names the SYNCHRONOUS rejections
// (a thrown MetaError); this names the asynchronous ones, from a
// receipt. The two do not share codes in practice.
//
// Mirrored in SQL by `describe_meta_failure()` (migration 066), which
// the broadcast reconcile uses to fill the same reason in from the cost
// ledger. meta-failure.test.ts compares the two literally — change one,
// change both. No apostrophes in the wording: it is quoted in SQL.
// ============================================================

/** Operator-readable reasons for the async failure codes worth naming. */
export const META_FAILURE_REASONS: Readonly<Record<string, string>> = {
  '131049':
    'Meta is limiting marketing messages to this person to keep engagement healthy. Do not retry soon. (Meta 131049)',
  '131026':
    'Undeliverable: the number is not on WhatsApp, runs an old app version, or has not accepted the latest terms. (Meta 131026)',
  '130472':
    'Not delivered: the person is in a Meta marketing experiment that holds back some messages. (Meta 130472)',
  '131047':
    'The 24-hour service window is closed. Send an approved template instead. (Meta 131047)',
  '131031':
    'The WhatsApp Business Account is locked. Check WhatsApp Manager for restrictions or pending verification. (Meta 131031)',
};

/** What a failed receipt with no `errors[]` at all is recorded as. */
export const META_FAILURE_NO_REASON =
  'Meta reported the message as failed without giving a reason.';

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Turn a failed receipt's `errors[0]` into one line for the recipient
 * row. Known codes get a sentence that says what to do; anything else
 * keeps Meta's own words as `Meta <code>: <title>`, so the next unknown
 * code is still searchable rather than a bare number.
 */
export function describeMetaFailure(
  code?: number | string | null,
  title?: string | null,
  details?: string | null
): string {
  const c = code === null || code === undefined ? '' : String(code).trim();
  const known = c ? META_FAILURE_REASONS[c] : undefined;
  if (known) return known;

  const what = clean(title) || clean(details);
  if (c && what) return `Meta ${c}: ${what}`;
  if (c) return `Meta ${c}`;
  if (what) return `Meta: ${what}`;
  return META_FAILURE_NO_REASON;
}
