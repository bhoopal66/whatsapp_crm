import { describe, expect, it } from 'vitest';

import { mapConfig, type AutoMsgTemplateView } from './api';
import { TRIGGERS } from './types';
import {
  approvalChips,
  automsgControls,
  automsgErrorKey,
  automsgRole,
  bannerView,
  nextSettingsForm,
  releaseCounts,
  settingsForm,
  showRcsNotice,
  showSmsNotice,
  toTimeInput,
  triggerRows,
  validateSettingsForm,
  type SettingsForm,
} from './view';

function tpl(
  kind: AutoMsgTemplateView['kind'],
  language: AutoMsgTemplateView['language'],
  approvalStatus: AutoMsgTemplateView['approvalStatus']
): AutoMsgTemplateView {
  return {
    kind,
    language,
    channel: 'whatsapp',
    body: 'Hi {{name}}',
    metaTemplateName: 'x',
    approvalStatus,
    category: 'utility',
    updatedAt: null,
  };
}

const config = mapConfig({ role: 'admin' });

describe('automsgRole', () => {
  it('lets HR admins and recruiter leads in, nobody else', () => {
    expect(automsgRole({ admin: true, recruiter: null, dept: null })).toBe(
      'admin'
    );
    expect(automsgRole({ admin: false, recruiter: 'lead', dept: null })).toBe(
      'lead'
    );
    expect(
      automsgRole({ admin: false, recruiter: 'member', dept: 'lead' })
    ).toBeNull();
    expect(automsgRole(null)).toBeNull();
  });
});

describe('automsgControls', () => {
  it('gives admins everything and leads only the trigger switches', () => {
    expect(automsgControls('admin')).toEqual({
      editSettings: true,
      switchTriggers: true,
    });
    expect(automsgControls('lead')).toEqual({
      editSettings: false,
      switchTriggers: true,
    });
    expect(automsgControls(null)).toEqual({
      editSettings: false,
      switchTriggers: false,
    });
  });
});

describe('bannerView', () => {
  it('kill switch on: OFF banner, admin turns on with a confirm', () => {
    expect(bannerView({ killSwitch: true }, 'admin')).toEqual({
      state: 'off',
      action: 'turnOn',
      confirm: true,
    });
    expect(bannerView({ killSwitch: true }, 'lead').action).toBeNull();
  });

  it('kill switch off: ON banner, admin turns off without a confirm', () => {
    expect(bannerView({ killSwitch: false }, 'admin')).toEqual({
      state: 'on',
      action: 'turnOff',
      confirm: false,
    });
    expect(bannerView({ killSwitch: false }, 'lead').action).toBeNull();
  });
});

