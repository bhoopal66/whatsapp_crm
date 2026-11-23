import { expect, it, vi } from 'vitest';

import { sfuErrorResponse } from './server';
import { SfuError } from './sfu';

it('tells the room a refusal by Cloudflare from an outage, and logs why', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const body = async (status: number) =>
    sfuErrorResponse(new SfuError('x', status, 'code', 'why'))?.json();
  expect(await body(400)).toMatchObject({ sfuStatus: 400 });
  expect(await body(502)).not.toHaveProperty('sfuStatus');
  expect(log).toHaveBeenCalledWith(
    '[meetings] sfu call failed',
    400,
    'code',
    'why'
  );
  log.mockRestore();
});
