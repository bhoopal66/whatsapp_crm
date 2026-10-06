import { describe, it, expect } from 'vitest';

import {
  countDroppedEvents,
  createDropTally,
  DROP_TALLY_INTERVAL_MS,
} from './meta-drop-tally';
import type { RawMetaWebhookPayload } from './meta-webhook';

const HOUR = DROP_TALLY_INTERVAL_MS;

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const drop = (messages: number, statuses: number, signed = false) => ({
  messages,
  statuses,
  signed,
});

describe('createDropTally', () => {
  it('logs the first sighting of an id immediately', () => {
    const tally = createDropTally({ now: clock().now });
    const line = tally.record('819779421230083', drop(1, 0, true));
    expect(line).toBe(
      '[meta-webhook] dropped 1 callback for unconnected phone_number_id "819779421230083"' +
        ' (first seen; further drops are summarised at most every 60m): 1 message, 0 statuses' +
        ' (1/1 signed by this app)'
    );
  });

  it('stays silent within the interval, then summarises everything since the last line', () => {
    const c = clock();
    const tally = createDropTally({ now: c.now });
    expect(tally.record('X', drop(0, 1))).not.toBeNull();

    c.advance(10 * 60_000);
    expect(tally.record('X', drop(1, 0, true))).toBeNull();
    c.advance(20 * 60_000);
    expect(tally.record('X', drop(0, 3))).toBeNull();
    c.advance(30 * 60_000); // exactly one hour after the first line
    const line = tally.record('X', drop(2, 1, true));

    expect(line).toBe(
      '[meta-webhook] dropped 3 callbacks for unconnected phone_number_id "X"' +
        ' in the last 60m: 3 messages, 4 statuses (2/3 signed by this app)'
    );
  });

  it('starts a fresh window after each summary', () => {
    const c = clock();
    const tally = createDropTally({ now: c.now });
    tally.record('X', drop(0, 1));
    c.advance(HOUR);
    expect(tally.record('X', drop(5, 5))).toMatch(
      /dropped 1 callback .* 5 messages, 5 statuses/
    );

    c.advance(HOUR - 1);
    expect(tally.record('X', drop(1, 0))).toBeNull();
    c.advance(1);
    expect(tally.record('X', drop(0, 2))).toMatch(
      /dropped 2 callbacks .* in the last 60m: 1 message, 2 statuses \(0\/2 signed/
    );
  });

  it('reports a long quiet spell as the real window length', () => {
    const c = clock();
    const tally = createDropTally({ now: c.now });
    tally.record('X', drop(0, 1));
    c.advance(5 * HOUR);
    expect(tally.record('X', drop(0, 1))).toMatch(/in the last 300m/);
  });

  it('keeps a separate budget per id', () => {
    const c = clock();
    const tally = createDropTally({ now: c.now });
    expect(tally.record('A', drop(0, 1))).toMatch(/"A" \(first seen/);
    expect(tally.record('B', drop(0, 1))).toMatch(/"B" \(first seen/);
    expect(tally.record('A', drop(0, 1))).toBeNull();
    expect(tally.record('B', drop(0, 1))).toBeNull();
  });

  it('bounds the ids it remembers, forgetting the oldest', () => {
    const tally = createDropTally({ now: clock().now, maxIds: 2 });
    tally.record('A', drop(0, 1));
    tally.record('B', drop(0, 1));
    tally.record('C', drop(0, 1)); // evicts A
    expect(tally.record('B', drop(0, 1))).toBeNull();
    expect(tally.record('A', drop(0, 1))).toMatch(/first seen/);
  });

  it('quotes and truncates an attacker-controlled id so it cannot forge a log line', () => {
    const tally = createDropTally({ now: clock().now });
    const line = tally.record(
      '1\n[meta-webhook] forged' + 'x'.repeat(200),
      drop(0, 0)
    );
    expect(line).not.toContain('\n');
    expect(line).toContain('"1\\n[meta-webhook] forged');
    expect(line!.length).toBeLessThan(300);
  });

  it('does not throw on an id that is not a string', () => {
    // Typed a string, but it comes out of a body nobody has verified.
    const tally = createDropTally({ now: clock().now });
    const record = (id: unknown) => tally.record(id as string, drop(0, 1));
    expect(record(12345)).toContain('phone_number_id "12345" (first seen');
    // JSON.parse builds this, and String() cannot convert it.
    expect(record(JSON.parse('{"toString":null}'))).toContain(
      'phone_number_id "<object>"'
    );
    expect(record(null)).toContain('phone_number_id "null"');
  });
});

describe('countDroppedEvents', () => {
  const payload: RawMetaWebhookPayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'W1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'PN-1' },
              messages: [{ id: 'm1' }, { id: 'm2' }],
              statuses: [{ id: 's1', status: 'sent' }],
            },
          },
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'PN-2' },
              messages: [{ id: 'm3' }],
            },
          },
        ],
      },
      {
        id: 'W2',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'PN-1' },
              statuses: [
                { id: 's2', status: 'delivered' },
                { id: 's3', status: 'read' },
              ],
            },
          },
          {
            // Not a messages change — never counted, even with a matching id.
            field: 'account_update',
            value: {
              metadata: { phone_number_id: 'PN-1' },
              messages: [{ id: 'x' }],
            },
          },
        ],
      },
    ],
  };

  it('counts messages and statuses for one number across entries', () => {
    expect(countDroppedEvents(payload, 'PN-1')).toEqual({
      messages: 2,
      statuses: 3,
    });
    expect(countDroppedEvents(payload, 'PN-2')).toEqual({
      messages: 1,
      statuses: 0,
    });
  });

  it('is zero for a number the payload does not mention', () => {
    expect(countDroppedEvents(payload, 'PN-9')).toEqual({
      messages: 0,
      statuses: 0,
    });
  });
});
