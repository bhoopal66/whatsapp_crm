import { describe, expect, it } from 'vitest';

import { mapConfig, type AutoMsgTemplateView } from './api';
import { TRIGGERS } from './types';
import {
  automsgControls,
  automsgErrorKey,
  automsgRole,
  bannerView,
  nextSettingsForm,
  releaseCounts,
  settingsForm,
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

describe('triggerRows', () => {
  it('lists all six triggers in order', () => {
    expect(triggerRows(config, 'admin').map((r) => r.trigger)).toEqual([
      ...TRIGGERS,
    ]);
  });

  it('never lets the interview reminder be switched, for any role', () => {
    for (const role of ['admin', 'lead', null] as const) {
      const row = triggerRows(config, role).find(
        (r) => r.trigger === 'interview_reminder'
      )!;
      expect(row.switchDisabled).toBe(true);
      expect(row.note).toBe('needsInterviewTimes');
    }
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
