import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { advisorDecisionsFor } from '@/lib/journeys/host/advisor';
import type { AdvisorDecision } from '@/lib/journeys/types';
import {
  WORKFLOWS,
  fail,
  isRecord,
  isUuid,
  runJourneyEvent,
} from '../../run-event';

export const maxDuration = 60;

/**
 * An advisor's decision on a journey file (module 016), e.g. QUOTE_READY
 * or CLOSE. Body `{ decision, reasonCode?, validUntil? }`; CLOSE needs a
 * `reasonCode`. Only decisions the file's state handles are accepted
 * (`advisorDecisionsFor`). The file is read with the caller's RLS client,
 * so an agent acts only on journeys of customers they can see; the event
 * then runs on the service-role runner (the files are its alone).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const { supabase, userId, accountId } = await requireRole('agent');
    const { fileId } = await params;
    if (!isUuid(fileId)) return fail(404, 'Journey not found');

    const body: unknown = await request.json().catch(() => null);
    if (!isRecord(body) || typeof body.decision !== 'string')
      return fail(400, 'decision is required');
    const { decision, reasonCode, validUntil } = body;
    if (
      reasonCode !== undefined &&
      reasonCode !== null &&
      (typeof reasonCode !== 'string' || reasonCode.trim().length > 100)
    )
      return fail(400, 'reasonCode must be text of at most 100 characters');
    if (
      validUntil !== undefined &&
      validUntil !== null &&
      (typeof validUntil !== 'string' || Number.isNaN(Date.parse(validUntil)))
    )
      return fail(400, 'validUntil must be an ISO date-time');

    const { data, error } = await supabase
      .from('journey_files')
      .select('id, state, workflow_key, outcome:body->outcome')
      .eq('id', fileId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw new Error(`journey_files: ${error.message}`);
    const file = data as {
      state: string;
      workflow_key: string;
      outcome: { kind: string; reason: string } | null;
    } | null;
    if (!file) return fail(404, 'Journey not found');
    const def = WORKFLOWS[file.workflow_key];
    if (!def)
      return fail(
        409,
        `Journey uses an unknown workflow (${file.workflow_key})`,
        'UNKNOWN_WORKFLOW'
      );

    const allowed = advisorDecisionsFor(
      def,
      file.state,
      file.outcome?.kind === 'PARKED' ? file.outcome.reason : null
    );
    if (!allowed.includes(decision as AdvisorDecision))
      return fail(
        400,
        `${decision} is not available while the journey is in ${file.state}`,
        'DECISION_NOT_AVAILABLE'
      );
    const reason = typeof reasonCode === 'string' ? reasonCode.trim() : '';
    if (decision === 'CLOSE' && !reason)
      return fail(400, 'Closing a journey needs a reason', 'REASON_REQUIRED');

    return await runJourneyEvent(supabaseAdmin(), def, fileId, {
      type: 'ADVISOR',
      decision: decision as AdvisorDecision,
      ...(reason ? { reasonCode: reason } : {}),
      ...(typeof validUntil === 'string'
        ? { validUntil: new Date(validUntil).toISOString() }
        : {}),
      at: new Date().toISOString(),
      by: userId,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