describe('triggerRows channel', () => {
  const onRcs = {
    templates: config.templates,
    triggers: config.triggers.map((t) =>
      t.trigger === 'cv_received' ? { ...t, channel: 'rcs' as const } : t
    ),
  };
  const rcsRow = (status?: { connected: boolean; webhook: boolean } | null) =>
    triggerRows(onRcs, 'admin', status).find(
      (r) => r.trigger === 'cv_received'
    )!;

  it('carries each trigger channel', () => {
    expect(rcsRow().channel).toBe('rcs');
    expect(
      triggerRows(onRcs, 'admin')
        .filter((r) => r.trigger !== 'cv_received')
        .every((r) => r.channel === 'whatsapp')
    ).toBe(true);
  });

  it('flags an RCS row unless the provider is known to be connected', () => {
    expect(rcsRow({ connected: true, webhook: false }).rcsNotConnected).toBe(
      false
    );
    expect(rcsRow({ connected: false, webhook: true }).rcsNotConnected).toBe(
      true
    );
    expect(rcsRow(null).rcsNotConnected).toBe(true);
  });

  it('does not flag an RCS row while the status is still loading', () => {
    expect(rcsRow().rcsNotConnected).toBe(false);
    expect(showRcsNotice(triggerRows(onRcs, 'admin'))).toBe(false);
    expect(showRcsNotice(triggerRows(onRcs, 'admin', null))).toBe(true);
  });

  it('never flags a WhatsApp row, whatever the RCS status', () => {
    for (const status of [
      undefined,
      null,
      { connected: false, webhook: false },
      { connected: true, webhook: true },
    ]) {
      const rows = triggerRows(config, 'admin', status);
      expect(rows.every((r) => r.channel === 'whatsapp')).toBe(true);
      expect(rows.some((r) => r.rcsNotConnected)).toBe(false);
      expect(showRcsNotice(rows)).toBe(false);
    }
  });

  it('flags an SMS row by the SMS status only, never by the RCS one', () => {
    const onSms = {
      templates: config.templates,
      triggers: config.triggers.map((t) =>
        t.trigger === 'cv_received' ? { ...t, channel: 'sms' as const } : t
      ),
    };
    const up = { connected: true, webhook: true };
    const down = { connected: false, webhook: false };
    const smsRow = (rcs?: typeof up | null, sms?: typeof up | null) =>
      triggerRows(onSms, 'admin', rcs, sms).find(
        (r) => r.trigger === 'cv_received'
      )!;
    expect(smsRow(up, undefined).smsNotConnected).toBe(false);
    expect(smsRow(up, null).smsNotConnected).toBe(true);
    expect(smsRow(up, down).smsNotConnected).toBe(true);
    expect(smsRow(down, up).smsNotConnected).toBe(false);
    expect(smsRow(down, up).rcsNotConnected).toBe(false);
    expect(showSmsNotice(triggerRows(onSms, 'admin', up, null))).toBe(true);
    expect(showSmsNotice(triggerRows(onSms, 'admin', down, up))).toBe(false);
    expect(showRcsNotice(triggerRows(onSms, 'admin', down, down))).toBe(false);
    // an RCS row is never flagged by the SMS status
    expect(showSmsNotice(triggerRows(onRcs, 'admin', up, null))).toBe(false);
  });

  it('shows the notice only with an RCS trigger and no connection', () => {
    expect(showRcsNotice(triggerRows(onRcs, 'admin', null))).toBe(true);
    expect(
      showRcsNotice(
        triggerRows(onRcs, 'admin', { connected: true, webhook: true })
      )
    ).toBe(false);
  });

  it('lets whoever may switch triggers change the channel', () => {
    expect(triggerRows(onRcs, 'admin')[0].channelDisabled).toBe(false);
    expect(triggerRows(onRcs, 'lead')[0].channelDisabled).toBe(false);
    expect(triggerRows(onRcs, null)[0].channelDisabled).toBe(true);
  });
});

