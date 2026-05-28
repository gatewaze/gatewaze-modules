import { useState, useCallback, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Modal, Badge } from '@/components/ui';
import { PlusIcon, TrashIcon, MagnifyingGlassIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';

interface CreatePartyModalProps {
  isOpen: boolean;
  onClose: () => void;
  eventUuid: string;
  mode?: 'individual' | 'csv';
  onSuccess: () => void;
}

interface PersonSearchResult {
  id: string;
  email: string;
  attributes: Record<string, string> | null;
}

interface SubEvent {
  id: string;
  name: string;
  slug: string | null;
  rsvp_deadline: string | null;
}

interface PartyMember {
  personId: string | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  assignedEvents: string[];        // event UUIDs (when no sub-events)
  assignedSubEvents: string[];     // sub-event UUIDs (when sub-events exist)
  isLeadBooker: boolean;
}

interface ColumnMapping {
  [csvHeader: string]: string;
}

const MAPPING_OPTIONS = [
  { value: '', label: 'Skip' },
  { value: 'first_name', label: 'First Name' },
  { value: 'last_name', label: 'Last Name' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'party_group', label: 'Party Group' },
  { value: 'party_name', label: 'Party Name' },
  { value: 'address', label: 'Address' },
  { value: 'sub_event', label: 'Sub-Event' },
  { value: 'plus_one', label: 'Plus One' },
];

const DELIVERY_CHANNELS = [
  { value: 'email', label: 'Email' },
];

function createEmptyMember(eventUuid: string, subEvents: SubEvent[], isLeadBooker = false): PartyMember {
  return {
    personId: null,
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    assignedEvents: subEvents.length === 0 ? [eventUuid] : [],
    assignedSubEvents: subEvents.map(se => se.id), // assign to all sub-events by default
    isLeadBooker,
  };
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += char; }
  }
  result.push(current.trim());
  return result;
}

