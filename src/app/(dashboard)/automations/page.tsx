"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Zap,
  Plus,
  MoreVertical,
  Copy,
  Pencil,
  Trash2,
  FileText,
  MessageCircle,
  Clock,
  Users,
  PhoneCall,
  Loader2,
  ChevronDown,
  FilePlus,
} from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { useCan } from "@/hooks/use-can"
import { useTranslations } from "next-intl"
import type { Automation } from "@/types"
import { EmptyState } from "@/components/dashboard/empty-state"
import { ErrorState } from "@/components/dashboard/error-state"
import { LoadingState } from "@/components/dashboard/loading-state"
import { FlowVsAutomationHelp } from "@/components/dashboard/flow-vs-automation-help"
import { Button } from "@/components/ui/button"
import { GatedButton } from "@/components/ui/gated-button"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AUTOMATION_TEMPLATES, type TemplateSlug } from "@/lib/automations/templates"
import { triggerMeta, automationRuns, formatRelative } from "@/lib/automations/trigger-meta"
import { meaningTriggerSummary } from "@/lib/insights/meaning-config"
import { cn } from "@/lib/utils"

const TEMPLATE_ORDER: TemplateSlug[] = [
  "welcome_message",
  "out_of_office",
  "lead_qualifier",
  "follow_up_reminder",
]

const TEMPLATE_ICON: Record<TemplateSlug, typeof Zap> = {
  welcome_message: MessageCircle,
  out_of_office: Clock,
  lead_qualifier: Users,
  follow_up_reminder: PhoneCall,
}

