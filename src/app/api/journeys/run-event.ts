/**
 * Shared by the journey bot's REST routes (module 016): the workflow
 * registry, input guards, and one engine event run through the
 * service-role runner with its result mapped to a response.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createRunner, JourneyConflictError } from '@/lib/journeys/runner';
import type { WorkflowDef } from '@/lib/journeys/schema';
import type { JourneyEvent } from '@/lib/journeys/types';
import { SHIPPED_WORKFLOW } from '@/lib/journeys/workflow';
import { SupabaseConsentPort } from '@/lib/journeys/host/consent';
import { createJourneySink } from '@/lib/journeys/host/sink';
import { SupabaseJourneyStore } from '@/lib/journeys/host/store';
import { SHIPPED_WORKFLOW_KEY } from '@/lib/journeys/host/tick';

/** Workflow definitions by `journey_settings.workflow_key`. */
export const WORKFLOWS: Record<string, WorkflowDef> = {
  [SHIPPED_WORKFLOW_KEY]: SHIPPED_WORKFLOW,
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && UUID_RE.test(v);

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `{ error, code? }` with `status`. */
export const fail = (status: number, error: string, code?: string) =>
  NextResponse.json(code ? { error, code } : { error }, { status });

/**
 * Runs one engine event on `fileId` (id: a fresh uuid) and answers:
 * 200 `{ ...extra, state, outcome, warnings, error? }` — `error` is set
 * when the step was saved but delivering one of its actions failed (it
 * stays queued and the cron retries it); 400 `{ error, code }` when the
 * engine rejected the event; 404 when the file is gone; 409 when the
 * file kept changing under the runner. Anything else throws.
 */
export async function runJourneyEvent(
  db: SupabaseClient,
  def: WorkflowDef,
  fileId: string,
  event: JourneyEvent,
  extra: Record<string, unknown> = {}
): Promise<NextResponse> {
  const runner = createRunner({
    def,
    store: new SupabaseJourneyStore(db),
    consent: new SupabaseConsentPort(db),
    sink: createJourneySink({ db, def }),
  });
  let r;
  try {
    r = await runner.handle({ ...event, id: randomUUID(), fileId });
  } catch (err) {
    if (err instanceof JourneyConflictError)
      return fail(
        409,
        'The journey changed while saving; try again',
        'CONFLICT'
      );
    throw err;
  }
  switch (r.status) {
    case 'rejected':
      return fail(400, r.error.message, r.error.code);
    case 'not_found':
      return fail(404, 'Journey not found');
    case 'duplicate':
      return fail(409, 'This event was already processed', 'DUPLICATE');
    case 'ok': {
      const { file, warnings } = r.result;
      const { error } = r.drain;
      if (error)
        console.error(
          `[journeys] file ${fileId}: delivery failed after ${event.type}:`,
          error instanceof Error ? error.message : error
        );
      return NextResponse.json({
        ...extra,
        state: file.state,
        outcome: file.outcome,
        warnings,
        ...(error
          ? {
              error:
                'Saved, but a message or task could not be delivered yet; it will be retried',
            }
          : {}),
      });
    }
  }
}
