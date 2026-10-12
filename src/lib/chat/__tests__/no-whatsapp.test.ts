// Internal chat must never reach the WhatsApp send path (the 014b
// package carried the same guard): no module under src/lib/chat may
// import anything from src/lib/whatsapp, by alias or relative path.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHAT = resolve(__dirname, '..');
const SRC = resolve(CHAT, '../..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : []
  );
}

/** Import / export-from / dynamic-import / require specifiers that resolve into src/lib/whatsapp. */
export function whatsappImports(file: string, code: string): string[] {
  const specs = [
    ...code.matchAll(
      /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g
    ),
  ].map((m) => m[1]);
  return specs.filter((s) => {
    const abs = s.startsWith('@/')
      ? join(SRC, s.slice(2))
      : s.startsWith('.')
        ? resolve(dirname(file), s)
        : s;
    const rel = relative(join(SRC, 'lib/whatsapp'), abs);
    return (
      /whatsapp/i.test(s) || !(rel.startsWith('..') || resolve(rel) === rel)
    );
  });
}

describe('internal chat is isolated from WhatsApp', () => {
  it('the checker catches alias, relative and dynamic imports', () => {
    const f = join(CHAT, 'x.ts');
    expect(
      whatsappImports(
        f,
        `import { sendMessage } from '@/lib/whatsapp/send-message';`
      )
    ).toHaveLength(1);
    expect(
      whatsappImports(f, `export * from "../whatsapp/provider";`)
    ).toHaveLength(1);
    expect(
      whatsappImports(f, `const m = await import('../whatsapp');`)
    ).toHaveLength(1);
    expect(whatsappImports(f, `import { cn } from '@/lib/utils';`)).toEqual([]);
  });

  it('no file under src/lib/chat imports from src/lib/whatsapp', () => {
    const files = sources(CHAT);
    expect(files.length).toBeGreaterThan(5);
    const hits = files.flatMap((f) =>
      whatsappImports(f, readFileSync(f, 'utf8'))
        .filter(() => !f.endsWith('no-whatsapp.test.ts'))
        .map((s) => `${relative(SRC, f)}: ${s}`)
    );
    expect(hits).toEqual([]);
  });
});
