import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { twMerge } from 'tailwind-merge';
import { describe, expect, it } from 'vitest';

/** Every .tsx file under src/components. */
function components(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? components(join(dir, e.name))
      : e.name.endsWith('.tsx')
        ? [join(dir, e.name)]
        : []
  );
}

// DialogContent centres itself with a physical left-1/2. A phone sheet that
// cancels the translate must also replace that left edge: tailwind-merge
// does not let a logical start-0 remove it, and the sheet then opens with
// its right half off the screen.
describe('a dialog that becomes a phone sheet', () => {
  it('a logical start edge does not replace the centring', () => {
    expect(
      twMerge('left-1/2 -translate-x-1/2', 'start-0 translate-x-0')
    ).toContain('left-1/2');
    expect(
      twMerge('left-1/2 -translate-x-1/2', 'left-0 translate-x-0')
    ).not.toContain('left-1/2');
  });

  it('no dialog cancels the centring with a logical start edge', () => {
    const bad = components(join(process.cwd(), 'src', 'components')).filter(
      (file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .some(
            (line) =>
              /(^|['"\s])start-0(\s|['"])/.test(line) &&
              /(^|['"\s])translate-x-0(\s|['"])/.test(line)
          )
    );
    expect(bad.map((f) => f.split('/src/')[1])).toEqual([]);
  });
});
