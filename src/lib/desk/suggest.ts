/**
 * A suggested case for a tray document (migration 235, design 035 D12):
 * Jev picks which candidate the document most likely belongs to. ADVICE
 * ONLY: this module never files, links, messages or changes a stage, and
 * the Tray tab never pre-selects what it says; a person chooses and
 * files.
 *
 * No suggestion (with the reason) when the insights layer is not
 * available for the workspace ('off'), the call fails ('failed'), Jev
 * cannot tell or is under 60% sure ('unsure'), or the runner-up is within
 * 10 points ('tie': equal matches are listed with none suggested).
 * Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { insightsAvailable } from '@/lib/insights/settings';
import { getDecisionLayer } from '@/lib/typesafe';
import type { DeskCaseJudgment } from '@/lib/typesafe/checks/desk-case';

export const SUGGEST_MIN_P = 0.6;
export const SUGGEST_MIN_MARGIN = 0.1;

export type TraySuggestion =
  | { status: 'suggested'; caseId: string; p: number }
  | { status: 'off' | 'failed' | 'unsure' | 'tie' };

interface SuggestInput {
  kind: string | null;
  mime: string | null;
  caption: string | null;
  original_name: string | null;
  candidates: {
    case_id: string;
    bank_code: string;
    product: string | null;
    missing: string[];
  }[];
}

/** Maps a judgment onto the candidates: pure, so the rules are tested. */
export function readJudgment(
  judgment: DeskCaseJudgment,
  caseIds: string[]
): TraySuggestion {
  if (!judgment.ok) return { status: 'failed' };
  if (judgment.index === null || judgment.p < SUGGEST_MIN_P)
    return { status: 'unsure' };
  if (judgment.p - judgment.pRunnerUp < SUGGEST_MIN_MARGIN)
    return { status: 'tie' };
  const caseId = caseIds[judgment.index];
  return caseId
    ? { status: 'suggested', caseId, p: judgment.p }
    : { status: 'failed' };
}

/**
 * Reads what the actor may see of the tray item (SQL refuses anyone who
 * may not sort it), then asks Jev. Refusals from the SQL propagate (the
 * route maps them); everything after them never throws.
 */
export async function suggestTrayCase(
  db: Pick<SupabaseClient, 'rpc'>,
  actor: string,
  account: string,
  trayId: string,
  deps: {
    available?: (accountId: string) => boolean;
    judge?: (
      input: Parameters<
        NonNullable<ReturnType<typeof getDecisionLayer>>['deskCase']
      >[0]
    ) => Promise<DeskCaseJudgment>;
  } = {}
): Promise<{ input: SuggestInput; suggestion: TraySuggestion }> {
  const { data, error } = await db.rpc('desk_tray_suggest_input', {
    p_actor: actor,
    p_account: account,
    p_tray: trayId,
  });
  if (error) throw error;
  const input = (data ?? { candidates: [] }) as SuggestInput;
  const available = deps.available ?? insightsAvailable;
  if (!available(account) || input.candidates.length === 0)
    return { input, suggestion: { status: 'off' } };
  try {
    const judge = deps.judge ?? ((x) => getDecisionLayer()!.deskCase(x));
    const judgment = await judge({
      accountId: account,
      kind: input.kind,
      mime: input.mime,
      fileName: input.original_name,
      caption: input.caption,
      candidates: input.candidates.map((c) => ({
        bank: c.bank_code,
        product: c.product,
        stillNeeds: Array.isArray(c.missing) ? c.missing : [],
      })),
    });
    return {
      input,
      suggestion: readJudgment(
        judgment,
        input.candidates.map((c) => c.case_id)
      ),
    };
  } catch {
    return { input, suggestion: { status: 'failed' } };
  }
}
