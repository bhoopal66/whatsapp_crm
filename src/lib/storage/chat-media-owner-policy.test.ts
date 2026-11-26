import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GROUP_MEDIA_FOLDER } from '@/lib/groups/outbound-media';
import { STAGED_MEDIA_SUBFOLDER } from '@/lib/storage/staged-media';

// Migration 283 lets a signed-in person upload into chat-media at the top
// of the account folder and in these subfolders, and nowhere else. A new
// folder the browser uploads to fails here first, not in production.

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/283_chat_media_owner.sql'),
  'utf8'
);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('283: the folders a browser uploads into', () => {
  it("lists the app's own subfolders", () => {
    const list = /\[2\] IN \(([^)]*)\)/.exec(SQL)?.[1] ?? '';
    const folders = [...list.matchAll(/''([a-z-]+)''/g)].map((m) => m[1]);
    expect(folders.sort()).toEqual(
      [GROUP_MEDIA_FOLDER, STAGED_MEDIA_SUBFOLDER].sort()
    );
  });

  it('covers every subfolder passed to uploadAccountMedia', () => {
    const used = new Set<string>();
    for (const p of sources(join(process.cwd(), 'src'))) {
      const text = readFileSync(p, 'utf8');
      if (!text.includes('uploadAccountMedia(')) continue;
      for (const m of text.matchAll(/\bsubfolder: ([^,}\s]+)/g)) used.add(m[1]);
    }
    expect([...used].sort()).toEqual([
      'GROUP_MEDIA_FOLDER',
      'STAGED_MEDIA_SUBFOLDER',
    ]);
  });
});
