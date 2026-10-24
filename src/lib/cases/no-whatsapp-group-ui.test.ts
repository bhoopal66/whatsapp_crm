import { describe, expect, it } from 'vitest';

import { docRequestKey } from './case-page';
import { conversationView, sendResultMessageKey } from './case-tabs';
import { caseSwitchBody, parseCaseSwitches } from './settings-ui';

// Migration 136: a Compass submission may open a case without a WhatsApp
// group (submission_groups.wa_mode 'none'), behind a per-account switch.

describe('parseCaseSwitches', () => {
  it('reads both switches', () => {
    expect(
      parseCaseSwitches({
        settings: { managedExternally: false, submissionWhatsappGroups: true },
      })
    ).toEqual({ managedExternally: false, submissionWhatsappGroups: true });
  });

  it('refuses an answer without a boolean WhatsApp groups switch', () => {
    expect(
      parseCaseSwitches({ settings: { managedExternally: true } })
    ).toBeNull();
    expect(
      parseCaseSwitches({
        settings: { managedExternally: true, submissionWhatsappGroups: 'no' },
      })
    ).toBeNull();
    expect(
      parseCaseSwitches({ settings: { submissionWhatsappGroups: true } })
    ).toBeNull();
    expect(parseCaseSwitches(null)).toBeNull();
  });
});

describe('caseSwitchBody', () => {
  it('sends only the switch being changed, in the route field names', () => {
    expect(caseSwitchBody('submissionWhatsappGroups', true)).toEqual({
      submission_whatsapp_groups: true,
    });
    expect(caseSwitchBody('managedExternally', false)).toEqual({
      managed_externally: false,
    });
  });
});

describe('conversationView', () => {
  it('a lead has no group row', () => {
    expect(conversationView({ groupId: null, waMode: null })).toBe('noGroup');
  });

  it("a 'none' submission has no WhatsApp group", () => {
    expect(conversationView({ groupId: 'g1', waMode: 'none' })).toBe(
      'noWhatsappGroup'
    );
  });

  it('a WhatsApp group shows its messages', () => {
    expect(conversationView({ groupId: 'g1', waMode: 'group' })).toBe('group');
    // An older answer without waMode is a group.
    expect(conversationView({ groupId: 'g1', waMode: null })).toBe('group');
  });
});

describe('NO_WHATSAPP_GROUP refusals', () => {
  it('a reply into a submission without a group', () => {
    expect(sendResultMessageKey(409, 'NO_WHATSAPP_GROUP')).toBe(
      'noWhatsappGroup'
    );
  });

  it('a documents request refused for the same reason', () => {
    expect(docRequestKey(409, 'REFUSED', 'NO_WHATSAPP_GROUP')).toBe(
      'noWhatsappGroup'
    );
    expect(docRequestKey(409, 'REFUSED', 'GROUP_NOT_READY')).toBe('refused');
    expect(docRequestKey(409, 'REFUSED')).toBe('refused');
  });
});
