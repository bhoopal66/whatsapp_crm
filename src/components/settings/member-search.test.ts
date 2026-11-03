import { describe, expect, it } from 'vitest';

import { filterMembers, inactiveLast, searchWords } from './member-search';

const label = (r: string) =>
  ({ team_leader: 'Team leader', agent: 'Agent', bank_guest: 'Bank guest' })[
    r
  ] ?? r;

const people = [
  { full_name: 'Sara Khan', email: 'sara@taamul.ae', role: 'agent' },
  { full_name: 'José Ortiz', email: 'jose@taamul.ae', role: 'team_leader' },
  {
    full_name: 'Bank Person',
    email: 'p@adcb.ae',
    role: 'bank_guest',
    bank_code: 'ADCB',
  },
  { full_name: '', email: null, role: 'viewer' },
];
const names = (q: string) =>
  filterMembers(people, q, label).map((p) => p.full_name);

describe('member search', () => {
  it('keeps everyone for an empty or blank query', () => {
    expect(names('')).toHaveLength(4);
    expect(names('   ')).toHaveLength(4);
    expect(searchWords('  a  B ')).toEqual(['a', 'b']);
  });
  it('matches name and email, ignoring case and accents', () => {
    expect(names('SARA')).toEqual(['Sara Khan']);
    expect(names('jose')).toEqual(['José Ortiz']);
    expect(names('josé')).toEqual(['José Ortiz']);
    expect(names('taamul.ae')).toEqual(['Sara Khan', 'José Ortiz']);
  });
  it('matches the role as shown and its key, and a bank code', () => {
    expect(names('team leader')).toEqual(['José Ortiz']);
    expect(names('team_leader')).toEqual([]);
    expect(names('adcb')).toEqual(['Bank Person']);
  });
  it('needs every word to match somewhere', () => {
    expect(names('sara agent')).toEqual(['Sara Khan']);
    expect(names('sara leader')).toEqual([]);
  });
});

describe('inactiveLast', () => {
  it('moves deactivated people to the bottom, keeping each group in order', () => {
    const list = [
      { id: 'a', deactivated_at: '2026-10-01T00:00:00Z' },
      { id: 'b', deactivated_at: null },
      { id: 'c', deactivated_at: '2026-09-01T00:00:00Z' },
      { id: 'd', deactivated_at: null },
    ];
    expect(inactiveLast(list).map((m) => m.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(list.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
