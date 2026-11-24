import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// A wide table scrolls inside its own box. Text for screen readers
// (`sr-only`) and a checkbox's hidden input are positioned absolutely, and
// with no positioned ancestor inside the box they are laid out against the
// page: Settings → Team chat was 247 px wider than a phone because of one
// such cell. So a box that scrolls sideways around a table is `relative`.
const ROOT = join(process.cwd(), 'src/components');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

it('a sideways-scrolling box around a table is positioned', () => {
  const bad: string[] = [];
  for (const path of files(ROOT)) {
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(
      /className="([^"]*\boverflow-x-auto\b[^"]*)"[^>]*>\s*<table\b/g
    )) {
      if (!/\b(relative|absolute|sticky|fixed)\b/.test(m[1])) {
        bad.push(`${path.slice(ROOT.length + 1)}: ${m[1]}`);
      }
    }
  }
  expect(bad).toEqual([]);
});
