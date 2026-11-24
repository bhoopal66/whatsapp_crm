import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// No DOM here: what the in-call list does with the API's `truncated`.
const src = readFileSync('src/components/pbx/call-tasks.tsx', 'utf8');

it('says when the API held tasks back, with a link to the rest', () => {
  expect(src).toContain('body.truncated === true');
  expect(src).toMatch(/\{mine\.more && \(\s*<Link\s+href=\{customerPath\(/);
});

it('reads the next ones after a tick while there are more', () => {
  expect(src).toContain('if (mine?.more) setRound((n) => n + 1);');
  expect(src).toContain('}, [contactId, round]);');
});
