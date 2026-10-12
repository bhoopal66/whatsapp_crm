import {
  Crown,
  Landmark,
  Shield,
  UserCog,
  UserIcon,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

import type { AccountRole } from '@/lib/auth/roles';
import type { ChipVariant } from './settings-chip';

/**
 * Single source of truth for per-role chip metadata across settings
 * surfaces (the Overview identity chip and the Members roster/invite
 * chips). Previously duplicated in both files; hoisted here so a label,
 * icon, or colour change lands once.
 *
 * `variant` drives the token-based <SettingsChip>; `className` is the
 * inline Tailwind string the Members tab applies to its own spans.
 */
export const ROLE_META: Record<
  AccountRole,
  { icon: LucideIcon; label: string; variant: ChipVariant; className: string }
> = {
  owner: {
    icon: Crown,
    label: 'owner',
    variant: 'owner',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  },
  admin: {
    icon: Shield,
    label: 'admin',
    variant: 'admin',
    className: 'border-primary/40 bg-primary/10 text-primary',
  },
  team_leader: {
    icon: UsersRound,
    label: 'team leader',
    variant: 'admin',
    className: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  },
  agent: {
    icon: UserCog,
    label: 'agent',
    variant: 'muted',
    className: 'border-border bg-muted text-muted-foreground',
  },
  viewer: {
    icon: UserIcon,
    label: 'viewer',
    variant: 'muted',
    // Outline-only so it stays quieter than the filled Agent chip in
    // both modes — bg-card would blend into a card surface in light mode.
    className: 'border-border bg-transparent text-muted-foreground',
  },
  // A partner bank's guest (migrations 082/083): outside the staff
  // ladder, so it gets its own lavender rather than a rung's colour.
  bank_guest: {
    icon: Landmark,
    label: 'bank_guest',
    variant: 'muted',
    className:
      'border-violet-500/30 bg-violet-500/10 text-violet-700 [[data-mode=dark]_&]:text-violet-300',
  },
};
