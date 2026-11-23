import { describe, expect, it } from 'vitest';

import type { WhapiGroupParticipant } from '@/lib/whatsapp/whapi-api';

import { planClose } from './close-plan';

const OURS = '971500000000';
const person = (
  waId: string | null,
  role: WhapiGroupParticipant['role'] = 'member',
  jid = `${waId}@s.whatsapp.net`
): WhapiGroupParticipant => ({ jid, waId, role });
const hidden = (n: number, role: WhapiGroupParticipant['role'] = 'member') =>
  person(null, role, `${n}@lid`);

describe('planClose', () => {
  it('takes the visible and the hidden out once we are found among the others', () => {
    expect(
      planClose([person(OURS), person('971501234567'), hidden(99999)], OURS)
    ).toEqual({
      phones: ['971501234567'],
      hidden: ['99999@lid'],
      unreachable: 0,
    });
  });

  it('a hidden creator is us, whether or not our number is on file', () => {
    for (const ours of [OURS, null])
      expect(
        planClose([hidden(11111, 'superadmin'), hidden(99999)], ours)
      ).toEqual({ phones: [], hidden: ['99999@lid'], unreachable: 0 });
  });

  it('reads a hidden member of an OpenWA group, whose waId is the hidden id', () => {
    expect(
      planClose(
        [person(OURS), person('99999@lid', 'member', '99999@lid')],
        OURS
      ).hidden
    ).toEqual(['99999@lid']);
  });

  it('removes no hidden id when none of the others is us', () => {
    expect(planClose([hidden(11111), hidden(99999)], null)).toEqual({
      phones: [],
      hidden: [],
      unreachable: 2,
    });
    // On file but not shown: one of the two is us.
    expect(planClose([hidden(11111), hidden(99999)], OURS).unreachable).toBe(1);
    // Only us left.
    expect(planClose([hidden(11111)], OURS).unreachable).toBe(0);
    // A creator with another number: the number on file may be wrong.
    expect(
      planClose([person('971509999999', 'superadmin'), hidden(99999)], OURS)
    ).toEqual({ phones: [], hidden: [], unreachable: 1 });
  });

  it('counts an id nobody could be asked to remove', () => {
    expect(
      planClose([person(OURS), person(null, 'member', 'x@newsletter')], OURS)
        .unreachable
    ).toBe(1);
  });
});
