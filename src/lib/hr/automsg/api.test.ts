import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  automsgCancel,
  automsgConfig,
  automsgConsent,
  automsgOutbox,
  automsgReleaseNow,
  automsgSaveSettings,
  automsgSaveTemplate,
  automsgSetConsent,
  automsgSetTrigger,
} from './api';

function sbWith(result: unknown) {
  const rpc = vi.fn(async () => result);
  return { sb: { rpc } as unknown as SupabaseClient, rpc };
}
const ok = (data: unknown) => ({ data, error: null });

afterEach(() => vi.unstubAllGlobals());

describe('arguments', () => {
  it('config sends no arguments', async () => {
    const { sb, rpc } = sbWith(ok({}));
    await automsgConfig(sb);
    expect(rpc).toHaveBeenCalledWith('hr_automsg_config', {});
  });

  it('settings: unspecified fields go as null', async () => {
    const { sb, rpc } = sbWith(ok({}));
    await automsgSaveSettings(sb, { killSwitch: false, dailyCap: 2 });
    expect(rpc).toHaveBeenCalledWith('hr_automsg_settings_set', {
      p_kill_switch: false,
      p_quiet_start: null,
      p_quiet_end: null,
      p_tz: null,
      p_requires_consent: null,
      p_daily_cap: 2,
    });
  });

  it('trigger', async () => {
    const { sb, rpc } = sbWith(ok({}));
    await automsgSetTrigger(sb, 'cv_received', true);
    expect(rpc).toHaveBeenCalledWith('hr_automsg_trigger_set', {
      p_trigger: 'cv_received',
      p_enabled: true,
      p_template_kind: null,
    });
    await automsgSetTrigger(sb, 'cv_received', false, 'reply_nudge');
    expect(rpc).toHaveBeenLastCalledWith('hr_automsg_trigger_set', {
      p_trigger: 'cv_received',
      p_enabled: false,
      p_template_kind: 'reply_nudge',
    });
  });

  it('template', async () => {
    const { sb, rpc } = sbWith(ok({}));
    await automsgSaveTemplate(sb, {
      kind: 'cv_ack',
      language: 'ar',
      body: 'hi {name}',
      metaTemplateName: 'cv_ack_ar',
      approvalStatus: 'approved',
      category: 'utility',
    });
    expect(rpc).toHaveBeenCalledWith('hr_automsg_template_set', {
      p_kind: 'cv_ack',
      p_language: 'ar',
      p_body: 'hi {name}',
      p_meta_template_name: 'cv_ack_ar',
      p_approval_status: 'approved',
      p_category: 'utility',
    });
  });

  it('consent get and set (source defaults to recruiter_confirmed)', async () => {
    const { sb, rpc } = sbWith(ok([]));
    await automsgConsent(sb, 'c1');
    expect(rpc).toHaveBeenCalledWith('hr_automsg_consent_get', {
      p_conversation_id: 'c1',
    });
    await automsgSetConsent(sb, 'c1', true);
    expect(rpc).toHaveBeenLastCalledWith('hr_automsg_consent_set', {
      p_conversation_id: 'c1',
      p_granted: true,
      p_source: 'recruiter_confirmed',
    });
    await automsgSetConsent(sb, 'c1', false, 'form');
    expect(rpc).toHaveBeenLastCalledWith('hr_automsg_consent_set', {
      p_conversation_id: 'c1',
      p_granted: false,
      p_source: 'form',
    });
  });

  it('outbox and cancel', async () => {
    const { sb, rpc } = sbWith(ok([]));
    await automsgOutbox(sb);
    expect(rpc).toHaveBeenLastCalledWith('hr_automsg_outbox_list', {
      p_status: null,
      p_limit: null,
    });
    await automsgOutbox(sb, { status: 'held', limit: 20 });
    expect(rpc).toHaveBeenLastCalledWith('hr_automsg_outbox_list', {
      p_status: 'held',
      p_limit: 20,
    });
    const res = await automsgCancel(sb, 'o1');
    expect(rpc).toHaveBeenLastCalledWith('hr_automsg_cancel', { p_id: 'o1' });
    expect(res).toEqual({ data: null });
  });
});

