import { describe, expect, it } from 'vitest';
import {
  openwaMediaIdFor,
  planDocRepair,
  sqlLiteral,
} from './media-collision-repair';

describe('openwaMediaIdFor', () => {
  it('rebuilds <chat>/<message id> from a whatsapp-web.js id', () => {
    const id = 'false_103079248711825@lid_3EB0A1B2C3D4E5F6';
    expect(openwaMediaIdFor(id)).toBe(`103079248711825@lid/${id}`);
    const cus = 'false_971501234567@c.us_ABCDEF0123';
    expect(openwaMediaIdFor(cus)).toBe(`971501234567@c.us/${cus}`);
  });

  it('refuses anything else', () => {
    expect(openwaMediaIdFor('wamid.HBgM')).toBeNull();
    expect(openwaMediaIdFor('false_x_y_z')).toBeNull();
    expect(openwaMediaIdFor('false_1@lid_a/b')).toBeNull();
  });
});

describe('planDocRepair', () => {
  const real = 'a'.repeat(64);
  const wrong = 'b'.repeat(64);

  it('keeps a stored copy that already holds the right bytes', () => {
    expect(
      planDocRepair({ id: '1', status: 'stored', sha256: real }, real, real)
    ).toBe('keep');
  });

  it('moves aside a stored copy of another document', () => {
    expect(
      planDocRepair({ id: '1', status: 'stored', sha256: wrong }, real, wrong)
    ).toBe('quarantine');
    // The row says right, the file on the NAS says otherwise.
    expect(
      planDocRepair({ id: '1', status: 'stored', sha256: real }, real, wrong)
    ).toBe('quarantine');
  });

  it('resets a stored row whose file is missing', () => {
    expect(
      planDocRepair({ id: '1', status: 'stored', sha256: wrong }, real, null)
    ).toBe('reset');
  });

  it('resets duplicates and failures, keeps pending', () => {
    expect(
      planDocRepair({ id: '1', status: 'duplicate', sha256: real }, real, null)
    ).toBe('reset');
    expect(
      planDocRepair({ id: '1', status: 'failed', sha256: null }, real, null)
    ).toBe('reset');
    expect(
      planDocRepair({ id: '1', status: 'pending', sha256: null }, real, null)
    ).toBe('keep');
  });
});

describe('sqlLiteral', () => {
  it('doubles quotes', () => {
    expect(sqlLiteral("it's")).toBe("'it''s'");
  });
});