export function CreatePartyModal({ isOpen, onClose, eventUuid, mode: initialMode, onSuccess }: CreatePartyModalProps) {
  const [activeMode, setActiveMode] = useState<'individual' | 'csv'>(initialMode ?? 'individual');
  const [submitting, setSubmitting] = useState(false);

  // Sub-events
  const [subEvents, setSubEvents] = useState<SubEvent[]>([]);
  const hasSubEvents = subEvents.length > 0;

  // Load sub-events on mount
  useEffect(() => {
    if (!isOpen) return;
    (async () => {
      const { data } = await supabase
        .from('invite_sub_events')
        .select('id, name, slug, rsvp_deadline')
        .eq('event_id', eventUuid)
        .order('sort_order');
      setSubEvents(data || []);
    })();
  }, [eventUuid, isOpen]);

  // Individual mode state
  const [partyName, setPartyName] = useState('');
  const [members, setMembers] = useState<PartyMember[]>([createEmptyMember(eventUuid, [], true)]);
  const [plusOneAllowance, setPlusOneAllowance] = useState(0);
  const [deliveryChannel, setDeliveryChannel] = useState('email');
  const [rsvpDeadline, setRsvpDeadline] = useState('');
  const [searchQueries, setSearchQueries] = useState<Record<number, string>>({});
  const [searchResults, setSearchResults] = useState<Record<number, PersonSearchResult[]>>({});
  const [activeSearchIndex, setActiveSearchIndex] = useState<number | null>(null);

  // Re-initialize members when sub-events change
  useEffect(() => {
    setMembers([createEmptyMember(eventUuid, subEvents, true)]);
  }, [subEvents, eventUuid]);

  // CSV mode state
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({});
  // How CSV rows should reconcile against existing invite data for this event.
  // - create: always insert new parties (original behaviour, risks duplicates)
  // - replace: wipe every invite_party tied to this event, then insert fresh
  // - upsert: match existing parties by lead member name and reconcile members
  const [csvImportMode, setCsvImportMode] = useState<'create' | 'replace' | 'upsert'>('create');
  // Live progress banner shown during the import so the user doesn't think
  // "Working..." means "frozen"
  const [csvProgress, setCsvProgress] = useState<string>('');

  const resetForm = useCallback(() => {
    setPartyName('');
    setMembers([createEmptyMember(eventUuid, subEvents, true)]);
    setPlusOneAllowance(0);
    setDeliveryChannel('email');
    setSearchQueries({});
    setSearchResults({});
    setActiveSearchIndex(null);
    setCsvHeaders([]);
    setCsvRows([]);
    setColumnMapping({});
    setCsvImportMode('create');
    setCsvProgress('');
  }, [eventUuid]);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  // --- Person search ---

  const handlePersonSearch = useCallback(async (index: number, query: string) => {
    setSearchQueries((prev) => ({ ...prev, [index]: query }));

    if (query.length < 2) {
      setSearchResults((prev) => ({ ...prev, [index]: [] }));
      setActiveSearchIndex(null);
      return;
    }

    const { data } = await supabase
      .from('people')
      .select('id, email, attributes')
      .ilike('email', `%${query}%`)
      .limit(10);

    setSearchResults((prev) => ({ ...prev, [index]: data ?? [] }));
    setActiveSearchIndex(index);
  }, []);

  const handleSelectPerson = useCallback((index: number, person: PersonSearchResult) => {
    const attrs = person.attributes ?? {};
    setMembers((prev) => {
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        personId: person.id,
        firstName: attrs.first_name ?? '',
        lastName: attrs.last_name ?? '',
        email: person.email,
        phone: attrs.phone ?? '',
      };
      return updated;
    });
    setSearchQueries((prev) => ({ ...prev, [index]: '' }));
    setSearchResults((prev) => ({ ...prev, [index]: [] }));
    setActiveSearchIndex(null);
  }, []);

  // --- Member management ---

  const updateMember = useCallback((index: number, field: keyof PartyMember, value: string | boolean | string[]) => {
    setMembers((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  }, []);

  const setLeadBooker = useCallback((index: number) => {
    setMembers((prev) => prev.map((m, i) => ({ ...m, isLeadBooker: i === index })));
  }, []);

  const addMember = useCallback(() => {
    setMembers((prev) => [...prev, createEmptyMember(eventUuid, subEvents)]);
  }, [eventUuid]);

  const removeMember = useCallback((index: number) => {
    setMembers((prev) => {
      if (prev.length <= 1) return prev;
      const updated = prev.filter((_, i) => i !== index);
      if (!updated.some((m) => m.isLeadBooker)) {
        updated[0].isLeadBooker = true;
      }
      return updated;
    });
  }, []);

  // --- CSV handling ---

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
      if (lines.length < 2) {
        toast.error('CSV must contain at least a header row and one data row');
        return;
      }

      const headers = parseCsvLine(lines[0]);
      const rows = lines.slice(1).map(parseCsvLine);

      setCsvHeaders(headers);
      setCsvRows(rows);

      // Auto-map columns by guessing from header names
      const autoMapping: ColumnMapping = {};
      headers.forEach((header) => {
        const lower = header.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (lower.includes('firstname') || lower === 'first' || lower === 'firstname') autoMapping[header] = 'first_name';
        else if (lower.includes('lastname') || lower === 'last' || lower === 'lastname') autoMapping[header] = 'last_name';
        else if (lower.includes('email')) autoMapping[header] = 'email';
        else if (lower.includes('phone') || lower.includes('mobile')) autoMapping[header] = 'phone';
        else if (lower.includes('leadnumber') || lower.includes('partygroup') || lower.includes('groupid')) autoMapping[header] = 'party_group';
        else if (lower.includes('partyname') || lower === 'party') autoMapping[header] = 'party_name';
        else if (lower.includes('address') || lower.includes('addr')) autoMapping[header] = 'address';
        else if (lower.includes('invite') || lower.includes('subevent') || lower.includes('ticket')) autoMapping[header] = 'sub_event';
        else if (lower.includes('plus') || lower.includes('plusone') || lower.includes('guest')) autoMapping[header] = 'plus_one';
        else autoMapping[header] = '';
      });
      setColumnMapping(autoMapping);
    };
    reader.readAsText(file);
  }, []);

  const updateColumnMapping = useCallback((header: string, value: string) => {
    setColumnMapping((prev) => ({ ...prev, [header]: value }));
  }, []);

  // --- Submit ---

  // --- Short code & token generation ---

  const generateToken = (): string => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
  };

  const generateShortCode = (): string => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const array = new Uint8Array(6);
    crypto.getRandomValues(array);
    return Array.from(array, b => chars[b % 36]).join('');
  };

  // --- Find or create person ---

  /**
   * Fast find-or-create used by CSV import. Skips the people-signup edge
   * function entirely — guests from a CSV don't need auth users, and the edge
   * function round-trip per row turned large imports into multi-minute waits
   * (or hangs if it's rate-limited). For Individual mode we still call the
   * full findOrCreatePerson below so new non-guest people can sign in later.
   */
  const findOrCreatePersonDirect = async (email: string, firstName?: string, lastName?: string, phone?: string) => {
    const normalizedEmail = email.toLowerCase().trim();

    const { data: existing } = await supabase
      .from('people')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existing) return existing.id;

    const attributes: Record<string, string> = {};
    if (firstName) attributes.first_name = firstName;
    if (lastName) attributes.last_name = lastName;

    const { data: person, error } = await supabase
      .from('people')
      .insert({ email: normalizedEmail, phone: phone || null, attributes, is_guest: true })
      .select('id')
      .single();

    if (error) throw new Error(`Failed to create person: ${error.message}`);
    return person.id;
  };

  const findOrCreatePerson = async (email: string, firstName?: string, lastName?: string, phone?: string) => {
    const normalizedEmail = email.toLowerCase().trim();

    const { data: existing } = await supabase
      .from('people')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existing) return existing.id;

    // Create auth user via people-signup edge function (creates both auth user + people record)
    const apiUrl = import.meta.env.VITE_API_URL || import.meta.env.VITE_SUPABASE_URL || '';
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

    try {
      const signupRes = await fetch(`${supabaseUrl}/functions/v1/people-signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: anonKey },
        body: JSON.stringify({
          email: normalizedEmail,
          user_metadata: {
            first_name: firstName || '',
            last_name: lastName || '',
            ...(phone ? { phone } : {}),
          },
          source: 'invite',
        }),
      });

      const signupData = await signupRes.json();
      if (signupData?.person_id) return signupData.person_id;
    } catch {
      // Fall back to direct insert if edge function fails
    }

    // Fallback: create person directly (without auth user)
    const attributes: Record<string, string> = {};
    if (firstName) attributes.first_name = firstName;
    if (lastName) attributes.last_name = lastName;

    const { data: person, error } = await supabase
      .from('people')
      .insert({ email: normalizedEmail, phone: phone || null, attributes, is_guest: true })
      .select('id')
      .single();

    if (error) throw new Error(`Failed to create person: ${error.message}`);
    return person.id;
  };

  const handleIndividualSubmit = useCallback(async () => {
    if (!partyName.trim()) {
      toast.error('Party name is required');
      return;
    }

    const validMembers = members.filter((m) => m.email.trim());
    if (validMembers.length === 0) {
      toast.error('At least one member with an email is required');
      return;
    }

    setSubmitting(true);
    try {
      // Create the party
      const { data: party, error: partyErr } = await supabase
        .from('invite_parties')
        .insert({
          name: partyName.trim(),
          token: generateToken(),
          short_code: generateShortCode(),
          max_plus_ones: plusOneAllowance,
          delivery_channel: deliveryChannel,
        })
        .select('id, short_code')
        .single();

      if (partyErr || !party) throw new Error(partyErr?.message || 'Failed to create party');

      // Create members and their event assignments
      for (let i = 0; i < validMembers.length; i++) {
        const m = validMembers[i];

        // Find or create person record
        let personId = m.personId || null;
        if (!personId && m.email) {
          personId = await findOrCreatePerson(m.email, m.firstName, m.lastName, m.phone);
        }

        const { data: member, error: memberErr } = await supabase
          .from('invite_party_members')
          .insert({
            party_id: party.id,
            person_id: personId,
            first_name: m.firstName || null,
            last_name: m.lastName || null,
            email: m.email.toLowerCase().trim(),
            phone: m.phone || null,
            is_lead_booker: m.isLeadBooker,
            sort_order: i,
          })
          .select('id')
          .single();

        if (memberErr || !member) throw new Error(memberErr?.message || 'Failed to create member');

        // Assign to events or sub-events
        if (hasSubEvents) {
          const subEventIds = m.assignedSubEvents?.length ? m.assignedSubEvents : [];
          for (const subEventId of subEventIds) {
            const se = subEvents.find(s => s.id === subEventId);
            const { error: eventErr } = await supabase
              .from('invite_party_member_events')
              .insert({
                party_member_id: member.id,
                event_id: eventUuid,
                sub_event_id: subEventId,
                rsvp_deadline: rsvpDeadline || se?.rsvp_deadline || null,
              });
            if (eventErr) throw new Error(eventErr.message);
          }
        } else {
          const eventIds = m.assignedEvents?.length ? m.assignedEvents : [eventUuid];
          for (const eventId of eventIds) {
            const { error: eventErr } = await supabase
              .from('invite_party_member_events')
              .insert({ party_member_id: member.id, event_id: eventId, rsvp_deadline: rsvpDeadline || null });
            if (eventErr) throw new Error(eventErr.message);
          }
        }
      }

      toast.success(`Party created — short code: ${party.short_code}`);
      resetForm();
      onSuccess();
    } catch (err) {
      console.error('Error creating party:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to create invite party');
    } finally {
      setSubmitting(false);
    }
  }, [partyName, members, plusOneAllowance, deliveryChannel, eventUuid, resetForm, onSuccess]);

  const handleCsvSubmit = useCallback(async () => {
    const mappedFields = Object.values(columnMapping).filter(Boolean);
    if (!mappedFields.includes('first_name') && !mappedFields.includes('last_name')) {
      toast.error('At least First Name or Last Name column mapping is required');
      return;
    }

    setSubmitting(true);
    try {
      // --- Build mapped rows + party groupings ---
      const mappedRows = csvRows.map((row) => {
        const mapped: Record<string, string> = {};
        csvHeaders.forEach((header, colIndex) => {
          const field = columnMapping[header];
          if (field && row[colIndex] !== undefined) {
            mapped[field] = row[colIndex].trim();
          }
        });
        return mapped;
      });

      const hasGroupColumn = mappedFields.includes('party_group');
      const hasPartyNameColumn = mappedFields.includes('party_name');
      const partyGroups = new Map<string, Array<Record<string, string>>>();
      mappedRows.forEach((row, idx) => {
        const key = hasGroupColumn
          ? (row.party_group || `__row_${idx}`)
          : hasPartyNameColumn
            ? (row.party_name || row.email || `__row_${idx}`)
            : (row.email || `__row_${idx}`);
        const group = partyGroups.get(key) || [];
        group.push(row);
        partyGroups.set(key, group);
      });

      // CSV "sub_event" column matching. Order of preference:
      //   1. Exact slug match — e.g. a sub-event with slug="evening"
      //      picks up CSV cells "evening" / "Evening" / " Evening ".
      //   2. Case-insensitive name prefix — legacy behaviour for
      //      events set up before slugs existed.
      //   3. Fall back to "all sub-events" so an empty / unrecognised
      //      cell errs on the side of over-inviting rather than
      //      silently dropping people.
      //
      // Slug normalisation mirrors admin/SubEventConfigPanel so
      // "Evening party" in the CSV matches slug "evening-party".
      const normaliseSlug = (s: string) => s
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      const subEventLookup = (value: string): string[] => {
        if (!value) return subEvents.map(se => se.id);
        const lower = value.toLowerCase().trim();
        const slug = normaliseSlug(value);

        if (slug) {
          const slugMatch = subEvents.filter(se => (se.slug || '').toLowerCase() === slug);
          if (slugMatch.length > 0) return slugMatch.map(se => se.id);
        }

        const nameMatch = subEvents.filter(se =>
          se.name.toLowerCase().startsWith(lower) || se.name.toLowerCase() === lower,
        );
        if (nameMatch.length > 0) return nameMatch.map(se => se.id);

        return subEvents.map(se => se.id);
      };

      const emailFrom = import.meta.env.VITE_EMAIL_FROM || 'noreply@app.example.com';
      const emailDomain = emailFrom.split('@')[1] || 'app.example.com';
      const shortEventId = eventUuid.split('-')[0];
      const makePlaceholderEmail = (first: string, last: string) => {
        const f = (first || 'guest').toLowerCase().replace(/[^a-z0-9]/g, '');
        const l = (last || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '');
        return `${shortEventId}+${f}-${l}@${emailDomain}`;
      };

      /**
       * Total plus-one allowance for a party, derived from the CSV's plus_one
       * column. A row with plus_one=1 means "this person can bring one extra
       * guest at RSVP", so we sum them onto invite_parties.max_plus_ones.
       *
       * This is distinct from invite_party_members.is_plus_one, which marks an
       * existing member as a guest-of-someone-else. The CSV's plus column is
       * about the party's capacity, not about flagging the row itself.
       */
      const computePartyPlusOnes = (rows: Array<Record<string, string>>): number => {
        return rows.reduce((sum, r) => {
          const v = r.plus_one?.toLowerCase() || '';
          const isOne = v === '1' || v === 'yes' || v === 'true';
          return sum + (isOne ? 1 : 0);
        }, 0);
      };

      const derivePartyName = (rows: Array<Record<string, string>>): string => {
        const firstNames = rows.map(r => r.first_name).filter(Boolean);
        if (rows[0]?.party_name) return rows[0].party_name;
        if (firstNames.length === 1) {
          return [rows[0].first_name, rows[0].last_name].filter(Boolean).join(' ') || 'Guest';
        }
        if (firstNames.length === 2) return `${firstNames[0]} & ${firstNames[1]}`;
        if (firstNames.length > 2) {
          return `${firstNames.slice(0, -1).join(', ')} & ${firstNames[firstNames.length - 1]}`;
        }
        return 'Guest';
      };

      // overwriteAttrs controls whether the CSV overrides existing person
      // attributes. 'create' preserves existing values (it's an append). The
      // replace/upsert modes are cleanup passes, so they overlay.
      const upsertPersonFromRow = async (
        row: Record<string, string>,
        overwriteAttrs: boolean,
      ): Promise<{ personId: string | null; email: string }> => {
        const memberEmail = row.email?.toLowerCase().trim() || '';
        const email = memberEmail || makePlaceholderEmail(row.first_name, row.last_name);
        let personId: string | null = null;
        try {
          // Use the direct variant — CSV-imported guests don't need auth users,
          // and the edge function makes bulk imports painfully slow
          personId = await findOrCreatePersonDirect(email, row.first_name, row.last_name, row.phone);
        } catch (e) {
          console.error('Error creating person:', e);
        }
        if (personId && row.address) {
          try {
            const { data: person } = await supabase.from('people').select('attributes').eq('id', personId).single();
            const attrs = (person?.attributes || {}) as Record<string, unknown>;
            if (overwriteAttrs || !attrs.address) {
              await supabase.from('people').update({ attributes: { ...attrs, address: row.address } }).eq('id', personId);
            }
          } catch { /* best-effort */ }
        }
        return { personId, email };
      };

      const insertMemberEvents = async (
        memberId: string,
        row: Record<string, string>,
      ) => {
        if (hasSubEvents) {
          const ids = subEventLookup(row.sub_event || '');
          for (const seId of ids) {
            await supabase
              .from('invite_party_member_events')
              .insert({
                party_member_id: memberId,
                event_id: eventUuid,
                sub_event_id: seId,
                rsvp_deadline: rsvpDeadline || null,
              });
          }
        } else {
          await supabase
            .from('invite_party_member_events')
            .insert({ party_member_id: memberId, event_id: eventUuid, rsvp_deadline: rsvpDeadline || null });
        }
      };

      // For upsert mode: reconcile desired sub-event assignments against what
      // already exists, preserving rsvp_status on rows that stay.
      const reconcileMemberEvents = async (
        memberId: string,
        row: Record<string, string>,
      ) => {
        const desired = hasSubEvents ? subEventLookup(row.sub_event || '') : [];
        const { data: existing } = await supabase
          .from('invite_party_member_events')
          .select('id, sub_event_id')
          .eq('party_member_id', memberId)
          .eq('event_id', eventUuid);
        const existingRows = (existing || []) as Array<{ id: string; sub_event_id: string | null }>;

        if (!hasSubEvents) {
          // One flat row per member when there are no sub-events
          if (existingRows.length === 0) {
            await supabase
              .from('invite_party_member_events')
              .insert({ party_member_id: memberId, event_id: eventUuid, rsvp_deadline: rsvpDeadline || null });
          }
          return;
        }

        const desiredSet = new Set(desired);
        const existingSet = new Set(existingRows.map(r => r.sub_event_id).filter(Boolean) as string[]);

        for (const seId of desired) {
          if (!existingSet.has(seId)) {
            await supabase
              .from('invite_party_member_events')
              .insert({
                party_member_id: memberId,
                event_id: eventUuid,
                sub_event_id: seId,
                rsvp_deadline: rsvpDeadline || null,
              });
          }
        }
        for (const r of existingRows) {
          if (!r.sub_event_id || !desiredSet.has(r.sub_event_id)) {
            await supabase.from('invite_party_member_events').delete().eq('id', r.id);
          }
        }
      };

      setCsvProgress(`Preparing ${partyGroups.size} part${partyGroups.size === 1 ? 'y' : 'ies'}...`);

      // --- Replace mode: wipe existing parties for this event first ---
      if (csvImportMode === 'replace') {
        setCsvProgress('Removing existing invite parties for this event...');
        const { data: eventLinks } = await supabase
          .from('invite_party_member_events')
          .select('party_member_id')
          .eq('event_id', eventUuid);
        const memberIds = Array.from(new Set((eventLinks || []).map(r => r.party_member_id).filter(Boolean))) as string[];

        if (memberIds.length > 0) {
          const { data: members } = await supabase
            .from('invite_party_members')
            .select('party_id')
            .in('id', memberIds);
          const partyIds = Array.from(new Set((members || []).map(m => m.party_id).filter(Boolean))) as string[];
          if (partyIds.length > 0) {
            // CASCADE removes invite_party_members and invite_party_member_events
            const { error } = await supabase.from('invite_parties').delete().in('id', partyIds);
            if (error) throw new Error(`Failed to wipe existing parties: ${error.message}`);
          }
        }
      }

      // --- Upsert mode: build an index of existing parties by lead-member name ---
      // Map key: "firstname|lastname" → list of party ids (>1 means ambiguous, skip)
      const leadIndex = new Map<string, string[]>();
      if (csvImportMode === 'upsert') {
        const { data: eventLinks } = await supabase
          .from('invite_party_member_events')
          .select('party_member_id')
          .eq('event_id', eventUuid);
        const memberIds = Array.from(new Set((eventLinks || []).map(r => r.party_member_id).filter(Boolean))) as string[];

        if (memberIds.length > 0) {
          const { data: leadMembers } = await supabase
            .from('invite_party_members')
            .select('party_id, first_name, last_name')
            .in('id', memberIds)
            .eq('is_lead_booker', true);
          for (const lm of leadMembers || []) {
            const key = `${(lm.first_name || '').trim().toLowerCase()}|${(lm.last_name || '').trim().toLowerCase()}`;
            const arr = leadIndex.get(key) || [];
            if (lm.party_id && !arr.includes(lm.party_id)) arr.push(lm.party_id);
            leadIndex.set(key, arr);
          }
        }
      }

      // --- Process each party group ---
      let partiesCreated = 0;
      let partiesUpdated = 0;
      let membersCreated = 0;
      let membersUpdated = 0;
      let membersDeleted = 0;
      let ambiguousSkipped = 0;
      // Anything that failed silently (row couldn't be inserted / updated).
      // We log each one to the console and surface the count in the toast so
      // nobody looks at the success summary thinking the whole list landed.
      const rowFailures: string[] = [];

      const overwriteAttrs = csvImportMode !== 'create';

      let partyIndex = 0;
      const totalParties = partyGroups.size;
      for (const [, rows] of partyGroups) {
        partyIndex++;
        const partyName = derivePartyName(rows);
        setCsvProgress(`Processing party ${partyIndex}/${totalParties}: ${partyName}`);
        const partyAddress = rows.find(r => r.address)?.address || null;
        const partyMaxPlusOnes = computePartyPlusOnes(rows);

        let existingPartyId: string | null = null;
        if (csvImportMode === 'upsert') {
          const lead = rows[0];
          const key = `${(lead.first_name || '').trim().toLowerCase()}|${(lead.last_name || '').trim().toLowerCase()}`;
          const matches = leadIndex.get(key) || [];
          if (matches.length > 1) {
            ambiguousSkipped++;
            console.warn(`Skipping ambiguous party for lead "${lead.first_name} ${lead.last_name}" — ${matches.length} existing parties match`);
            continue;
          }
          if (matches.length === 1) existingPartyId = matches[0];
        }

        if (existingPartyId) {
          // --- UPDATE path ---
          const { data: existingParty } = await supabase
            .from('invite_parties')
            .select('id, name, address, max_plus_ones')
            .eq('id', existingPartyId)
            .single();

          const updates: Record<string, unknown> = {};
          if (existingParty && existingParty.name !== partyName) updates.name = partyName;
          if (existingParty && (existingParty.address || null) !== partyAddress) updates.address = partyAddress;
          if (existingParty && (existingParty.max_plus_ones ?? 0) !== partyMaxPlusOnes) updates.max_plus_ones = partyMaxPlusOnes;
          if (Object.keys(updates).length > 0) {
            const { error } = await supabase.from('invite_parties').update(updates).eq('id', existingPartyId);
            if (error) {
              console.error(`Failed to update party ${existingPartyId}:`, error);
              continue;
            }
          }
          partiesUpdated++;

          const { data: existingMembers } = await supabase
            .from('invite_party_members')
            .select('id, person_id, first_name, last_name')
            .eq('party_id', existingPartyId);
          const existingMemberRows = (existingMembers || []) as Array<{ id: string; person_id: string | null; first_name: string | null; last_name: string | null }>;
          const matchedMemberIds = new Set<string>();

          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const label = `${row.first_name || ''} ${row.last_name || ''}`.trim() || `row ${i + 1}`;

            let personResult: { personId: string | null; email: string };
            try {
              personResult = await upsertPersonFromRow(row, overwriteAttrs);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[csv import] Failed to upsert person for "${label}":`, err);
              rowFailures.push(`${label}: ${msg}`);
              continue;
            }
            const { personId, email } = personResult;

            const rowFirst = (row.first_name || '').trim().toLowerCase();
            const rowLast = (row.last_name || '').trim().toLowerCase();
            const matched = existingMemberRows.find(m =>
              (m.first_name || '').trim().toLowerCase() === rowFirst &&
              (m.last_name || '').trim().toLowerCase() === rowLast,
            );

            let memberId: string;
            if (matched) {
              matchedMemberIds.add(matched.id);
              // CSV-listed members are primary invitees, not plus-ones. We
              // force is_plus_one=false so re-imports correct any bad data
              // from earlier runs (e.g. the old mapping that put the CSV's
              // plus column onto is_plus_one).
              const { error } = await supabase
                .from('invite_party_members')
                .update({
                  first_name: row.first_name || null,
                  last_name: row.last_name || null,
                  email,
                  phone: row.phone || null,
                  is_lead_booker: i === 0,
                  is_plus_one: false,
                  sort_order: i,
                  person_id: personId ?? matched.person_id,
                })
                .eq('id', matched.id);
              if (error) {
                console.error(`[csv import] Failed to update member "${label}":`, error);
                rowFailures.push(`${label}: ${error.message}`);
                continue;
              }
              memberId = matched.id;
              membersUpdated++;
            } else {
              const { data: member, error } = await supabase
                .from('invite_party_members')
                .insert({
                  party_id: existingPartyId,
                  person_id: personId,
                  first_name: row.first_name || null,
                  last_name: row.last_name || null,
                  email,
                  phone: row.phone || null,
                  is_lead_booker: i === 0,
                  sort_order: i,
                })
                .select('id')
                .single();
              if (error || !member) {
                console.error(`[csv import] Failed to insert member "${label}":`, error);
                rowFailures.push(`${label}: ${error?.message || 'insert returned no row'}`);
                continue;
              }
              memberId = member.id;
              membersCreated++;
            }

            await reconcileMemberEvents(memberId, row);
          }

          for (const m of existingMemberRows) {
            if (!matchedMemberIds.has(m.id)) {
              const { error } = await supabase.from('invite_party_members').delete().eq('id', m.id);
              if (!error) membersDeleted++;
            }
          }
        } else {
          // --- CREATE path (also used by replace mode after wipe, and for
          // new parties in upsert mode that weren't found) ---
          const { data: party, error: partyErr } = await supabase
            .from('invite_parties')
            .insert({
              name: partyName,
              token: generateToken(),
              short_code: generateShortCode(),
              delivery_channel: 'email',
              address: partyAddress,
              max_plus_ones: partyMaxPlusOnes,
            })
            .select('id')
            .single();

          if (partyErr || !party) {
            console.error('Error creating party from CSV:', partyErr);
            continue;
          }
          partiesCreated++;

          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const label = `${row.first_name || ''} ${row.last_name || ''}`.trim() || `row ${i + 1}`;

            let personResult: { personId: string | null; email: string };
            try {
              personResult = await upsertPersonFromRow(row, overwriteAttrs);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[csv import] Failed to upsert person for "${label}":`, err);
              rowFailures.push(`${label}: ${msg}`);
              continue;
            }

            // is_plus_one intentionally left at its DB default (false). CSV's
            // plus column is applied to party.max_plus_ones above.
            const { data: member, error: memberErr } = await supabase
              .from('invite_party_members')
              .insert({
                party_id: party.id,
                person_id: personResult.personId,
                first_name: row.first_name || null,
                last_name: row.last_name || null,
                email: personResult.email,
                phone: row.phone || null,
                is_lead_booker: i === 0,
                sort_order: i,
              })
              .select('id')
              .single();

            if (memberErr || !member) {
              console.error(`[csv import] Failed to insert member "${label}":`, memberErr);
              rowFailures.push(`${label}: ${memberErr?.message || 'insert returned no row'}`);
              continue;
            }

            await insertMemberEvents(member.id, row);
            membersCreated++;
          }
        }
      }

      // --- Build per-mode toast summary ---
      const summaryParts: string[] = [];
      if (partiesCreated > 0) summaryParts.push(`${partiesCreated} parties created`);
      if (partiesUpdated > 0) summaryParts.push(`${partiesUpdated} updated`);
      if (membersCreated > 0) summaryParts.push(`${membersCreated} members added`);
      if (membersUpdated > 0) summaryParts.push(`${membersUpdated} members updated`);
      if (membersDeleted > 0) summaryParts.push(`${membersDeleted} members removed`);
      if (ambiguousSkipped > 0) summaryParts.push(`${ambiguousSkipped} skipped (ambiguous)`);

      if (rowFailures.length > 0) {
        summaryParts.push(`${rowFailures.length} row${rowFailures.length === 1 ? '' : 's'} failed`);
        const preview = rowFailures.slice(0, 3).join('; ');
        const rest = rowFailures.length > 3 ? ` (+${rowFailures.length - 3} more in console)` : '';
        toast.error(`${summaryParts.join(' · ')} — ${preview}${rest}`, { duration: 10000 });
      } else {
        toast.success(summaryParts.join(' · ') || 'Import complete');
      }
      resetForm();
      onSuccess();
    } catch (err) {
      console.error('Error importing CSV:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to import CSV');
    } finally {
      setSubmitting(false);
      setCsvProgress('');
    }
  }, [csvHeaders, csvRows, columnMapping, csvImportMode, eventUuid, subEvents, hasSubEvents, rsvpDeadline, resetForm, onSuccess]);

  // --- Render ---

  const renderModeToggle = () => (
    <div className="flex gap-1 p-1 bg-[var(--gray-a3)] rounded-lg mb-4">
      <button
        type="button"
        onClick={() => setActiveMode('individual')}
        className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
          activeMode === 'individual'
            ? 'bg-[var(--color-background)] text-[var(--gray-12)] shadow-sm'
            : 'text-[var(--gray-a11)] hover:text-[var(--gray-12)]'
        }`}
      >
        Individual
      </button>
      <button
        type="button"
        onClick={() => setActiveMode('csv')}
        className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
          activeMode === 'csv'
            ? 'bg-[var(--color-background)] text-[var(--gray-12)] shadow-sm'
            : 'text-[var(--gray-a11)] hover:text-[var(--gray-12)]'
        }`}
      >
        <ArrowUpTrayIcon className="h-4 w-4 inline-block mr-1 -mt-0.5" />
        CSV Import
      </button>
    </div>
  );

  const renderMemberForm = (member: PartyMember, index: number) => (
    <div key={index} className="border border-[var(--gray-a6)] rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--gray-11)]">Member {index + 1}</span>
          {member.isLeadBooker && <Badge color="blue">Lead Booker</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-[var(--gray-a11)] cursor-pointer">
            <input
              type="radio"
              name="leadBooker"
              checked={member.isLeadBooker}
              onChange={() => setLeadBooker(index)}
              className="accent-[var(--accent-9)]"
            />
            Lead booker
          </label>
          {members.length > 1 && (
            <Button variant="ghost" isIcon onClick={() => removeMember(index)}>
              <TrashIcon className="h-4 w-4 text-red-500" />
            </Button>
          )}
        </div>
      </div>

      {/* Person search */}
      <div className="relative">
        <div className="flex items-center gap-2">
          <MagnifyingGlassIcon className="h-4 w-4 text-[var(--gray-a9)] flex-shrink-0" />
          <input
            type="text"
            placeholder="Search by email to find existing person..."
            value={searchQueries[index] ?? ''}
            onChange={(e) => handlePersonSearch(index, e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded-md bg-transparent focus:outline-none focus:ring-1 focus:ring-[var(--accent-8)]"
          />
        </div>
        {activeSearchIndex === index && (searchResults[index]?.length ?? 0) > 0 && (
          <div className="absolute z-10 mt-1 w-full bg-[var(--color-background)] border border-[var(--gray-a6)] rounded-md shadow-lg max-h-48 overflow-y-auto">
            {searchResults[index].map((person) => (
              <button
                key={person.id}
                type="button"
                onClick={() => handleSelectPerson(index, person)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--gray-a3)] transition-colors"
              >
                <span className="font-medium">
                  {person.attributes?.first_name} {person.attributes?.last_name}
                </span>
                <span className="text-[var(--gray-a11)] ml-2">{person.email}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Manual entry fields */}
      <div className="grid grid-cols-2 gap-2">
        <input
          type="text"
          placeholder="First name"
          value={member.firstName}
          onChange={(e) => updateMember(index, 'firstName', e.target.value)}
          className="px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded-md bg-transparent focus:outline-none focus:ring-1 focus:ring-[var(--accent-8)]"
        />
        <input
          type="text"
          placeholder="Last name"
          value={member.lastName}
          onChange={(e) => updateMember(index, 'lastName', e.target.value)}
          className="px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded-md bg-transparent focus:outline-none focus:ring-1 focus:ring-[var(--accent-8)]"
        />
        <input
          type="email"
          placeholder="Email"
          value={member.email}
          onChange={(e) => updateMember(index, 'email', e.target.value)}
          className="px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded-md bg-transparent focus:outline-none focus:ring-1 focus:ring-[var(--accent-8)]"
        />
        <input
          type="tel"
          placeholder="Phone"
          value={member.phone}
          onChange={(e) => updateMember(index, 'phone', e.target.value)}
          className="px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded-md bg-transparent focus:outline-none focus:ring-1 focus:ring-[var(--accent-8)]"
        />
      </div>

      {/* Event / Sub-event assignment */}
      {hasSubEvents ? (
        <div className="space-y-1">
          <span className="text-xs font-medium text-[var(--gray-a9)]">Invited to:</span>
          {subEvents.map((se) => (
            <label key={se.id} className="flex items-center gap-2 text-sm text-[var(--gray-11)]">
              <input
                type="checkbox"
                checked={member.assignedSubEvents?.includes(se.id) ?? false}
                onChange={(e) => {
                  const current = member.assignedSubEvents || [];
                  const next = e.target.checked
                    ? [...current, se.id]
                    : current.filter((id) => id !== se.id);
                  updateMember(index, 'assignedSubEvents', next);
                }}
                className="accent-[var(--accent-9)]"
              />
              {se.name}
            </label>
          ))}
        </div>
      ) : (
        <label className="flex items-center gap-2 text-sm text-[var(--gray-11)]">
          <input
            type="checkbox"
            checked={member.assignedEvents.includes(eventUuid)}
            onChange={(e) => {
              const events = e.target.checked
                ? [...member.assignedEvents, eventUuid]
                : member.assignedEvents.filter((id) => id !== eventUuid);
              updateMember(index, 'assignedEvents', events);
            }}
            className="accent-[var(--accent-9)]"
          />
          Assign to this event
        </label>
      )}
    </div>
  );

  const renderIndividualMode = () => (
    <div className="space-y-4">
      {/* Party name */}
      <div>
        <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Party Name</label>
        <input
          type="text"
          placeholder="e.g. Smith Family, VIP Table 3"
          value={partyName}
          onChange={(e) => setPartyName(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-[var(--gray-a6)] rounded-md bg-transparent focus:outline-none focus:ring-1 focus:ring-[var(--accent-8)]"
        />
      </div>

      {/* Members */}
      <div>
        <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">Members</label>
        <div className="space-y-3">
          {members.map((member, index) => renderMemberForm(member, index))}
        </div>
        <Button variant="soft" style={{ marginTop: "0.5rem" }} onClick={addMember}>
          <PlusIcon className="h-4 w-4 mr-1" />
          Add Member
        </Button>
      </div>

      {/* Plus-one allowance */}
      <div>
        <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Plus-One Allowance</label>
        <input
          type="number"
          min={0}
          value={plusOneAllowance}
          onChange={(e) => setPlusOneAllowance(Math.max(0, parseInt(e.target.value) || 0))}
          className="w-24 px-3 py-2 text-sm border border-[var(--gray-a6)] rounded-md bg-transparent focus:outline-none focus:ring-1 focus:ring-[var(--accent-8)]"
        />
        <p className="mt-1 text-xs text-[var(--gray-a9)]">
          Number of additional guests this party can bring
        </p>
      </div>

      {/* RSVP Deadline */}
      <div>
        <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">RSVP Deadline</label>
        <input
          type="datetime-local"
          value={rsvpDeadline}
          onChange={(e) => setRsvpDeadline(e.target.value)}
          className="w-64 px-3 py-2 text-sm border border-[var(--gray-a6)] rounded-md bg-transparent focus:outline-none focus:ring-1 focus:ring-[var(--accent-8)]"
        />
        <p className="mt-1 text-xs text-[var(--gray-a9)]">
          Guests must RSVP by this date. Leave empty for no deadline.
        </p>
      </div>

      {/* Delivery channel */}
      <div>
        <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Delivery Channel</label>
        <select
          value={deliveryChannel}
          onChange={(e) => setDeliveryChannel(e.target.value)}
          className="w-48 px-3 py-2 text-sm border border-[var(--gray-a6)] rounded-md bg-transparent focus:outline-none focus:ring-1 focus:ring-[var(--accent-8)]"
        >
          {DELIVERY_CHANNELS.map((ch) => (
            <option key={ch.value} value={ch.value}>{ch.label}</option>
          ))}
        </select>
      </div>
    </div>
  );

  const renderCsvMode = () => (
    <div className="space-y-4">
      {/* File upload */}
      {csvHeaders.length === 0 ? (
        <div className="border-2 border-dashed border-[var(--gray-a6)] rounded-lg p-8 text-center">
          <ArrowUpTrayIcon className="h-8 w-8 mx-auto text-[var(--gray-a9)] mb-2" />
          <p className="text-sm text-[var(--gray-a11)] mb-3">Upload a CSV file with guest information</p>
          <label className="inline-block">
            <input
              type="file"
              accept=".csv"
              onChange={handleFileUpload}
              className="hidden"
            />
            <span className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md bg-[var(--accent-9)] text-white cursor-pointer hover:bg-[var(--accent-10)] transition-colors">
              Choose File
            </span>
          </label>
        </div>
      ) : (
        <>
          {csvProgress && (
            <div className="text-sm text-[var(--accent-11)] bg-[var(--accent-3)] p-2 rounded">
              {csvProgress}
            </div>
          )}

          {/* Import mode */}
          <div>
            <label className="block text-sm font-medium text-[var(--gray-11)] mb-1.5">Import Mode</label>
            <div className="grid grid-cols-3 gap-2">
              {([
                { value: 'create', label: 'Create', desc: 'Insert new parties only. Safe to re-run only if you have no existing invites — otherwise duplicates.' },
                { value: 'upsert', label: 'Upsert', desc: 'Match existing parties by lead-member name. Update their address and members, add new parties, remove unlisted members within a party.' },
                { value: 'replace', label: 'Replace all', desc: 'Delete every invite party for this event, then create fresh from CSV. Destructive.' },
              ] as const).map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setCsvImportMode(opt.value)}
                  className={`text-left px-3 py-2 text-xs rounded-md border transition-colors ${
                    csvImportMode === opt.value
                      ? 'border-[var(--accent-8)] bg-[var(--accent-a3)] text-[var(--gray-12)]'
                      : 'border-[var(--gray-a6)] hover:border-[var(--gray-a8)] text-[var(--gray-11)]'
                  }`}
                >
                  <div className="font-medium text-sm">{opt.label}</div>
                  <div className="text-[var(--gray-a11)] mt-0.5 leading-snug">{opt.desc}</div>
                </button>
              ))}
            </div>
            {csvImportMode === 'upsert' && (
              <p className="mt-2 text-xs text-[var(--gray-a11)]">
                Matching is by the first member&apos;s first + last name. If a lead was renamed in the CSV
                (e.g. &ldquo;Alf&rdquo; → &ldquo;Alfie&rdquo;), upsert will create a duplicate — rename the lead in the DB first, or use Replace.
              </p>
            )}
            {csvImportMode === 'replace' && (
              <p className="mt-2 text-xs text-[var(--red-11)]">
                Warning: this will permanently delete all existing invite parties for this event (along with their members,
                sub-event assignments, and any RSVP responses) before importing.
              </p>
            )}
          </div>

          {/* Column mapping */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-[var(--gray-11)]">Column Mapping</label>
              <Badge color="gray">{csvRows.length} row{csvRows.length !== 1 ? 's' : ''}</Badge>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {csvHeaders.map((header) => (
                <div key={header} className="flex items-center gap-2">
                  <span className="text-sm text-[var(--gray-a11)] truncate flex-1" title={header}>
                    {header}
                  </span>
                  <select
                    value={columnMapping[header] ?? ''}
                    onChange={(e) => updateColumnMapping(header, e.target.value)}
                    className="w-36 px-2 py-1 text-sm border border-[var(--gray-a6)] rounded-md bg-transparent focus:outline-none focus:ring-1 focus:ring-[var(--accent-8)]"
                  >
                    {MAPPING_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          {/* Sub-event mapping hint */}
          {hasSubEvents && Object.values(columnMapping).includes('sub_event') && (
            <div className="rounded-md border border-[var(--gray-6)] bg-[var(--gray-2)] p-3 text-xs text-[var(--gray-11)] space-y-1">
              <p className="font-medium">Sub-event mapping:</p>
              <p>The Sub-Event column values will be matched to these sub-events by name prefix:</p>
              <ul className="list-disc ml-4">
                {subEvents.map(se => (
                  <li key={se.id}><strong>{se.name}</strong></li>
                ))}
              </ul>
              <p className="text-[var(--gray-9)]">
                e.g. &ldquo;Day&rdquo; matches &ldquo;{subEvents[0]?.name || 'Wedding'}&rdquo;,
                &ldquo;Evening&rdquo; matches &ldquo;{subEvents.find(se => se.name.toLowerCase().includes('evening'))?.name || 'Evening Reception'}&rdquo;.
                Blank values assign to all sub-events.
              </p>
            </div>
          )}

          {/* Party group hint */}
          {Object.values(columnMapping).includes('party_group') && (
            <div className="rounded-md border border-[var(--gray-6)] bg-[var(--gray-2)] p-3 text-xs text-[var(--gray-11)]">
              <p>
                <strong>Party Group</strong>: rows with the same value in this column will be grouped into a single party.
                The party name will be derived from the members&apos; first names automatically.
              </p>
            </div>
          )}

          {/* Preview table */}
          <div>
            <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
              Preview (first {Math.min(10, csvRows.length)} rows)
            </label>
            <div className="overflow-x-auto border border-[var(--gray-a6)] rounded-md">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--gray-a6)] bg-[var(--gray-a2)]">
                    {csvHeaders.map((header) => {
                      const mapped = columnMapping[header];
                      return (
                        <th key={header} className="px-3 py-2 text-left font-medium text-[var(--gray-11)] whitespace-nowrap">
                          {header}
                          {mapped && (
                            <Badge color="blue" className="ml-1.5 text-[10px]">
                              {MAPPING_OPTIONS.find((o) => o.value === mapped)?.label}
                            </Badge>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {csvRows.slice(0, 10).map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-b border-[var(--gray-a4)] last:border-0">
                      {csvHeaders.map((header, colIndex) => (
                        <td key={`${rowIndex}-${colIndex}`} className="px-3 py-1.5 text-[var(--gray-11)] whitespace-nowrap">
                          {row[colIndex] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Reset file */}
          <button
            type="button"
            onClick={() => { setCsvHeaders([]); setCsvRows([]); setColumnMapping({}); }}
            className="text-sm text-[var(--accent-9)] hover:text-[var(--accent-11)] transition-colors"
          >
            Choose a different file
          </button>
        </>
      )}
    </div>
  );

  const footer = (
    <div className="flex justify-end gap-2">
      <Button variant="soft" onClick={handleClose} disabled={submitting}>
        Cancel
      </Button>
      <Button
        onClick={activeMode === 'individual' ? handleIndividualSubmit : handleCsvSubmit}
        disabled={submitting || (activeMode === 'csv' && csvHeaders.length === 0)}
      >
        {submitting
          ? 'Working...'
          : activeMode === 'individual'
            ? 'Create Party'
            : csvImportMode === 'replace'
              ? `Replace & import ${csvRows.length} row${csvRows.length !== 1 ? 's' : ''}`
              : csvImportMode === 'upsert'
                ? `Upsert ${csvRows.length} row${csvRows.length !== 1 ? 's' : ''}`
                : `Import ${csvRows.length} row${csvRows.length !== 1 ? 's' : ''}`
        }
      </Button>
    </div>
  );

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Create Invite Party" size="xl" footer={footer}>
      {renderModeToggle()}
      {activeMode === 'individual' ? renderIndividualMode() : renderCsvMode()}
    </Modal>
  );
}
