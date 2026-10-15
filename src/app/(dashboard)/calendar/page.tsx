import { CalendarPage as CalendarScreen } from '@/components/calendar/calendar-page';
import { parseCalendarParams } from '@/lib/calendar/ui/url-state';

/**
 * /calendar — events, meetings and tasks in one view.
 * `?date=YYYY-MM-DD&view=day|week|month|year|agenda` and `?event=<id>`.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const state = parseCalendarParams(await searchParams);
  return (
    <CalendarScreen
      initialDate={state.date}
      initialView={state.view}
      initialEventId={state.eventId}
    />
  );
}