describe('triggerRows', () => {
  it('lists all six triggers in order', () => {
    expect(triggerRows(config, 'admin').map((r) => r.trigger)).toEqual([
      ...TRIGGERS,
    ]);
  });

  it('lets the interview reminder be switched like any other trigger', () => {
    const reminder = (role: 'admin' | 'lead' | null) =>
      triggerRows(config, role).find(
        (r) => r.trigger === 'interview_reminder'
      )!;
    expect(reminder('admin').switchDisabled).toBe(false);
    expect(reminder('lead').switchDisabled).toBe(false);
    expect(reminder(null).switchDisabled).toBe(true);
    for (const role of ['admin', 'lead', null] as const)
      expect(reminder(role).note).toBeNull();
  });

  it('lets admins and leads switch, only admins pick a template', () => {
    const admin = triggerRows(config, 'admin')[0];
    const lead = triggerRows(config, 'lead')[0];
    const none = triggerRows(config, null)[0];
    expect([admin.switchDisabled, admin.templateDisabled]).toEqual([
      false,
      false,
    ]);
    expect([lead.switchDisabled, lead.templateDisabled]).toEqual([false, true]);
    expect([none.switchDisabled, none.templateDisabled]).toEqual([true, true]);
  });

  it('flags approval per language of the trigger template kind', () => {
    const rows = triggerRows(
      {
        triggers: config.triggers,
        templates: [
          tpl('cv_ack', 'en', 'approved'),
          tpl('cv_ack', 'ar', 'draft'),
          tpl('ai_interview_invite', 'ar', 'approved'),
          tpl('reply_nudge', 'en', 'approved'),
          tpl('hr_interview_invite', 'en', 'draft'),
        ],
      },
      'admin'
    );
    const by = Object.fromEntries(rows.map((r) => [r.trigger, r]));
    expect(by.cv_received.approved).toEqual({ en: true, ar: false });
    expect(by.cv_received.noApproved).toBe(false);
    expect(by.stage_ai_interview.approved).toEqual({ en: false, ar: true });
    expect(by.stage_hr_interview.approved).toEqual({ en: false, ar: false });
    expect(by.stage_hr_interview.noApproved).toBe(true);
    expect(by.reply_overdue_nudge.approved).toEqual({ en: true, ar: false });
  });

  it('follows the configured template kind, not the default', () => {
    const triggers = config.triggers.map((t) =>
      t.trigger === 'cv_received'
        ? { ...t, templateKind: 'reply_nudge' as const }
        : t
    );
    const row = triggerRows(
      { triggers, templates: [tpl('cv_ack', 'en', 'approved')] },
      'admin'
    )[0];
    expect(row.templateKind).toBe('reply_nudge');
    expect(row.noApproved).toBe(true);
  });
});

describe('settings form', () => {
  const good: SettingsForm = {
    quietStart: '21:00',
    quietEnd: '08:00',
    tz: ' Asia/Dubai ',
    dailyCap: '3',
    requiresConsent: true,
  };

  it('builds a trimmed patch from a valid form', () => {
    expect(validateSettingsForm(good)).toEqual({
      ok: true,
      patch: {
        quietStart: '21:00',
        quietEnd: '08:00',
        tz: 'Asia/Dubai',
        dailyCap: 3,
        requiresConsent: true,
      },
    });
  });

  it.each([
    [{ quietStart: '24:00' }, ['quietStart']],
    [{ quietStart: '9:00' }, ['quietStart']],
    [{ quietEnd: '08:60' }, ['quietEnd']],
    [{ tz: '   ' }, ['tz']],
    [{ dailyCap: '0' }, ['dailyCap']],
    [{ dailyCap: '21' }, ['dailyCap']],
    [{ dailyCap: '2.5' }, ['dailyCap']],
    [{ dailyCap: '' }, ['dailyCap']],
  ])('refuses %o', (change, invalid) => {
    expect(validateSettingsForm({ ...good, ...change })).toEqual({
      ok: false,
      invalid,
    });
  });

  it('accepts the cap bounds 1 and 20', () => {
    expect(validateSettingsForm({ ...good, dailyCap: '1' }).ok).toBe(true);
    expect(validateSettingsForm({ ...good, dailyCap: '20' }).ok).toBe(true);
  });

  it('reads stored settings into the form, trimming seconds', () => {
    expect(toTimeInput('21:00:00')).toBe('21:00');
    expect(settingsForm(config.settings)).toEqual({
      quietStart: '21:00',
      quietEnd: '08:00',
      tz: 'Asia/Dubai',
      dailyCap: '3',
      requiresConsent: true,
    });
  });
});

