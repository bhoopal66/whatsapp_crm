import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Migration 321 lets a signed-in person write chat-media and flow-media
// only as an agent or above of the account folder's workspace. The
// browser's uploaders all write account-<id>/ (uploadAccountMedia), so a
// change to who may write, or to the folder test, fails here first.

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/321_media_upload_role.sql'),
  'utf8'
);

describe('321: who writes WhatsApp media from a session', () => {
  it('is three restrictive policies, one per write', () => {
    const made = [
      ...SQL.matchAll(
        /'CREATE POLICY "([^"]+)"'\s*' ON storage\.objects AS RESTRICTIVE FOR (\w+) TO authenticated'/g
      ),
    ].map((m) => `${m[2]} ${m[1]}`);
    expect(made).toEqual([
      'INSERT WhatsApp media is uploaded by agents and up',
      'UPDATE WhatsApp media is changed by agents and up',
      'DELETE WhatsApp media is deleted by agents and up',
    ]);
    for (const name of made.map((m) => m.split(' ').slice(1).join(' '))) {
      expect(SQL).toContain(
        `DROP POLICY IF EXISTS "${name}" ON storage.objects;`
      );
    }
  });

  it('needs an agent of the folder workspace in the two buckets', () => {
    expect(SQL).toContain(
      "'(bucket_id NOT IN (''chat-media'', ''flow-media'') OR coalesce(CASE'"
    );
    expect(SQL).toMatch(
      /public\.is_account_member\('\s*'substr\(\(storage\.foldername\(name\)\)\[1\], 9\)::uuid,'\s*' ''agent''::public\.account_role_enum\)'/
    );
  });

  it('casts the folder to a uuid only once it is account-<uuid>', () => {
    const when = SQL.indexOf(
      "~ ''^account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''"
    );
    const cast = SQL.indexOf('::uuid');
    expect(when).toBeGreaterThan(-1);
    expect(cast).toBeGreaterThan(when);
    expect(SQL).toContain("' ELSE false END, false))'");
  });

  it('checks both rows of an update', () => {
    expect(SQL).toContain("' USING (%s) WITH CHECK (%s)', v_writer, v_writer)");
  });
});
