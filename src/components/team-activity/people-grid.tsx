'use client';

import { Bot } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import type { PersonAssessment, Finding } from '@/lib/team-activity/risk';
import type { SenderActivity } from '@/lib/team-activity/report';

import {
  LevelIcon,
  StatusBadge,
  initials,
  useAdvice,
  useFindingCopy,
  useSenderName,
} from './shared';

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-foreground text-lg font-semibold tabular-nums">
        {value}
      </p>
      <p className="text-muted-foreground text-xs leading-snug">{label}</p>
    </div>
  );
}

function replied(s: SenderActivity, t: ReturnType<typeof useTranslations>) {
  return s.matureStarted > 0
    ? t('repliedValue', {
        replied: s.matureStarted - s.matureNoReply,
        total: s.matureStarted,
      })
    : '–';
}

/** One card per person: traffic light, three numbers, one line of advice. */
export function PeopleGrid({
  people,
  title,
  onOpen,
}: {
  people: PersonAssessment[];
  title: string;
  onOpen: (p: PersonAssessment) => void;
}) {
  const t = useTranslations('TeamActivity.people');
  const name = useSenderName();
  const advice = useAdvice();
  return (
    <section className="space-y-3" aria-labelledby="ta-people">
      <div>
        <h2 id="ta-people" className="text-foreground text-base font-semibold">
          {title}
        </h2>
        <p className="text-muted-foreground mt-0.5 text-sm">
          {t('description')}
        </p>
      </div>
      {people.length === 0 ? (
        <p className="border-border bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center text-sm">
          {t('empty')}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {people.map((p) => {
            const s = p.sender;
            const n = name(s);
            return (
              <li
                key={`${s.kind}:${s.userId ?? ''}`}
                className="border-border bg-card flex flex-col gap-3 rounded-xl border p-4"
              >
                <div className="flex items-start gap-3">
                  <Avatar className="h-9 w-9">
                    {s.avatarUrl && <AvatarImage src={s.avatarUrl} alt="" />}
                    <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                      {initials(n)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p
                      className="text-foreground truncate font-medium"
                      title={n}
                    >
                      {n}
                    </p>
                    <StatusBadge status={p.status} className="mt-1" />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Figure
                    label={t('newChats')}
                    value={s.chatsStarted.toLocaleString()}
                  />
                  <Figure label={t('replied')} value={replied(s, t)} />
                  <Figure
                    label={t('keptMessaging')}
                    value={(s.chaseNew + s.chaseExisting).toLocaleString()}
                  />
                </div>
                <p className="text-foreground text-sm">{advice(p)}</p>
                <button
                  type="button"
                  onClick={() => onOpen(p)}
                  className="text-primary mt-auto self-start text-sm font-medium hover:underline"
                >
                  {t('seeDetails')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Owner view only: the API and AI assistant, with the owner's findings. */
export function AutomaticSenders({
  senders,
  findings,
}: {
  senders: SenderActivity[];
  findings: Finding[];
}) {
  const t = useTranslations('TeamActivity.people');
  const name = useSenderName();
  const copy = useFindingCopy();
  if (senders.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="ta-automatic">
      <div>
        <h2
          id="ta-automatic"
          className="text-foreground text-base font-semibold"
        >
          {t('automaticTitle')}
        </h2>
        <p className="text-muted-foreground mt-0.5 text-sm">
          {t('automaticDescription')}
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {senders.map((s) => {
          const mine = findings.filter(
            (f) =>
              f.subject.type === 'person' && f.subject.senderKind === s.kind
          );
          return (
            <li
              key={s.kind}
              className="border-border bg-card space-y-3 rounded-xl border p-4"
            >
              <div className="flex items-center gap-2">
                <Bot className="text-muted-foreground h-4 w-4" aria-hidden />
                <p className="text-foreground font-medium">{name(s)}</p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Figure
                  label={t('newChats')}
                  value={s.chatsStarted.toLocaleString()}
                />
                <Figure label={t('replied')} value={replied(s, t)} />
                <Figure
                  label={t('messagesSent')}
                  value={s.messagesSent.toLocaleString()}
                />
              </div>
              {mine.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {t('automaticFine')}
                </p>
              ) : (
                <ul className="space-y-2">
                  {mine.map((f) => (
                    <li key={f.id} className="flex gap-2 text-sm">
                      <LevelIcon level={f.level} className="mt-0.5" />
                      <span className="text-foreground">{copy(f).body}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