describe('refusals and Run now', () => {
  it('maps refusal codes to labels, unknown ones to UNKNOWN', () => {
    expect(automsgErrorKey('LIMIT')).toBe('LIMIT');
    expect(automsgErrorKey('STALE')).toBe('STALE');
    expect(automsgErrorKey('NOT_ALLOWED')).toBe('NOT_ALLOWED');
    expect(automsgErrorKey('CLOSED')).toBe('UNKNOWN');
    expect(automsgErrorKey('Network error')).toBe('UNKNOWN');
  });

  it('folds outcomes into sent, held and other', () => {
    expect(
      releaseCounts({
        reviewed: 0,
        expired: 0,
        outcomes: {
          sent: 2,
          'held:quiet_hours': 1,
          'held:no_consent': 3,
          failed: 1,
          error: 1,
        },
      })
    ).toEqual({ sent: 2, held: 4, other: 2 });
  });
});

describe('nextSettingsForm', () => {
  const typed: SettingsForm = {
    quietStart: '22:00',
    quietEnd: '07:00',
    tz: 'Asia/Dubai',
    dailyCap: '9',
    requiresConsent: false,
  };

  it('fills the form on the first load', () => {
    expect(nextSettingsForm(null, config.settings, 'other')).toEqual(
      settingsForm(config.settings)
    );
    expect(nextSettingsForm(typed, config.settings, 'first')).toEqual(
      settingsForm(config.settings)
    );
  });

  it('resets after a successful settings save', () => {
    expect(nextSettingsForm(typed, config.settings, 'settings-saved')).toEqual(
      settingsForm(config.settings)
    );
  });

  it('keeps unsaved edits on any other reload', () => {
    expect(nextSettingsForm(typed, config.settings, 'other')).toBe(typed);
  });
});

describe('approvalChips', () => {
  const keys = (en: boolean, ar: boolean) =>
    approvalChips({ en, ar }).map((c) => c.key);

  it('names each language, approved or not', () => {
    expect(keys(true, true)).toEqual(['enApproved', 'arApproved']);
    expect(keys(true, false)).toEqual(['enApproved', 'arMissing']);
    expect(keys(false, true)).toEqual(['enMissing', 'arApproved']);
  });

  it('warns that only a draft exists when no language is approved', () => {
    expect(keys(false, false)).toEqual(['enMissing', 'arMissing', 'draftOnly']);
    expect(approvalChips({ en: false, ar: false }).map((c) => c.tone)).toEqual([
      'missing',
      'missing',
      'warning',
    ]);
  });

  it('marks approved languages with the ok tone', () => {
    expect(approvalChips({ en: true, ar: false }).map((c) => c.tone)).toEqual([
      'ok',
      'missing',
    ]);
  });
});

describe('triggerRows approval is per channel', () => {
  const kind = config.triggers[0].templateKind;
  const trigger = config.triggers[0].trigger;
  const withChannels = (
    wa: 'approved' | 'draft',
    rcs: 'approved' | 'draft'
  ) => ({
    triggers: config.triggers,
    templates: [
      { ...tpl(kind, 'en', wa), channel: 'whatsapp' as const },
      { ...tpl(kind, 'en', rcs), channel: 'rcs' as const },
    ],
  });
  const row = (
    cfg: ReturnType<typeof withChannels>,
    channel: 'whatsapp' | 'rcs'
  ) =>
    triggerRows(
      {
        ...cfg,
        triggers: cfg.triggers.map((t) =>
          t.trigger === trigger ? { ...t, channel } : t
        ),
      },
      'admin',
      { connected: true, webhook: true }
    ).find((r) => r.trigger === trigger)!;

  it('an approved RCS template does not approve a WhatsApp trigger', () => {
    const r = row(withChannels('draft', 'approved'), 'whatsapp');
    expect(r.approved.en).toBe(false);
    expect(r.noApproved).toBe(true);
  });

  it('an approved WhatsApp template does not approve an RCS trigger', () => {
    const r = row(withChannels('approved', 'draft'), 'rcs');
    expect(r.approved.en).toBe(false);
    expect(r.noApproved).toBe(true);
  });

  it('each trigger sees its own channel approval', () => {
    const cfg = withChannels('draft', 'approved');
    expect(row(cfg, 'rcs').approved.en).toBe(true);
  });
});
