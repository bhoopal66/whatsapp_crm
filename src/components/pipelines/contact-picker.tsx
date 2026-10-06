'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

export interface ContactOption {
  id: string;
  name: string | null;
  phone: string;
}

/** Pause after typing before asking the server. */
const SEARCH_DEBOUNCE_MS = 300;
/** Matches shown per search. */
const RESULT_LIMIT = 20;

/**
 * Strip the characters that are syntax inside a PostgREST `or=(…)`
 * filter, so a search like "Acme, Inc (UK)" narrows instead of
 * producing a malformed request.
 */
export function sanitizeContactSearch(term: string): string {
  return term.replace(/[,()"\\]/g, ' ').trim();
}

function label(c: ContactOption): string {
  return c.name || c.phone;
}

interface ContactPickerProps {
  /** The chosen contact, or null for "no selection". */
  selected: ContactOption | null;
  onChange: (contact: ContactOption | null) => void;
  placeholder: string;
}

/**
 * Server-side contact search for the deal sheet.
 *
 * The sheet used to download every contact (`select('*')`, the whole
 * table) each time it opened, just to fill a <select> — slow over the
 * tunnel and silently truncated past PostgREST's max-rows. This asks
 * for at most 20 matches by name/phone, debounced.
 */
export function ContactPicker({
  selected,
  onChange,
  placeholder,
}: ContactPickerProps) {
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContactOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const seq = useRef(0);
  const listId = useId();

  useEffect(() => {
    if (!focused) return;
    const mySeq = ++seq.current;
    const timer = setTimeout(
      async () => {
        setLoading(true);
        const supabase = createClient();
        let q = supabase
          .from('contacts')
          .select('id, name, phone')
          .order('name')
          .limit(RESULT_LIMIT);
        const term = sanitizeContactSearch(query);
        if (term) {
          const like = `%${term}%`;
          q = q.or(`name.ilike.${like},phone.ilike.${like}`);
        }
        const { data } = await q;
        if (mySeq !== seq.current) return; // superseded
        setResults((data ?? []) as ContactOption[]);
        setHighlight(0);
        setLoading(false);
      },
      // The first page on focus needs no typing pause.
      query ? SEARCH_DEBOUNCE_MS : 0
    );
    return () => clearTimeout(timer);
  }, [focused, query]);

  function choose(c: ContactOption) {
    onChange(c);
    setFocused(false);
    setQuery('');
  }

  return (
    <div className="relative">
      <input
        value={focused ? query : selected ? label(selected) : ''}
        onFocus={() => {
          setQuery('');
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            const c = results[highlight];
            if (c) {
              e.preventDefault();
              choose(c);
              (e.target as HTMLInputElement).blur();
            }
          } else if (e.key === 'Escape') {
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={focused && results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-primary h-9 w-full rounded-lg border px-2.5 pr-8 text-sm outline-none focus:ring-1"
      />
      {loading && focused ? (
        <Loader2 className="text-muted-foreground absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 animate-spin" />
      ) : (
        selected &&
        !focused && (
          <button
            type="button"
            aria-label={placeholder}
            onClick={() => onChange(null)}
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )
      )}

      {focused && results.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="border-border bg-popover absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border py-1 shadow-md"
        >
          {results.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={selected?.id === c.id}
              // mousedown, not click: fires before the input's blur
              // closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(c);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                'text-popover-foreground flex cursor-pointer items-baseline justify-between gap-2 px-2.5 py-1.5 text-sm',
                i === highlight && 'bg-muted'
              )}
            >
              <span className="truncate">{label(c)}</span>
              {c.name && (
                <span className="text-muted-foreground shrink-0 text-xs">
                  {c.phone}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