export default function AutomationsPage() {
  const router = useRouter()
  const canCreate = useCan("send-messages")
  const t = useTranslations("Automations.list")
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function load() {
    try {
      const supabase = createClient()
      const { data, error: fetchErr } = await supabase
        .from("automations")
        .select("*")
        .order("created_at", { ascending: false })
      if (fetchErr) throw fetchErr
      setAutomations((data ?? []) as Automation[])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load automations")
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function toggleActive(a: Automation, next: boolean) {
    // Optimistic flip so the switch feels instant.
    setAutomations((prev) =>
      prev?.map((x) => (x.id === a.id ? { ...x, is_active: next } : x)) ?? prev,
    )
    const res = await fetch(`/api/automations/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: next }),
    })
    if (!res.ok) {
      // Roll back on error.
      setAutomations((prev) =>
        prev?.map((x) => (x.id === a.id ? { ...x, is_active: !next } : x)) ?? prev,
      )
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.updateError"))
      return
    }
    toast.success(next ? t("toasts.activated") : t("toasts.paused"))
  }

  async function duplicate(a: Automation) {
    const res = await fetch(`/api/automations/${a.id}/duplicate`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.duplicateError"))
      return
    }
    toast.success(t("toasts.duplicated"))
    load()
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    const res = await fetch(`/api/automations/${pendingDelete.id}`, { method: "DELETE" })
    setDeleting(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.deleteError"))
      return
    }
    toast.success(t("toasts.deleted"))
    setPendingDelete(null)
    load()
  }

  async function startFromTemplate(slug: TemplateSlug) {
    router.push(`/automations/new?template=${slug}`)
  }

  if (error) {
    return (
      <ErrorState message={error} onRetry={() => window.location.reload()} />
    )
  }

  if (automations === null) {
    return <LoadingState />
  }

  const showTemplates = automations.length < 3

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("subtitle")}
          </p>
        </div>
        {canCreate ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button className="bg-primary text-primary-foreground hover:bg-primary/90" />
              }
            >
              <Plus className="h-4 w-4" />
              {t("create")}
              <ChevronDown className="h-4 w-4" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
              <DropdownMenuItem onClick={() => router.push("/automations/new")}>
                <FilePlus className="h-4 w-4" />
                {t("createBlank")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("createFromTemplate")}</DropdownMenuLabel>
                {TEMPLATE_ORDER.map((slug) => {
                  const Icon = TEMPLATE_ICON[slug]
                  const tpl = AUTOMATION_TEMPLATES[slug]
                  return (
                    <DropdownMenuItem
                      key={slug}
                      onClick={() => startFromTemplate(slug)}
                      className="items-start"
                    >
                      <Icon className="mt-0.5 h-4 w-4" />
                      <span className="min-w-0">
                        <span className="block text-sm text-foreground">{tpl.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {tpl.description}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <GatedButton
            canAct={false}
            gateReason="create automations"
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {t("create")}
          </GatedButton>
        )}
      </div>

      <FlowVsAutomationHelp />

      {showTemplates && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground">{t("templatesTitle")}</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {TEMPLATE_ORDER.map((slug) => {
              const t = AUTOMATION_TEMPLATES[slug]
              const Icon = TEMPLATE_ICON[slug]
              return (
                <button
                  key={slug}
                  onClick={() => startFromTemplate(slug)}
                  className="group flex flex-col items-start rounded-xl border border-border bg-card p-4 text-start transition-colors hover:border-primary/50 hover:bg-card/80"
                >
                  <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary group-hover:bg-primary/15">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="text-sm font-semibold text-foreground">{t.name}</div>
                  <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {automations.length === 0 ? (
        <EmptyState
          icon={Zap}
          title={t("emptyTitle")}
          hint={t("emptyDesc")}
          className="h-48 rounded-xl"
        />
      ) : (
        <ul className="space-y-3">
          {automations.map((a) => (
            <AutomationCard
              key={a.id}
              automation={a}
              onToggle={(next) => toggleActive(a, next)}
              onEdit={() => router.push(`/automations/${a.id}/edit`)}
              onDuplicate={() => duplicate(a)}
              onLogs={() => router.push(`/automations/${a.id}/logs`)}
              onDelete={() => setPendingDelete(a)}
              t={t}
            />
          ))}
        </ul>
      )}

      <Dialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteDesc", { name: pendingDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AutomationCard({
  automation,
  onToggle,
  onEdit,
  onDuplicate,
  onLogs,
  onDelete,
  t,
}: {
  automation: Automation
  onToggle: (next: boolean) => void
  onEdit: () => void
  onDuplicate: () => void
  onLogs: () => void
  onDelete: () => void
  t: ReturnType<typeof useTranslations>
}) {
  const meta = triggerMeta(automation.trigger_type)
  const tm = useTranslations("MeaningTriggers")
  const meaning =
    automation.trigger_type === "intent_match"
      ? meaningTriggerSummary(automation.trigger_config)
      : null
  const PillIcon = meta.icon
  return (
    <li className="rounded-xl border border-border bg-card transition-colors hover:border-border">
      <div className="flex items-center gap-4 p-4">
        <div
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10"
          aria-hidden
        >
          <Zap className="h-5 w-5 text-primary" />
        </div>

        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 text-start"
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">
              {automation.name}
            </span>
            {automation.is_active && !automationRuns(automation) && (
              <span className="text-xs font-medium text-warning">
                {t("neverRuns")}
              </span>
            )}
            {automation.is_active && (
              <span className="relative flex h-2 w-2" aria-label="active">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
            )}
          </div>
          {automation.description && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{automation.description}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                meta.pillClass,
              )}
              title={meta.description}
            >
              {PillIcon && <PillIcon className="me-1 h-3 w-3" aria-hidden />}
              {meaning === null
                ? meta.label
                : meaning
                  ? tm("listSummary", { description: meaning })
                  : tm("listSummaryEmpty")}
            </span>
            <span className="tabular-nums">
              {automation.execution_count === 1
                ? t("runs", { count: automation.execution_count })
                : t("runsPlural", { count: automation.execution_count })}
            </span>
            <span aria-hidden>·</span>
            <span>{t("lastRun", { time: formatRelative(automation.last_executed_at) })}</span>
          </div>
        </button>

        <div className="flex items-center gap-3">
          <Switch
            checked={automation.is_active}
            onCheckedChange={(v) => onToggle(!!v)}
            aria-label={automation.is_active ? t("deactivate") : t("activate")}
          />

          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Open menu"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted"
            >
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="h-4 w-4" />
                {t("edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDuplicate}>
                <Copy className="h-4 w-4" />
                {t("duplicate")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onLogs}>
                <FileText className="h-4 w-4" />
                {t("viewLogs")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="h-4 w-4" />
                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </li>
  )
}
