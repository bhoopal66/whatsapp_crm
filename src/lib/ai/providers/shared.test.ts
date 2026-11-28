/** providerHttpError keeps the provider's own status, which the HR agents' one retry (`lib/hr/agents/model.ts`) reads. */
import { describe, expect, it } from 'vitest';
import { isTransientModelError } from '@/lib/hr/agents/model';
import { providerHttpError } from './shared';

const res = (status: number) =>
  new Response(JSON.stringify({ error: { message: 'x' } }), { status });

describe('providerHttpError', () => {
  it('keeps the upstream status; only 429 and 5xx are transient', async () => {
    for (const [status, transient] of [
      [429, true],
      [500, true],
      [503, true],
      [400, false],
      [401, false],
      [404, false],
    ] as const) {
      const err = await providerHttpError('Anthropic', res(status));
      expect(err.upstreamStatus).toBe(status);
      expect(isTransientModelError(err), String(status)).toBe(transient);
    }
  });
});
