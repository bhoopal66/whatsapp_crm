'use client';

// The Calls screen's keypad (?tab=keypad): any extension or outside
// number, dialled through the dial route like every Call button
// (useDial), so do-not-contact still applies. A live call's DTMF tones
// belong to the in-call panel's own keypad, not this one.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Delete, Phone } from 'lucide-react';

import { useCalls } from '@/components/pbx/call-provider';
import { useDial } from '@/components/pbx/use-dial';
import { Button } from '@/components/ui/button';
import {
  canDialInput,
  cleanDialInput,
  pushRecentDial,
  readRecentDials,
} from '@/lib/pbx/call-ui';
import { callsSidebar } from '@/lib/pbx/timeline';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
const RECENT_KEY = 'pbx:recent-dials';

export function Keypad() {
  const t = useTranslations('CallsPage.keypad');
  const tc = useTranslations('PbxCall');
  const tl = useTranslations('ChatCalls');
  const calls = useCalls();
  const { busy, dial } = useDial();
  const [value, setValue] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  // Read after mount: the server render has no localStorage.
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => readRecentDials(localStorage.getItem(RECENT_KEY)))
      .catch(() => [] as string[]) // storage off (private mode)
      .then((list) => live && setRecent(list));
    return () => {
      live = false;
    };
  }, []);

  if (!calls?.me)
    return <p className="text-muted-foreground text-sm">{tc('noExtension')}</p>;
  const line = callsSidebar({
    isBankGuest: false,
    me: calls.me,
    workspaceHasPbx: true,
    softphone: calls.softphoneState.status,
  }).line;

  const call = async (raw: string) => {
    const number = cleanDialInput(raw);
    if (!canDialInput(number) || busy) return;
    const r = await dial({ number }, { success: t('ringing', { number }) });
    if (r?.kind !== 'ok') return;
    const next = pushRecentDial(recent, number);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // storage full or off: the list just isn't kept
    }
  };
  const ready = canDialInput(value) && !busy;

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,20rem)_1fr]">
      <form
        className="border-border bg-card space-y-3 rounded-xl border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void call(value);
        }}
      >
        {line && (
          <p className="text-muted-foreground text-xs">
            {tl(line.kind, { ext: line.extension })}
          </p>
        )}
        <div className="flex items-center gap-2">
          <input
            value={value}
            onChange={(e) => setValue(cleanDialInput(e.target.value))}
            inputMode="tel"
            autoComplete="off"
            aria-label={t('number')}
            placeholder={t('number')}
            className="border-input bg-card dark:bg-background h-11 min-w-0 flex-1 rounded-lg border px-3 text-lg tabular-nums"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('backspace')}
            disabled={!value}
            onClick={() => setValue((v) => v.slice(0, -1))}
          >
            <Delete className="size-4" />
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {KEYS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setValue((v) => cleanDialInput(v + k))}
              className="bg-muted hover:bg-muted/70 h-12 rounded-lg text-lg font-semibold tabular-nums"
            >
              {k}
            </button>
          ))}
        </div>
        <Button
          type="submit"
          disabled={!ready}
          className="w-full bg-emerald-600 text-white hover:bg-emerald-500 disabled:bg-emerald-600/50"
        >
          <Phone className="size-4" />
          {tc('call')}
        </Button>
      </form>
      <section>
        <h2 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
          {t('recent')}
        </h2>
        {recent.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noRecent')}</p>
        ) : (
          <ul className="border-border bg-card overflow-hidden rounded-xl border">
            {recent.map((n) => (
              <li
                key={n}
                className="border-border flex items-center gap-3 border-b px-4 py-2 last:border-b-0"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left tabular-nums hover:underline"
                  onClick={() => setValue(n)}
                >
                  {n}
                </button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void call(n)}
                >
                  <Phone className="size-4" />
                  {tc('call')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
