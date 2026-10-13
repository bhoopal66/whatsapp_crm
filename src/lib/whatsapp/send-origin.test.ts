import { describe, expect, it } from 'vitest';

import { consentRefusal, isSendOrigin } from './send-origin';

describe('send origin', () => {
  it('knows only the missed-call draft', () => {
    expect(isSendOrigin('missed_call_draft')).toBe(true);
    expect(isSendOrigin('campaign')).toBe(false);
    expect(isSendOrigin(undefined)).toBe(false);
    expect(isSendOrigin(1)).toBe(false);
  });

  it('reads the consent register, do-not-contact first', () => {
    expect(consentRefusal({ do_not_contact_at: '2026-10-01' })).toBe(
      'do_not_contact'
    );
    expect(
      consentRefusal({ do_not_contact_at: '2026-10-01', opted_out_at: 'x' })
    ).toBe('do_not_contact');
    expect(consentRefusal({ opted_out_at: '2026-10-02' })).toBe('opted_out');
    expect(
      consentRefusal({ do_not_contact_at: null, opted_out_at: null })
    ).toBeNull();
    // No contact read: nothing to refuse on (the send fails elsewhere).
    expect(consentRefusal(null)).toBeNull();
  });
});
