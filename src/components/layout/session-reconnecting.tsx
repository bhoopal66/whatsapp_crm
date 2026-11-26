"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

/** Shown while this tab cannot find out whether its session is good. */
export function SessionReconnecting({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("AccountAccess");
  return (
    <div className="flex h-app items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3" role="status">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">{t("reconnecting")}</p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          {t("retry")}
        </Button>
      </div>
    </div>
  );
}
