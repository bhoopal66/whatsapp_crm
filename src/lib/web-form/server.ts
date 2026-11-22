/**
 * Server side of the public web form (migration 249): the two
 * service-role RPCs, behind small wrappers the route and the hosted page
 * share. Never import from a client component.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { CleanSubmission } from './submission';

export interface PublicFormConfig {
  allowedOrigins: string[];
}

/**
 * The form behind a token, or null when the token is unknown, the form
 * is off or its workspace is archived (indistinguishable on purpose).
 * Throws on a database error.
 */
export async function loadPublicForm(
  db: SupabaseClient,
  token: string
): Promise<PublicFormConfig | null> {
  const { data, error } = await db.rpc('web_form_public_config', {
    p_token: token,
  });
  if (error) throw new Error(`web_form_public_config: ${error.message}`);
  if (!data || typeof data !== 'object') return null;
  const origins = (data as { allowed_origins?: unknown }).allowed_origins;
  return {
    allowedOrigins: Array.isArray(origins)
      ? origins.filter((o): o is string => typeof o === 'string')
      : [],
  };
}

export type SubmitOutcome =
  | { status: 'ok'; taskCreated: boolean }
  | { status: 'not_found' }
  | { status: 'bad_phone' };

/** One submission through `web_form_submit`. Throws on any other error. */
export async function submitWebForm(
  db: SupabaseClient,
  token: string,
  value: CleanSubmission
): Promise<SubmitOutcome> {
  const { data, error } = await db.rpc('web_form_submit', {
    p_token: token,
    p_name: value.name,
    p_phone: value.phone,
    p_email: value.email,
    p_message: value.message,
    p_meta: value.pageUrl ? { page_url: value.pageUrl } : {},
  });
  if (error) {
    if ((error as { hint?: string }).hint === 'bad_phone') {
      return { status: 'bad_phone' };
    }
    throw new Error(`web_form_submit: ${error.message}`);
  }
  const row = (data ?? {}) as { status?: string; task_created?: boolean };
  if (row.status === 'ok') {
    return { status: 'ok', taskCreated: row.task_created === true };
  }
  return { status: 'not_found' };
}
