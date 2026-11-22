import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { cleanSubjectLabel } from '@/lib/voice-library/script';

/**
 * POST /api/voice-library/subjects  (agent and up)
 *
 * Body: { label } — a new subject for the whole workspace. Written with
 * the caller's client, so 242's policy decides.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const body: unknown = await request.json().catch(() => null);
    const label = cleanSubjectLabel(
      body && typeof body === 'object'
        ? (body as Record<string, unknown>).label
        : null
    );
    if (!label) {
      return NextResponse.json(
        { error: 'Give the subject a name of up to 60 characters.' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('voice_note_subjects')
      .insert({ account_id: accountId, label, created_by: userId })
      .select('id, label, created_by')
      .single();
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          {
            error: 'A subject with this name already exists.',
            code: 'duplicate',
          },
          { status: 409 }
        );
      }
      console.error('[voice-library] subject insert failed:', error.message);
      return NextResponse.json(
        { error: 'Could not add the subject.' },
        { status: 500 }
      );
    }
    return NextResponse.json({ subject: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
