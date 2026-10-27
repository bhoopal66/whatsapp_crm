import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Form fields keep the field primitive's fill. Light mode puts soft-white
 * cards on a tinted canvas, so a field overridden with `bg-muted` or the
 * canvas `bg-background` reads as a grey hole beside every standard
 * field; 166 of them had to be swept in 2026-10. Input / Textarea /
 * SelectTrigger own their fill (`bg-card`, dark `bg-input/30`), and a
 * native field pairs `bg-card` with a `dark:` fill. Only a read-only
 * field may be grey: there it says "not editable".
 */
const SRC = join(process.cwd(), 'src');
const FIELD = /<(Input|Textarea|SelectTrigger|select|input|textarea)\b/g;
// A whole base token: not a variant (dark:bg-muted) or an opacity form.
const GREY = /(?<![\w:/\-[])bg-(muted|background|secondary)(?![\w/-])/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.tsx') && !name.endsWith('.test.tsx') ? [path] : [];
  });
}

/** The JSX opening tag starting at `start`, braces and strings skipped. */
function openingTag(code: string, start: number): string | null {
  let depth = 0;
  for (let i = start + 1; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || (c === '`' && depth > 0)) {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      i = j;
    } else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return code.slice(start, i + 1);
  }
  return null;
}

function greyFields(): string[] {
  const out: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    if (rel.startsWith(join('components', 'ui'))) continue;
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(FIELD)) {
      const lineStart = code.lastIndexOf('\n', m.index) + 1;
      if (/^\s*(\/\/|\*|\/\*)/.test(code.slice(lineStart, m.index))) continue;
      const tag = openingTag(code, m.index);
      if (!tag || /\breadOnly\b/.test(tag)) continue;
      if (/type=["'](checkbox|radio|file|hidden|range|color)["']/.test(tag))
        continue;
      if (GREY.test(tag)) {
        const line = code.slice(0, m.index).split('\n').length;
        out.push(`${rel}:${line} <${m[1]}>`);
      }
    }
  }
  return out;
}

describe('field fill', () => {
  it('no editable field overrides the field fill with a grey one', () => {
    expect(greyFields()).toEqual([]);
  });
});
