import { FileText, Forward, Mic } from 'lucide-react';

import type { ChatMessage, ChatPerson } from '@/lib/chat';
import { quotePreview } from '@/lib/chat/quotes';
import { quoteTint } from '@/lib/chat/view';
import { cn } from '@/lib/utils';

type People = ReadonlyArray<Pick<ChatPerson, 'userId' | 'fullName'>>;

/** Chat.quote's keys a quote block reads. */
export type QuoteLabelKey =
  'loading' | 'deleted' | 'erased' | 'unavailable' | 'voice' | 'jumpLabel';

export type QuoteLabel = (
  key: QuoteLabelKey,
  values?: Record<string, string>
) => string;

function nameOf(people: People, authorId: string): string | null {
  const id = authorId.toLowerCase();
  return people.find((p) => p.userId.toLowerCase() === id)?.fullName ?? null;
}

const BOX = 'mb-1 block w-full max-w-md rounded-e-md border-s-2 px-2 py-1';

/**
 * The quoted message above a reply (156's reply_to_id). `target`
 * undefined = still loading, null = not readable or gone. Clickable
 * only when there is a message to jump to and the view can (onJump).
 * Presentational, so it renders without the chat providers.
 */
export function QuoteBlock({
  target,
  people,
  unknownName,
  systemName,
  label,
  onJump,
}: {
  target: ChatMessage | null | undefined;
  people: People;
  unknownName: string;
  systemName: string;
  label: QuoteLabel;
  onJump?: () => void;
}) {
  if (target === undefined)
    return (
      <div
        aria-busy="true"
        className={cn(
          BOX,
          'border-border text-muted-foreground bg-muted/40 text-xs'
        )}
      >
        {label('loading')}
      </div>
    );
  const preview = quotePreview(target, people, unknownName);
  if (preview.kind === 'unavailable')
    return (
      <div
        className={cn(
          BOX,
          'border-border text-muted-foreground bg-muted/40 text-xs italic'
        )}
      >
        {label('unavailable')}
      </div>
    );
  const name =
    target?.authorKind === 'system'
      ? systemName
      : preview.authorId
        ? (nameOf(people, preview.authorId) ?? unknownName)
        : unknownName;

  let line: React.ReactNode;
  switch (preview.kind) {
    case 'deleted':
    case 'erased':
      line = <span className="italic">{label(preview.kind)}</span>;
      break;
    case 'voice':
      line = (
        <>
          <Mic className="me-1 inline size-3.5 align-[-2px]" aria-hidden />
          {label('voice', { length: preview.text })}
        </>
      );
      break;
    case 'file':
      line = (
        <>
          <FileText className="me-1 inline size-3.5 align-[-2px]" aria-hidden />
          {preview.text}
        </>
      );
      break;
    default:
      line = preview.text;
  }

  const content = (
    <>
      <span className="block truncate text-xs font-bold">{name}</span>
      {line !== '' && (
        <span className="text-muted-foreground block truncate text-xs">
          {line}
        </span>
      )}
    </>
  );
  const box = cn(BOX, 'bg-muted/40', quoteTint(preview.authorId));
  return onJump ? (
    <button
      type="button"
      onClick={onJump}
      title={label('jumpLabel', { name })}
      className={cn(box, 'hover:bg-muted text-start')}
    >
      {content}
    </button>
  ) : (
    <div className={box}>{content}</div>
  );
}

/**
 * "Forwarded" (or "Forwarded from <name>") and the original's date
 * above a forwarded copy. Never the source channel: the reader may not
 * be in it.
 */
export function ForwardedLine({ text }: { text: string }) {
  return (
    <p className="text-muted-foreground mb-0.5 flex items-center gap-1 text-xs">
      <Forward className="size-3.5 shrink-0 rtl:rotate-180" aria-hidden />
      <span className="truncate">{text}</span>
    </p>
  );
}

/** The ForwardedLine text: the author's name only when it is known. */
export function forwardedText(
  forwarded: NonNullable<ChatMessage['forwarded']>,
  people: People,
  date: string,
  label: (
    key: 'forwarded' | 'forwardedFrom',
    values: Record<string, string>
  ) => string
): string {
  const name =
    forwarded.authorKind === 'user' && forwarded.authorId
      ? nameOf(people, forwarded.authorId)
      : null;
  return name
    ? label('forwardedFrom', { name, date })
    : label('forwarded', { date });
}
