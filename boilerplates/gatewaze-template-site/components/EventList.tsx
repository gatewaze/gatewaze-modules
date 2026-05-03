/* @gatewaze:block kind="gatewaze-internal" name="event-list" category="content" source="events" freshness="live" description="List of upcoming events from the gatewaze events module" */

interface Event {
  id: string;
  title: string;
  start_date: string;
  url: string;
}

interface EventListProps {
  /** Heading shown above the list. */
  heading?: string;
  /** Maximum number of events to display. */
  limit?: number;
  /** Pre-resolved events (passed in by the build pipeline at SSR time). */
  events: Event[];
}

export function EventList(props: EventListProps) {
  return (
    <section className="py-8">
      {props.heading && <h2 className="text-2xl font-bold mb-6">{props.heading}</h2>}
      <ul className="space-y-4">
        {props.events.slice(0, props.limit ?? 5).map((evt) => (
          <li key={evt.id} className="border border-[var(--color-border)] rounded-lg p-4 hover:bg-gray-50">
            <a href={evt.url} className="block">
              <div className="text-sm text-[var(--color-muted)]">{new Date(evt.start_date).toLocaleDateString()}</div>
              <div className="font-medium mt-1">{evt.title}</div>
            </a>
          </li>
        ))}
        {props.events.length === 0 && (
          <li className="text-[var(--color-muted)]">No upcoming events.</li>
        )}
      </ul>
    </section>
  );
}
