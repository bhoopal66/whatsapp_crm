// ============================================================
// Typed answers to buttons and lists — the gated half.
//
// The Flows engine calls this when a run waits on a `send_buttons` /
// `send_list` node and the customer typed text instead of tapping.
//
//   * Where the menu went out as numbered text (`menuSentAsText`, OpenWA:
//     no buttons exist), the deterministic label/number match runs first
//     and ungated: the number is the only way to answer there, so it must
//     not depend on a Smart insights switch.
//   * Everything else is gated like meaning triggers
//     (lib/insights/meaning.ts): Jev must be available for the account and
//     its Smart insights `meaningTriggersEnabled` switch on. Otherwise
//     nothing is matched, not even a label, and the flow's fallback runs
//     exactly as before. The meaning step stays behind the gate on OpenWA
//     too.
//   * Label, then number (typed-reply.ts, no Jev), then meaning: one Jev
//     request accepted only when it picks an option, not `none`, with
//     p >= TYPED_REPLY_MIN_P.
//   * The meaning step delays the fallback, so it is bounded: a
//     TYPED_REPLY_DEADLINE_MS deadline, and texts longer than
//     TYPED_REPLY_MAX_JUDGED_CHARS (a free-form question, not an answer)
//     are not sent at all.
//   * Never throws; any failure is "no match".
// ============================================================

import { getDecisionLayer } from '@/lib/typesafe';
import { getInsightSettings, insightsAvailable } from '@/lib/insights/settings';
import {
  matchTypedReply,
  replyOptionsForNode,
  type ReplyOption,
} from './typed-reply';

/**
 * P a meaning match needs. Uncalibrated: chosen to equal the Balanced
 * meaning-trigger sensitivity until real traffic says otherwise.
 */
export const TYPED_REPLY_MIN_P = 0.75;

/** Hard deadline for the meaning step, retries included. */
export const TYPED_REPLY_DEADLINE_MS = 1200;

/** Longer texts skip the meaning step (label and number still run). */
export const TYPED_REPLY_MAX_JUDGED_CHARS = 160;

export type TypedReplyResolution =
  | { option: ReplyOption; by: 'label' | 'number' }
  | { option: ReplyOption; by: 'meaning'; p: number };

export async function resolveTypedReply(input: {
  accountId: string;
  node: { node_type: string; config: Record<string, unknown> };
  /** The node's body text as the customer saw it (vars interpolated). */
  prompt: string;
  text: string;
  /**
   * The menu was sent as numbered text (see `sendsMenusAsText`), so a
   * typed label or number is the answer itself, not a guess.
   */
  menuSentAsText?: boolean;
}): Promise<TypedReplyResolution | null> {
  try {
    const options = replyOptionsForNode(input.node);
    if (!options?.length || !input.text.trim()) return null;
    const quick = matchTypedReply(options, input.text);
    if (input.menuSentAsText && quick) {
      return { option: quick.option, by: quick.by };
    }
    if (!insightsAvailable(input.accountId)) return null;
    const settings = await getInsightSettings(input.accountId);
    if (!settings.meaningTriggersEnabled) return null;

    if (quick) return { option: quick.option, by: quick.by };

    if (input.text.trim().length > TYPED_REPLY_MAX_JUDGED_CHARS) return null;
    const ts = getDecisionLayer();
    if (!ts) return null;
    const res = await ts.replyOption({
      accountId: input.accountId,
      deadlineMs: TYPED_REPLY_DEADLINE_MS,
      prompt: input.prompt,
      message: input.text,
      options: options.map((o) => ({
        title: o.title,
        description: o.description,
      })),
    });
    if (!res.ok || res.index === null || res.p < TYPED_REPLY_MIN_P) return null;
    const option = options[res.index];
    return option ? { option, by: 'meaning', p: res.p } : null;
  } catch (err) {
    console.error(
      '[flows] typed reply match failed:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
