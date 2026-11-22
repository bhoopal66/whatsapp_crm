import { Fragment, type ReactNode } from 'react';

import { parseBody, type Block, type Inline } from '@/lib/chat/format';
import type { ChatPerson } from '@/lib/chat/types';
import { cn } from '@/lib/utils';

/** The mention chip, as message-row has always drawn it. */
export const MENTION_CHIP =
  'rounded px-1 font-semibold bg-primary-soft text-primary';
const CODE = 'bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]';

export interface RichTextProps {
  body: string;
  people: ReadonlyArray<Pick<ChatPerson, 'userId' | 'fullName'>>;
  /** Shown for a mention of someone not in `people`. */
  unknownName: string;
  /** Rendered inline at the end of the last paragraph (e.g. "edited"). */
  trailing?: ReactNode;
  className?: string;
}

function inline(nodes: Inline[], unknownName: string): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text':
        return <Fragment key={i}>{n.text}</Fragment>;
      case 'break':
        return <br key={i} />;
      case 'bold':
        return <strong key={i}>{inline(n.children, unknownName)}</strong>;
      case 'italic':
        return <em key={i}>{inline(n.children, unknownName)}</em>;
      case 'strike':
        return <s key={i}>{inline(n.children, unknownName)}</s>;
      case 'code':
        return (
          <code key={i} className={CODE}>
            {n.text}
          </code>
        );
      case 'link':
        return (
          <a
            key={i}
            href={n.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-primary break-words underline underline-offset-2"
          >
            {n.href}
          </a>
        );
      case 'mention':
        return (
          <span key={i} className={MENTION_CHIP}>
            @{n.name ?? unknownName}
          </span>
        );
      case 'broadcast':
        return (
          <span key={i} className={MENTION_CHIP}>
            @{n.kind}
          </span>
        );
    }
  });
}

function block(b: Block, key: number, u: string, trailing: ReactNode) {
  switch (b.type) {
    case 'paragraph':
      return (
        <p key={key} dir="auto" className="whitespace-pre-wrap">
          {inline(b.content, u)}
          {trailing}
        </p>
      );
    case 'quote':
      return (
        <blockquote
          key={key}
          dir="auto"
          className="text-muted-foreground border-border border-s-4 ps-3 whitespace-pre-wrap"
        >
          {inline(b.content, u)}
        </blockquote>
      );
    case 'code':
      return (
        <pre
          key={key}
          className="bg-muted overflow-x-auto rounded-md px-3 py-2 font-mono text-xs"
        >
          <code>{b.text}</code>
        </pre>
      );
    case 'bullets':
      return (
        <ul key={key} dir="auto" className="list-disc ps-5">
          {b.items.map((it, i) => (
            <li key={i}>{inline(it, u)}</li>
          ))}
        </ul>
      );
    case 'numbered':
      return (
        <ol key={key} dir="auto" start={b.start} className="list-decimal ps-5">
          {b.items.map((it, i) => (
            <li key={i}>{inline(it, u)}</li>
          ))}
        </ol>
      );
  }
}

/** A team-chat message body with WhatsApp-style formatting (React elements only). */
export function RichText({
  body,
  people,
  unknownName,
  trailing,
  className,
}: RichTextProps) {
  const blocks = parseBody(body, people);
  const last = blocks.length - 1;
  const inLast = blocks[last]?.type === 'paragraph';
  return (
    <div className={cn('space-y-1 text-sm break-words', className)}>
      {blocks.map((b, i) =>
        block(b, i, unknownName, i === last && inLast ? trailing : null)
      )}
      {!inLast && trailing}
    </div>
  );
}
