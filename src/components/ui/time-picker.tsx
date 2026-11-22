'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  formatClock,
  hourOptions,
  minuteOptions,
  pad2,
  parseClock,
} from '@/lib/time-of-day';
import { cn } from '@/lib/utils';

const HOURS = hourOptions();

/**
 * A 24-hour time of day ("HH:mm") as two small selects, hour and
 * minute. `value` that is not a readable time shows `fallback` (and
 * the first change writes a full time). Labels come from the caller so
 * the control stays locale-free.
 */
export function TimePicker({
  value,
  onChange,
  fallback = '09:00',
  minuteStep = 5,
  hourLabel,
  minuteLabel,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  fallback?: string;
  minuteStep?: number;
  hourLabel: string;
  minuteLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const clock = parseClock(value) ??
    parseClock(fallback) ?? { hour: 9, minute: 0 };
  const minutes = minuteOptions(minuteStep, clock.minute);

  return (
    <div className={cn('inline-flex items-center gap-1', className)}>
      <Select
        value={pad2(clock.hour)}
        onValueChange={(v) => {
          if (v == null) return;
          onChange(formatClock(Number(v), clock.minute));
        }}
        disabled={disabled}
      >
        <SelectTrigger aria-label={hourLabel} className="w-16 tabular-nums">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {HOURS.map((h) => (
            <SelectItem key={h} value={h} className="tabular-nums">
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span aria-hidden className="text-muted-foreground text-sm">
        :
      </span>
      <Select
        value={pad2(clock.minute)}
        onValueChange={(v) => {
          if (v == null) return;
          onChange(formatClock(clock.hour, Number(v)));
        }}
        disabled={disabled}
      >
        <SelectTrigger aria-label={minuteLabel} className="w-16 tabular-nums">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {minutes.map((m) => (
            <SelectItem key={m} value={m} className="tabular-nums">
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
