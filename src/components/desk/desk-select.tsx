'use client';

/**
 * The desk's pick list: the app's Select with a plain options array, so a
 * form shows labels ("Trade licence"), never the stored id. An empty
 * value stands for "nothing chosen" and shows the placeholder.
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface DeskOption {
  value: string;
  label: string;
  disabled?: boolean;
}

// base-ui treats '' as "no value", so "nothing" gets a real sentinel.
const NONE = '__none__';

export function DeskSelect({
  id,
  value,
  onChange,
  options,
  placeholder,
  noneLabel,
  disabled,
  ariaLabel,
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly DeskOption[];
  /** Shown while nothing is chosen. */
  placeholder: string;
  /** When set, the list starts with this entry, which chooses nothing. */
  noneLabel?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <Select
      value={value === '' ? NONE : value}
      onValueChange={(v) => {
        const next = v == null || v === NONE ? '' : String(v);
        onChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        className={className ?? 'w-full'}
      >
        <SelectValue>
          {current
            ? current.label
            : value === '' && noneLabel
              ? noneLabel
              : placeholder}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {noneLabel !== undefined && (
          <SelectItem value={NONE}>{noneLabel}</SelectItem>
        )}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
