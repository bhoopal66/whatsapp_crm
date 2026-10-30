import { describe, expect, it } from 'vitest';

import {
  CHAT_CAPABILITIES,
  deniedFromMatrix,
  openPermissionMatrix,
  RECOMMENDED_DENIED,
} from '../permissions';
import {
  hasMatrixChanges,
  matrixChanges,
  matrixFromDenied,
  parseWindowMinutes,
  WINDOW_MAX_MINUTES,
  WINDOW_PRESETS,
  windowText,
} from '../permissions-form';

describe('parseWindowMinutes', () => {
  it('reads blank as no limit', () => {
    expect(parseWindowMinutes('')).toEqual({ ok: true, minutes: null });
    expect(parseWindowMinutes('   ')).toEqual({ ok: true, minutes: null });
  });

  it('accepts whole minutes within 1..10080', () => {
    expect(parseWindowMinutes('1')).toEqual({ ok: true, minutes: 1 });
    expect(parseWindowMinutes(' 90 ')).toEqual({ ok: true, minutes: 90 });
    expect(parseWindowMinutes('10080')).toEqual({ ok: true, minutes: 10080 });
  });

  it.each(['0', '10081', '-5', '1.5', '1e3', '15m', 'abc', '+10'])(
    'refuses %j',
    (text) => {
      expect(parseWindowMinutes(text)).toEqual({ ok: false });
    }
  );

  it('round-trips through windowText', () => {
    expect(windowText(null)).toBe('');
    expect(parseWindowMinutes(windowText(60))).toEqual({
      ok: true,
      minutes: 60,
    });
  });

  it('offers only presets the database accepts', () => {
    for (const m of WINDOW_PRESETS) {
      expect(parseWindowMinutes(String(m))).toEqual({ ok: true, minutes: m });
    }
    expect(Math.max(...WINDOW_PRESETS)).toBe(WINDOW_MAX_MINUTES);
  });
});

describe('matrixChanges', () => {
  it('finds nothing between equal matrices', () => {
    const c = matrixChanges(openPermissionMatrix(), openPermissionMatrix());
    expect(c).toEqual({ allowed: [], denied: [] });
    expect(hasMatrixChanges(c)).toBe(false);
  });

  it('splits newly denied and newly allowed cells', () => {
    const saved = openPermissionMatrix();
    saved.agent.upload_files = false;
    const draft = openPermissionMatrix();
    draft.viewer.pin_messages = false;
    draft.admin.add_members = false;
    const c = matrixChanges(saved, draft);
    expect(c.allowed).toEqual([
      { role_class: 'agent', capability: 'upload_files' },
    ]);
    expect(c.denied).toEqual([
      { role_class: 'admin', capability: 'add_members' },
      { role_class: 'viewer', capability: 'pin_messages' },
    ]);
    expect(hasMatrixChanges(c)).toBe(true);
  });

  it('ignores guest cells that cannot be restricted', () => {
    const draft = openPermissionMatrix();
    draft.bank_guest.create_team_channel = false;
    draft.bank_guest.share_cards = false;
    expect(hasMatrixChanges(matrixChanges(openPermissionMatrix(), draft))).toBe(
      false
    );
  });

  it('counts a guest cell that can be restricted', () => {
    const draft = openPermissionMatrix();
    draft.bank_guest.upload_files = false;
    expect(matrixChanges(openPermissionMatrix(), draft).denied).toEqual([
      { role_class: 'bank_guest', capability: 'upload_files' },
    ]);
  });

  it('counts "Use recommended" from an open workspace as exactly its denials', () => {
    const c = matrixChanges(
      openPermissionMatrix(),
      matrixFromDenied(RECOMMENDED_DENIED)
    );
    expect(c.allowed).toEqual([]);
    expect(c.denied).toEqual([...RECOMMENDED_DENIED]);
  });
});

describe('matrixFromDenied', () => {
  it('round-trips the recommended preset', () => {
    expect(deniedFromMatrix(matrixFromDenied(RECOMMENDED_DENIED))).toEqual([
      ...RECOMMENDED_DENIED,
    ]);
  });

  it('denies only the listed pairs', () => {
    const m = matrixFromDenied([
      { role_class: 'viewer', capability: 'send_voice' },
    ]);
    for (const cap of CHAT_CAPABILITIES) {
      expect(m.viewer[cap]).toBe(cap !== 'send_voice');
      expect(m.agent[cap]).toBe(true);
    }
  });
});
