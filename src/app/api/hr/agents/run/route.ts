import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { isUuid } from '@/lib/coordinators/errors';
import { runHrAgents, type HrAgentRunResult } from '@/lib/hr/agents/server';
import type { HrRoles } from '@/lib/hr/types';

export const maxDuration = 60;

/** At most this many interview slots, each 1..SLOT_MAX_CHARS once trimmed. */
const MAX_SLOTS = 5;
const SLOT_MAX_CHARS = 80;

function parseSlots(raw: unknown): string[] | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_SLOTS) return null;
  const slots: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    if (t.length < 1 || t.length > SLOT_MAX_CHARS) return null;
    slots.push(t);
  }
  return slots;
}

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

/** The HTTP answer for each runner outcome. */
function respond(result: HrAgentRunResult) {
  switch (result.outcome) {
    case 'drafted':
    case 'handoff':
      return NextResponse.json({
        outcome: result.outcome,
        draftId: result.draftId ?? null,
      });
    case 'opted_out':
      return NextResponse.json({ outcome: result.outcome });
    case 'off':
      return fail('agents_off', 409);
    case 'no_ai':
      return fail('ai_off', 409);
    case 'no_message':
      return fail('no_message', 409);
    case 'closed':
      return fail('closed', 409);
    case 'contact_opted_out':
      return fail('opted_out', 409);
    case 'cap':
      return fail('cap', 409);
    case 'refused':
      return fail((result.code ?? 'refused').toLowerCase(), 409);
    case 'not_tracked':
      return fail('not_found', 404);
    case 'not_recruiter':
      return fail('not_recruiter', 409);
    case 'error':
      return fail('failed', 502);
    default: {
      const never: never = result.outcome;
      return fail(`failed:${String(never)}`, 502);
    }
  }
}

/**
 * POST /api/hr/agents/run  (agent+, recruiter role)
 *
 * Body: { conversationId, slots? }
 * Returns: { outcome, draftId? }
 *
 * "Draft a reply" on a Recruiter HR chat. Drafts only: the runner stores
 * a draft a recruiter then approves or rejects, and nothing is sent.
 * Who may ask is decided as the caller (hr_my_roles, then the chat's
 * hr_conversations row through RLS, which uses hr_can_see); only then
 * does the service-role runner read the chat and spend the account's AI
 * key, with the caller recorded as the draft's creator.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const body = await request.json().catch(() => null);
    const conversationId =
      body && typeof body === 'object' ? body.conversationId : null;
    const slots = parseSlots(
      body && typeof body === 'object' ? body.slots : undefined
    );
    if (!isUuid(conversationId) || slots === null) return fail('invalid', 400);

    const { data: roles, error: rolesErr } = await supabase.rpc('hr_my_roles');
    if (rolesErr) {
      console.error('[hr/agents/run] hr_my_roles error:', rolesErr.message);
      return fail('failed', 500);
    }
    const r = roles as HrRoles | null;
    if (!r || (!r.admin && !r.recruiter)) return fail('forbidden', 403);

    // RLS (hr_can_see) decides whether the caller may see this chat.
    const { data: hrRow, error: hrErr } = await supabase
      .from('hr_conversations')
      .select('conversation_id')
      .eq('conversation_id', conversationId)
      .maybeSingle();
    if (hrErr) {
      console.error('[hr/agents/run] hr row lookup error:', hrErr.message);
      return fail('failed', 500);
    }
    if (!hrRow) return fail('not_found', 404);

    const result = await runHrAgents(supabaseAdmin(), {
      accountId,
      conversationId,
      actorUserId: userId,
      slots,
    });
    return respond(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
