import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The Team activity page is read by team leaders who are not
// technical: none of its copy may use the words the old page did.
// ICU argument names ({start}) are not shown, so they are stripped.
const BANNED =
  /\b(starts?|runs?|bursts?|openers?|providers?|whapi|meta|cloud api|median|p50|range|kind)\b/i;

function leaves(node: unknown, path: string, out: [string, string][]) {
  if (typeof node === 'string') out.push([path, node]);
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) leaves(v, `${path}.${k}`, out);
  return out;
}

describe('Team activity copy', () => {
  it('uses none of the banned words (en)', () => {
    const en = JSON.parse(
      readFileSync(join(process.cwd(), 'messages', 'en.json'), 'utf8')
    );
    const offending = leaves(en.TeamActivity, 'TeamActivity', [])
      .map(([k, v]) => [k, v.replace(/\{\s*\w+/g, '{')] as const)
      .filter(([, v]) => BANNED.test(v))
      .map(([k]) => k);
    expect(offending).toEqual([]);
  });
});
