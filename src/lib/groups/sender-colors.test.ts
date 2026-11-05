import { describe, expect, it } from 'vitest';

import {
  assignSenderColors,
  NEUTRAL_SENDER_COLOR,
  SENDER_COLORS,
  senderColors,
  senderKey,
} from './sender-colors';

const slotOf = (color: unknown) =>
  SENDER_COLORS.indexOf(color as (typeof SENDER_COLORS)[number]);

/** How far apart two slots sit on the wheel. */
const wheelGap = (a: number, b: number) => {
  const d = Math.abs(a - b);
  return Math.min(d, SENDER_COLORS.length - d);
};

/** A chat's senders as the data holds them: UUIDs and phone numbers. */
function people(seed: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    i % 2
      ? `wa:9715${String(seed * 7919 + i * 104729).padStart(8, '0')}`
      : `user:${seed.toString(16).padStart(8, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`
  );
}

const CHATS = 2000;

describe('SENDER_COLORS', () => {
  it('writes every class out whole, with a pair for dark mode', () => {
    for (const color of [...SENDER_COLORS, NEUTRAL_SENDER_COLOR]) {
      expect(color.text).toMatch(/^text-[a-z]+-\d+ dark:text-[a-z]+-\d+$/);
      expect(color.textOut).toMatch(/^text-[a-z]+-\d+ dark:text-[a-z]+-\d+$/);
      expect(color.stripe).toMatch(
        /^border-[a-z]+-\d+ dark:border-[a-z]+-\d+$/
      );
    }
  });

  it('uses each hue once, the same one on the names and the edge', () => {
    const hueOf = (cls: string) => /-([a-z]+)-\d+/.exec(cls)?.[1];
    const hues = SENDER_COLORS.map(({ text, textOut, stripe }) => {
      expect(hueOf(text)).toBe(hueOf(stripe));
      expect(hueOf(textOut)).toBe(hueOf(stripe));
      return hueOf(text);
    });
    expect(new Set(hues).size).toBe(SENDER_COLORS.length);
    expect(hues).not.toContain(hueOf(NEUTRAL_SENDER_COLOR.text));
  });
});

describe('senderKey', () => {
  it('names the user behind a CRM send, whatever else the row carries', () => {
    // A send whose webhook echo won the race carries our number as well.
    expect(
      senderKey({ sender_user_id: 'u1', sender_wa_id: '971500000001' })
    ).toBe('user:u1');
  });

  it('goes by the number, not the name WhatsApp gave it', () => {
    expect(
      senderKey({ sender_wa_id: '971500000001', sender_name: 'Sara' })
    ).toBe(senderKey({ sender_wa_id: '971500000001', sender_name: 'S. K.' }));
  });

  it('keeps a hidden number apart from a real one', () => {
    expect(senderKey({ sender_wa_id: '12345@lid' })).not.toBe(
      senderKey({ sender_wa_id: '12345' })
    );
  });

  it('falls back to the name, ignoring case and spacing', () => {
    expect(senderKey({ sender_name: ' Sara ' })).toBe(
      senderKey({ sender_name: 'sara' })
    );
  });

  it('has nothing for an automatic message or an unnamed sender', () => {
    expect(
      senderKey({ sender_user_id: 'u1', system_kind: 'welcome' })
    ).toBeNull();
    expect(senderKey({})).toBeNull();
    expect(senderKey({ sender_name: '   ' })).toBeNull();
  });
});

describe('assignSenderColors', () => {
  it('gives everyone a colour of their own while the palette lasts', () => {
    for (let seed = 1; seed <= CHATS; seed++) {
      const colors = assignSenderColors(people(seed, SENDER_COLORS.length));
      expect(colors.size).toBe(SENDER_COLORS.length);
      expect(new Set(colors.values()).size).toBe(SENDER_COLORS.length);
    }
  });

  it('never puts the first four senders on neighbouring hues', () => {
    for (let seed = 1; seed <= CHATS; seed++) {
      const slots = [...assignSenderColors(people(seed, 4)).values()].map(
        slotOf
      );
      for (let i = 0; i < slots.length; i++)
        for (let j = i + 1; j < slots.length; j++)
          expect(wheelGap(slots[i], slots[j])).toBeGreaterThanOrEqual(2);
    }
  });

  it('never moves a sender when someone new writes', () => {
    for (let seed = 1; seed <= CHATS; seed++) {
      const everyone = people(seed, 9);
      const before = assignSenderColors(everyone.slice(0, 5));
      const after = assignSenderColors(everyone);
      for (const [key, color] of before) expect(after.get(key)).toBe(color);
    }
  });

  it('gives a person the same colour in every chat where nothing clashes', () => {
    const [sara] = people(1, 1);
    const alone = assignSenderColors([sara]).get(sara);
    for (let seed = 2; seed <= 50; seed++) {
      const other = people(seed, 2)[1];
      const gap = wheelGap(
        slotOf(assignSenderColors([other]).get(other)),
        slotOf(alone)
      );
      if (gap < 2) continue;
      expect(assignSenderColors([other, sara]).get(sara)).toBe(alone);
    }
  });

  it('answers the same for the same chat every time', () => {
    const everyone = people(3, 7);
    expect([...assignSenderColors(everyone)]).toEqual([
      ...assignSenderColors(everyone),
    ]);
  });

  it('counts a sender once however often they write', () => {
    const [a, b] = people(4, 2);
    expect(assignSenderColors([a, b, a, a, b]).size).toBe(2);
  });

  it('shares the palette out evenly in a chat bigger than it', () => {
    const colors = assignSenderColors(people(5, SENDER_COLORS.length * 2 + 6));
    const uses = new Map<unknown, number>();
    for (const color of colors.values())
      uses.set(color, (uses.get(color) ?? 0) + 1);
    expect(uses.size).toBe(SENDER_COLORS.length);
    expect(Math.max(...uses.values())).toBe(3);
  });

  it('leaves out messages with nobody to colour', () => {
    expect(assignSenderColors([null, null]).size).toBe(0);
  });
});

describe('senderColors', () => {
  const agent = { direction: 'out', sender_user_id: 'u1' };
  const customer = { direction: 'in', sender_wa_id: '971500000001' };
  const automatic = {
    direction: 'out',
    sender_user_id: null,
    system_kind: 'status_update',
  };

  it('tells the senders of one chat apart', () => {
    const colorOf = senderColors([agent, customer]);
    expect(colorOf(agent)).not.toBe(colorOf(customer));
    expect(SENDER_COLORS).toContain(colorOf(agent));
    expect(SENDER_COLORS).toContain(colorOf(customer));
  });

  it('colours a message being sent like the saved one that replaces it', () => {
    const optimistic = { sender_user_id: 'u1', sender_name: 'Sara' };
    const saved = { sender_user_id: 'u1', sender_wa_id: '971500000002' };
    const colorOf = senderColors([customer, optimistic]);
    expect(colorOf(saved)).toBe(colorOf(optimistic));
  });

  it('keeps people’s colours for themselves', () => {
    const colorOf = senderColors([agent, automatic, {}]);
    expect(colorOf(automatic)).toBe(NEUTRAL_SENDER_COLOR);
    expect(colorOf({})).toBe(NEUTRAL_SENDER_COLOR);
  });
});
