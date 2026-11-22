'use client';

/**
 * The case desk's Companies tab (migration 229, design 035 D1): find a
 * company by licence or name, see who acts for it (role, authorised,
 * linked from a case or by a person) and, where the caller may, link or
 * unlink contacts. A link opens nothing to anyone; routing reads it and
 * never files by phone alone.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
  ContactPicker,
  type ContactOption,
} from '@/components/pipelines/contact-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DESK_CONTACT_ROLES,
  type DeskCompany,
  type DeskCompanyContact,
  type DeskContactRole,
} from '@/lib/desk/companies';

import { CompanyBanks } from './company-banks';
import { deskApi } from './desk-api';
import { DeskSelect } from './desk-select';

export function CompaniesTab() {
  const t = useTranslations('Desk');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DeskCompany[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<DeskCompany | null>(null);

  const search = async () => {
    const q = query.trim();
    if (q.length < 2) return;
    setBusy(true);
    const r = await deskApi.companies(q);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    setResults(r.data);
    setPicked(
      (p) => r.data.find((c) => c.customerId === p?.customerId) ?? null
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-sm">
            {t('companies.intro')}
          </p>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <Input
              className="min-w-0 flex-1"
              value={query}
              maxLength={200}
              placeholder={t('companies.search')}
              aria-label={t('companies.search')}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={busy || query.trim().length < 2}
            >
              {t('companies.searchButton')}
            </Button>
          </form>
          {results !== null && results.length === 0 && (
            <p className="text-muted-foreground text-sm">
              {t('companies.noResults')}
            </p>
          )}
          {results !== null && results.length > 0 && (
            <ul className="divide-border divide-y rounded-md border">
              {results.map((c) => (
                <li key={c.customerId}>
                  <button
                    type="button"
                    onClick={() => setPicked(c)}
                    aria-pressed={picked?.customerId === c.customerId}
                    className={`hover:bg-muted/60 flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-start text-sm ${
                      picked?.customerId === c.customerId ? 'bg-muted' : ''
                    }`}
                  >
                    <span className="text-foreground font-medium">
                      {c.legalName}
                    </span>
                    <span className="text-muted-foreground font-mono text-xs">
                      {t('companies.licence', { licence: c.tradeLicenceNo })}
                    </span>
                    {c.appNumber && (
                      <span className="text-muted-foreground font-mono text-xs">
                        {c.appNumber}
                      </span>
                    )}
                    <span className="text-muted-foreground ms-auto text-xs">
                      {t('companies.contactsCount', { count: c.contacts })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {picked && (
        <>
          <CompanyPeople
            key={picked.customerId}
            company={picked}
            onChanged={() => void search()}
          />
          <CompanyBanks key={`banks-${picked.customerId}`} company={picked} />
        </>
      )}
    </div>
  );
}

function CompanyPeople({
  company,
  onChanged,
}: {
  company: DeskCompany;
  onChanged: () => void;
}) {
  const t = useTranslations('Desk');
  const [people, setPeople] = useState<DeskCompanyContact[] | null>(null);
  const [contact, setContact] = useState<ContactOption | null>(null);
  const [role, setRole] = useState<DeskContactRole>('pro');
  const [authorised, setAuthorised] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      deskApi.companyContacts(company.customerId).then((r) => {
        if (r.ok) setPeople(r.data);
        else {
          toast.error(r.error);
          setPeople([]);
        }
      }),
    [company.customerId]
  );
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (
    contactId: string,
    nextRole: DeskContactRole,
    nextAuthorised: boolean
  ) => {
    setBusy(true);
    const r = await deskApi.setCompanyContact(
      company.customerId,
      contactId,
      nextRole,
      nextAuthorised
    );
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return false;
    }
    toast.success(t('companies.saved'));
    await load();
    onChanged();
    return true;
  };

  const remove = async (contactId: string) => {
    setBusy(true);
    const r = await deskApi.removeCompanyContact(company.customerId, contactId);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(t('companies.removed'));
    await load();
    onChanged();
  };

  return (
    <Card>
      <CardContent className="space-y-4">
        <h2 className="text-foreground text-base font-semibold">
          {t('companies.people', { company: company.legalName })}
        </h2>
        {people === null && (
          <p className="text-muted-foreground text-sm">{t('loading')}</p>
        )}
        {people !== null && people.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {t('companies.noPeople')}
          </p>
        )}
        {people !== null && people.length > 0 && (
          <ul className="divide-border divide-y rounded-md border">
            {people.map((p) => (
              <li
                key={p.contactId}
                className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
              >
                <span className="text-foreground min-w-0 font-medium break-words">
                  <bdi>{p.name ?? p.phone ?? p.contactId}</bdi>
                </span>
                {p.phone && (
                  <span className="text-muted-foreground font-mono text-xs">
                    <span dir="ltr">{p.phone}</span>
                  </span>
                )}
                {p.automatic && (
                  <Badge variant="outline">{t('companies.automatic')}</Badge>
                )}
                <span className="ms-auto flex flex-wrap items-center gap-2">
                  {company.canManage ? (
                    <>
                      <DeskSelect
                        className="w-40"
                        value={p.role}
                        disabled={busy}
                        ariaLabel={t('companies.role')}
                        placeholder={t('companies.role')}
                        onChange={(v) =>
                          void save(
                            p.contactId,
                            v as DeskContactRole,
                            p.authorised
                          )
                        }
                        options={DESK_CONTACT_ROLES.map((r) => ({
                          value: r,
                          label: t(`companies.roles.${r}`),
                        }))}
                      />
                      <label className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={p.authorised}
                          disabled={busy}
                          onChange={(e) =>
                            void save(p.contactId, p.role, e.target.checked)
                          }
                        />
                        {t('companies.authorised')}
                      </label>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void remove(p.contactId)}
                      >
                        {t('companies.remove')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Badge variant="secondary">
                        {t(`companies.roles.${p.role}`)}
                      </Badge>
                      <span className="text-muted-foreground text-xs">
                        {p.authorised
                          ? t('companies.authorised')
                          : t('companies.notAuthorised')}
                      </span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {company.canManage ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
            <div className="min-w-0 space-y-1.5">
              <Label>{t('companies.add')}</Label>
              <ContactPicker
                selected={contact}
                onChange={setContact}
                placeholder={t('companies.contactPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="desk-company-role">{t('companies.role')}</Label>
              <DeskSelect
                id="desk-company-role"
                value={role}
                placeholder={t('companies.role')}
                onChange={(v) => setRole(v as DeskContactRole)}
                options={DESK_CONTACT_ROLES.map((r) => ({
                  value: r,
                  label: t(`companies.roles.${r}`),
                }))}
              />
            </div>
            <label className="flex h-9 items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={authorised}
                onChange={(e) => setAuthorised(e.target.checked)}
              />
              {t('companies.authorised')}
            </label>
            <Button
              disabled={busy || !contact}
              onClick={async () => {
                if (!contact) return;
                if (await save(contact.id, role, authorised)) setContact(null);
              }}
            >
              {t('companies.save')}
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            {t('companies.readOnly')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
