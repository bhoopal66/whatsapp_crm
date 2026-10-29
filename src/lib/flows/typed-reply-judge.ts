// ============================================================
// Typed answers to buttons and lists — the gated half.
//
// The Flows engine calls this when a run waits on a `send_buttons` /
// `send_list` node and the customer typed text instead of tapping.
//
//   * Gated like meaning triggers (lib/insights/meaning.ts): Jev must be
//     available for the account and its Smart insights
//     `meaningTriggersEnabled` switch on. Otherwise nothing is matched,
//     not even a label, and the flow's fallback runs exactly as before.
//   * Label, then number (typed-reply.ts, no Jev), then meaning: one Jev
//     request accepted only when it picks an option, not `none`, with
//     p >= TYPED_REPLY_MIN_P.
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

export type TypedReplyResolution =
  | { option: ReplyOption; by: 'label' | 'number' }
  | { option: ReplyOption; by: 'meaning'; p: number };

export async function resolveTypedReply(input: {
  accountId: string;
  node: { node_type: string; config: Record<string, unknown> };
  /** The node's body text as the customer saw it (vars interpolated). */
  prompt: string;
  text: string;
}): Promise<TypedReplyResolution | null> {
  try {
    const options = replyOptionsForNode(input.node);
    if (!options?.length || !input.text.trim()) return null;
    if (!insightsAvailable(input.accountId)) return null;
    const settings = await getInsightSettings(input.accountId);
    if (!settings.meaningTriggersEnabled) return null;

    const quick = matchTypedReply(options, input.text);
    if (quick) return { option: quick.option, by: quick.by };

    const ts = getDecisionLayer();
    if (!ts) return null;
    const res = await ts.replyOption({
      accountId: input.accountId,
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
