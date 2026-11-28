import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Migration 326: a reply saved as sent that the gateway later reports
// failed restarts the customer's wait, from their original unanswered
// message (237's definition), not from the failure. A delivery that
// corrects the failure (291) ends the wait again. The behaviour is
// replayed by supabase/ci/verify-failed-reply-waiting.sql; this pins the
// shape so a change to it is seen in the unit suite too.

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const SQL = read('supabase/migrations/326_failed_reply_waiting.sql');

function body(): string {
  const start = SQL.indexOf(
    'CREATE OR REPLACE FUNCTION public.response_reply_status_changed()'
  );
  const end = SQL.indexOf('END $$;', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

describe('326: a failed reply restarts the waiting clock', () => {
  it('fires on a status update that crosses into or out of failed, for replies only', () => {
    expect(SQL).toMatch(
      /CREATE TRIGGER messages_response_waiting_status\s+AFTER UPDATE OF status ON public\.messages\s+FOR EACH ROW\s+WHEN \(NEW\.sender_type <> 'customer'\s+AND coalesce\(NEW\.status = 'failed', false\)\s+IS DISTINCT FROM coalesce\(OLD\.status = 'failed', false\)\)\s+EXECUTE FUNCTION public\.response_reply_status_changed\(\);/
    );
    expect(SQL).toContain(
      'DROP TRIGGER IF EXISTS messages_response_waiting_status ON public.messages;'
    );
  });

  it('restarts from the first customer message after the last reply that did not fail', () => {
    const b = body();
    expect(b).toMatch(
      /SELECT min\(m\.created_at\) INTO v_since\s+FROM public\.messages m\s+WHERE m\.conversation_id = NEW\.conversation_id\s+AND m\.sender_type = 'customer'\s+AND m\.created_at > coalesce\(\s+\(SELECT max\(r\.created_at\)/
    );
    expect(b).toContain("AND r.sender_type <> 'customer'");
    expect(b).toContain("AND r.status IS DISTINCT FROM 'failed'),");
  });

  it('on failure, only revives a wait that reply ended, on an open company chat, moving the start earlier', () => {
    const b = body();
    const failedBranch = b.slice(
      b.indexOf("IF NEW.status = 'failed' THEN"),
      b.indexOf('ELSE')
    );
    expect(failedBranch).toContain('AND v_since IS NOT NULL');
    expect(failedBranch).toContain('AND v_since < NEW.created_at');
    expect(failedBranch).toContain(
      'AND (c.customer_waiting_since IS NULL OR v_since < c.customer_waiting_since)'
    );
    expect(failedBranch).toContain('AND c.personal_owner_id IS NULL');
    expect(failedBranch).toContain("AND c.status <> 'closed'");
  });

  it('on a corrected failure, ends the wait again and only moves the start later', () => {
    const b = body();
    const corrected = b.slice(b.indexOf('ELSE'), b.lastIndexOf('END IF;'));
    expect(corrected).toContain('AND c.customer_waiting_since IS NOT NULL');
    expect(corrected).toContain(
      'AND NEW.created_at >= c.customer_waiting_since'
    );
    expect(corrected).toContain(
      'AND (v_since IS NULL OR v_since > c.customer_waiting_since)'
    );
  });

  it('passes 237s guard and never fails the status update', () => {
    const b = body();
    expect(b).toContain(
      "PERFORM set_config('app.response_waiting', 'on', true);"
    );
    expect(b).toContain(
      "PERFORM set_config('app.response_waiting', '', true);"
    );
    expect(b).toMatch(
      /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'response_reply_status_changed: % \(%\)', SQLERRM, SQLSTATE;/
    );
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.response_reply_status_changed() FROM PUBLIC, anon, authenticated;'
    );
  });

  it('is replayed in CI by its verify file', () => {
    expect(read('.github/workflows/migrations.yml')).toContain(
      'supabase db query --local --file supabase/ci/verify-failed-reply-waiting.sql'
    );
  });
});
