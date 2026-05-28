/**
 * Template variable resolution for invite templates.
 * Builds a context object from party/event/sub-event data,
 * then replaces {{scope.field}} variables in template text.
 */

export interface InviteContext {
  party: {
    name: string;
    member_names: string;
    first_names: string;
    member_count: string;
  };
  invite: {
    rsvp_link: string;
    rsvp_code: string;
    rsvp_display_url: string;
  };
  event: {
    title: string;
    date: string;
    location: string;
  };
  sub_event: {
    name: string;
    time: string;
    date: string;
    description: string;
  };
  lead: {
    first_name: string;
    last_name: string;
    email: string;
  };
  /**
   * Distance + driving time from the party's mailing address to the event
   * venue. Populated at SEND time by the event-invite-admin function (which
   * geocodes the party address via Nominatim and looks up the route via
   * OSRM, caching the result on invite_parties). Empty strings when the
   * party has no address, the venue has no lat/lng, or geocoding failed —
   * render conditionally in the template (`{{address.distance_to_venue|default:""}}`).
   */
  address: {
    distance_to_venue: string;
    drive_time_to_venue: string;
  };
}

interface PartyData {
  name: string;
  short_code: string;
  members: Array<{
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    is_lead_booker: boolean;
  }>;
}

interface EventData {
  event_title: string;
  event_start: string | null;
  event_location: string | null;
}

interface SubEventData {
  name: string;
  description: string | null;
  starts_at: string | null;
}

function formatNameList(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const day = d.getUTCDate();
  const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
  return `${days[d.getUTCDay()]} ${day}${suffix} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 || 12;
  return m === 0 ? `${hour}${ampm}` : `${hour}:${String(m).padStart(2, '0')}${ampm}`;
}

export function buildInviteContext(
  party: PartyData,
  event: EventData,
  subEvent: SubEventData | null,
  portalUrl: string,
): InviteContext {
  const leadBooker = party.members.find(m => m.is_lead_booker);
  const memberNames = party.members
    .map(m => [m.first_name, m.last_name].filter(Boolean).join(' '))
    .filter(Boolean);
  const firstNames = party.members
    .map(m => m.first_name)
    .filter((n): n is string => Boolean(n));

  const rsvpUrl = `${portalUrl}/rsvp/${party.short_code}`;

  return {
    party: {
      name: party.name,
      member_names: formatNameList(memberNames),
      first_names: formatNameList(firstNames),
      member_count: String(party.members.length),
    },
    invite: {
      rsvp_link: rsvpUrl,
      rsvp_code: party.short_code,
      rsvp_display_url: rsvpUrl.replace(/^https?:\/\//, ''),
    },
    event: {
      title: event.event_title || '',
      date: formatDate(event.event_start),
      location: event.event_location || '',
    },
    sub_event: subEvent ? {
      name: subEvent.name,
      time: formatTime(subEvent.starts_at),
      date: formatDate(subEvent.starts_at),
      description: subEvent.description || '',
    } : { name: '', time: '', date: '', description: '' },
    lead: {
      first_name: leadBooker?.first_name || '',
      last_name: leadBooker?.last_name || '',
      email: leadBooker?.email || '',
    },
    // Distance/drive-time are populated at send-time by the edge function.
    // For preview in the editor we leave these empty — the editor doesn't
    // have lat/lng or an OSRM endpoint to call live.
    address: {
      distance_to_venue: '',
      drive_time_to_venue: '',
    },
  };
}

/**
 * Replace {{scope.field}} variables in a template string.
 */
export function replaceVariables(template: string, context: InviteContext): string {
  return template.replace(/\{\{(\w+)\.(\w+)\}\}/g, (match, scope, field) => {
    const scopeObj = context[scope as keyof InviteContext];
    if (!scopeObj) return match;
    const value = (scopeObj as Record<string, string>)[field];
    return value !== undefined ? value : match;
  });
}

/**
 * Resolve a single variable path like "party.name" from the context.
 */
export function resolveVariable(variable: string, context: InviteContext): string {
  const [scope, field] = variable.split('.');
  if (!scope || !field) return '';
  const scopeObj = context[scope as keyof InviteContext];
  if (!scopeObj) return '';
  return (scopeObj as Record<string, string>)[field] || '';
}

/**
 * Get all available template variables for documentation/UI.
 */
export function getAvailableVariables(): Array<{ variable: string; description: string; example: string }> {
  return [
    { variable: 'party.name', description: 'Party display name', example: 'The Smiths' },
    { variable: 'party.member_names', description: 'All member full names', example: 'Dan Smith, Sarah Smith & Noah Smith' },
    { variable: 'party.first_names', description: 'All member first names', example: 'Dan, Sarah & Noah' },
    { variable: 'party.member_count', description: 'Number of members', example: '3' },
    { variable: 'invite.rsvp_link', description: 'Full RSVP URL', example: 'https://example.com/rsvp/sb7gcr' },
    { variable: 'invite.rsvp_code', description: 'Short code', example: 'sb7gcr' },
    { variable: 'invite.rsvp_display_url', description: 'URL without protocol', example: 'example.com/rsvp/sb7gcr' },
    { variable: 'event.title', description: 'Parent event title', example: 'Baker-Swift Wedding' },
    { variable: 'event.date', description: 'Event date', example: 'Saturday 15th June 2026' },
    { variable: 'event.location', description: 'Event location', example: "St Mary's Church" },
    { variable: 'sub_event.name', description: 'Sub-event name', example: 'Day Ceremony' },
    { variable: 'sub_event.time', description: 'Sub-event time', example: '2:30pm' },
    { variable: 'sub_event.date', description: 'Sub-event date', example: 'Saturday 15th June 2026' },
    { variable: 'sub_event.description', description: 'Sub-event description', example: 'Join us for the ceremony' },
    { variable: 'lead.first_name', description: 'Lead booker first name', example: 'Dan' },
    { variable: 'lead.last_name', description: 'Lead booker last name', example: 'Baker' },
    { variable: 'lead.email', description: 'Lead booker email', example: 'dan@example.com' },
    { variable: 'address.distance_to_venue', description: 'Distance from booker address to venue (set at send-time)', example: '12 mi' },
    { variable: 'address.drive_time_to_venue', description: 'Drive time from booker address to venue (set at send-time)', example: '24 min' },
  ];
}