describe('mapping', () => {
  it('maps the config to camelCase with all six triggers', async () => {
    const { sb } = sbWith(
      ok({
        settings: {
          kill_switch: false,
          quiet_start: '22:00',
          quiet_end: '07:00',
          tz: 'Asia/Dubai',
          requires_consent: false,
          daily_cap: 5,
          updated_at: '2026-11-16T00:00:00Z',
        },
        triggers: [
          { trigger: 'cv_received', enabled: true, template_kind: 'cv_ack' },
        ],
        templates: [
          {
            kind: 'cv_ack',
            language: 'en',
            body: 'Hello',
            meta_template_name: 'cv_ack_en',
            approval_status: 'approved',
            category: 'marketing',
            updated_at: '2026-11-15T00:00:00Z',
          },
        ],
        role: 'admin',
      })
    );
    const res = await automsgConfig(sb);
    if (!('data' in res)) throw new Error('expected data');
    expect(res.data.settings).toEqual({
      killSwitch: false,
      quietStart: '22:00',
      quietEnd: '07:00',
      tz: 'Asia/Dubai',
      requiresConsent: false,
      dailyCap: 5,
      updatedAt: '2026-11-16T00:00:00Z',
    });
    expect(res.data.triggers).toHaveLength(6);
    expect(res.data.triggers[0]).toEqual({
      trigger: 'cv_received',
      enabled: true,
      templateKind: 'cv_ack',
    });
    expect(res.data.triggers[5]).toEqual({
      trigger: 'reply_overdue_nudge',
      enabled: false,
      templateKind: 'reply_nudge',
    });
    expect(res.data.templates[0]).toMatchObject({
      metaTemplateName: 'cv_ack_en',
      approvalStatus: 'approved',
      category: 'marketing',
    });
    expect(res.data.role).toBe('admin');
  });

  it('falls back to defaults on a null payload', async () => {
    const { sb } = sbWith(ok(null));
    const res = await automsgConfig(sb);
    if (!('data' in res)) throw new Error('expected data');
    expect(res.data.settings.killSwitch).toBe(true);
    expect(res.data.settings.dailyCap).toBe(3);
    expect(res.data.templates).toEqual([]);
    expect(res.data.triggers).toHaveLength(6);
  });

  it('maps outbox rows', async () => {
    const { sb } = sbWith(
      ok([
        {
          id: 'o1',
          conversation_id: 'c1',
          contact_id: 'k1',
          contact_name: 'Sara',
          trigger: 'stage_hr_interview',
          template_kind: 'hr_interview_invite',
          language: 'ar',
          status: 'held',
          hold_reason: 'quiet_hours',
          attempts: 1,
          claim_state: null,
          last_error: null,
          created_at: '2026-11-16T01:00:00Z',
          sent_at: null,
        },
      ])
    );
    expect(await automsgOutbox(sb)).toEqual({
      data: [
        {
          id: 'o1',
          conversationId: 'c1',
          contactId: 'k1',
          contactName: 'Sara',
          trigger: 'stage_hr_interview',
          templateKind: 'hr_interview_invite',
          language: 'ar',
          status: 'held',
          holdReason: 'quiet_hours',
          attempts: 1,
          claimState: null,
          lastError: null,
          createdAt: '2026-11-16T01:00:00Z',
          sentAt: null,
        },
      ],
    });
  });

  it('picks the first consent row', async () => {
    const { sb } = sbWith(
      ok([
        {
          granted: true,
          source: 'form',
          noted_at: '2026-11-16T00:00:00Z',
          opted_out: false,
          personal: true,
        },
        { granted: false },
      ])
    );
    expect(await automsgConsent(sb, 'c1')).toEqual({
      data: {
        granted: true,
        source: 'form',
        notedAt: '2026-11-16T00:00:00Z',
        optedOut: false,
        personal: true,
      },
    });
  });

  it('an empty consent set means no record', async () => {
    const { sb } = sbWith(ok([]));
    expect(await automsgConsent(sb, 'c1')).toEqual({
      data: {
        granted: null,
        source: null,
        notedAt: null,
        optedOut: false,
        personal: false,
      },
    });
  });
});

describe('errors', () => {
  it('maps a HINT to its code', async () => {
    const { sb } = sbWith({
      data: null,
      error: { message: 'no', hint: 'NOT_ALLOWED' },
    });
    expect(await automsgConfig(sb)).toEqual({ error: 'NOT_ALLOWED' });
  });

  it('a thrown rpc is UNKNOWN', async () => {
    const sb = {
      rpc: vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    } as unknown as SupabaseClient;
    expect(await automsgCancel(sb, 'o1')).toEqual({ error: 'UNKNOWN' });
  });
});

describe('automsgReleaseNow', () => {
  it('posts and returns the summary', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ reviewed: 4, expired: 1, outcomes: { sent: 3 } }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await automsgReleaseNow()).toEqual({
      data: { reviewed: 4, expired: 1, outcomes: { sent: 3 } },
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/hr/automsg/release', {
      method: 'POST',
    });
  });

  it('a non-OK response is an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'nope' }), { status: 403 })
      )
    );
    expect(await automsgReleaseNow()).toEqual({ error: 'nope' });
  });

  it('a non-OK response without a body still errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 500 }))
    );
    expect(await automsgReleaseNow()).toEqual({
      error: 'Request failed (500)',
    });
  });
});
