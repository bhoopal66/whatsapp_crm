import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { serverErrorResponse } from './server-error';

afterEach(() => vi.restoreAllMocks());

describe('serverErrorResponse', () => {
  it('logs the error and answers the generic message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = { message: 'relation "flows" does not exist' };
    const res = serverErrorResponse('GET /api/flows', err);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(log).toHaveBeenCalledWith('[GET /api/flows] failed:', err);
  });
});

describe('internal routes never answer 500 with a raw message', () => {
  const root = path.join(process.cwd(), 'src/app/api');
  const RAW =
    /error:\s*\w+\??\.message\s*(?:\?\?\s*'[^']*')?,?\s*\},?\s*\{\s*status:\s*500/;
  const routes = (fs.readdirSync(root, { recursive: true }) as string[]).filter(
    (f) => path.basename(f) === 'route.ts'
  );

  it('finds none', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(
      routes.filter((f) =>
        RAW.test(fs.readFileSync(path.join(root, f), 'utf8'))
      )
    ).toEqual([]);
  });
});
