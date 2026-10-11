/**
 * Key people: the one to five people an event is about, with up to five
 * photos each. The photo booth uses them for its example pictures, so
 * every look and decade card shows these people rather than strangers.
 *
 * Rows are written straight to events_media_key_people under the
 * organiser's own session (RLS: can_admin_host_media); photos go to
 * storage under the event's key-people folder, the only place the
 * example generator will read from.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';

interface KeyPerson {
  id: string;
  name: string;
  photos: string[];
  sort_order: number;
}

interface Job {
  state: 'running' | 'done' | 'failed';
  total: number;
  done: number;
  failed: number;
  error?: string;
}

const MAX_PEOPLE = 5;
const MAX_PHOTOS = 5;

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
const apiUrl = env.VITE_API_URL ?? '';
const supabasePublicUrl = (env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data: session } = await supabase.auth.getSession();
  const headers = new Headers(init?.headers);
  const token = session.session?.access_token;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${apiUrl}${path}`, { ...init, headers });
}

export function KeyPeoplePanel({ eventId }: { eventId: string }) {
  const [people, setPeople] = useState<KeyPerson[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('events_media_key_people')
      .select('id, name, photos, sort_order')
      .eq('event_id', eventId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (!error) setPeople((data ?? []) as KeyPerson[]);
  }, [eventId]);

  const loadJob = useCallback(async () => {
    try {
      const res = await authedFetch(`/api/admin/events/${eventId}/booth/examples`);
      if (res.ok) setJob((await res.json()).job ?? null);
    } catch { /* status is a nicety */ }
  }, [eventId]);

  useEffect(() => { void load(); void loadJob(); }, [load, loadJob]);

  // Follow a running job.
  useEffect(() => {
    if (job?.state !== 'running') return;
    const t = setInterval(() => void loadJob(), 3000);
    return () => clearInterval(t);
  }, [job?.state, loadJob]);

  const addPerson = async () => {
    const name = newName.trim().slice(0, 60);
    if (!name || people.length >= MAX_PEOPLE) return;
    const { error } = await supabase
      .from('events_media_key_people')
      .insert({ event_id: eventId, name, sort_order: people.length });
    if (error) { toast.error(error.message.includes('five') ? 'An event can have at most five key people' : 'Could not add them'); return; }
    setNewName('');
    await load();
  };

  const removePerson = async (p: KeyPerson) => {
    if (!window.confirm(`Remove ${p.name} and their photos?`)) return;
    const { error } = await supabase.from('events_media_key_people').delete().eq('id', p.id);
    if (error) { toast.error('Could not remove them'); return; }
    if (p.photos.length) await supabase.storage.from('media').remove(p.photos);
    await load();
  };

  const addPhotos = async (p: KeyPerson, files: FileList) => {
    const room = MAX_PHOTOS - p.photos.length;
    const chosen = Array.from(files).filter((f) => f.type.startsWith('image/')).slice(0, room);
    if (chosen.length === 0) return;
    setBusy(p.id);
    try {
      const added: string[] = [];
      for (const file of chosen) {
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
        const path = `event/${eventId}/key-people/${crypto.randomUUID()}.${ext}`;
        const { error } = await supabase.storage.from('media').upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });
        if (error) { toast.error(`Upload failed: ${error.message}`); continue; }
        added.push(path);
      }
      if (added.length) {
        const { error } = await supabase
          .from('events_media_key_people')
          .update({ photos: [...p.photos, ...added].slice(0, MAX_PHOTOS) })
          .eq('id', p.id);
        if (error) toast.error('Could not save the photos');
      }
      if (files.length > room) toast.message(`Only ${MAX_PHOTOS} photos per person — kept the first ${room}.`);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const removePhoto = async (p: KeyPerson, path: string) => {
    const { error } = await supabase
      .from('events_media_key_people')
      .update({ photos: p.photos.filter((x) => x !== path) })
      .eq('id', p.id);
    if (error) { toast.error('Could not remove that photo'); return; }
    await supabase.storage.from('media').remove([path]);
    await load();
  };

  const generate = async () => {
    const looks = 54;
    if (!window.confirm(`Make new example pictures for every look (${looks} pictures, about $2)? It takes a few minutes.`)) return;
    const res = await authedFetch(`/api/admin/events/${eventId}/booth/examples`, { method: 'POST' });
    const body = await res.json().catch(() => null);
    if (!res.ok) { toast.error(body?.message ?? 'Could not start'); return; }
    setJob(body?.job ?? null);
    toast.success('Making the example pictures…');
  };

  const withPhotos = people.filter((p) => p.photos.length > 0).length;

  return (
    <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
      <p className="text-sm font-medium mb-1">Key people</p>
      <p className="text-xs text-gray-500 mb-2">
        The people this event is about — up to {MAX_PEOPLE}, with up to {MAX_PHOTOS} clear, front-facing photos
        each. The photo booth uses them for its example pictures, so every look shows them.
      </p>

      <div className="space-y-3 mb-2">
        {people.map((p) => (
          <div key={p.id} className="rounded-md border border-gray-100 dark:border-gray-800 p-2">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium">{p.name}</span>
              <span className="text-xs text-gray-500">{p.photos.length}/{MAX_PHOTOS} photos</span>
              <span className="flex-1" />
              <button className="text-xs underline text-red-600" onClick={() => void removePerson(p)}>Remove</button>
            </div>
            <div className="flex flex-wrap gap-2">
              {p.photos.map((path) => (
                <div key={path} className="relative">
                  <img
                    src={`${supabasePublicUrl}/storage/v1/object/public/media/${path}`}
                    alt=""
                    className="w-16 h-16 rounded object-cover"
                  />
                  <button
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black/70 text-white text-xs leading-5"
                    aria-label="Remove photo"
                    onClick={() => void removePhoto(p, path)}
                  >
                    ×
                  </button>
                </div>
              ))}
              {p.photos.length < MAX_PHOTOS && (
                <>
                  <button
                    className="w-16 h-16 rounded border border-dashed border-gray-300 dark:border-gray-600 text-xs text-gray-500"
                    disabled={busy === p.id}
                    onClick={() => fileRefs.current[p.id]?.click()}
                  >
                    {busy === p.id ? '…' : '+ Photo'}
                  </button>
                  <input
                    ref={(el) => { fileRefs.current[p.id] = el; }}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => { if (e.target.files) void addPhotos(p, e.target.files); e.target.value = ''; }}
                  />
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {people.length < MAX_PEOPLE && (
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addPerson(); }}
            placeholder="Name, e.g. Sarah"
            maxLength={60}
            className="flex-1 rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1.5 text-sm"
          />
          <button className="rounded bg-blue-600 text-white text-sm px-3 py-1.5 disabled:opacity-50" disabled={!newName.trim()} onClick={() => void addPerson()}>
            Add person
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="rounded bg-gray-900 dark:bg-white dark:text-gray-900 text-white text-sm px-3 py-1.5 disabled:opacity-50"
          disabled={withPhotos === 0 || job?.state === 'running'}
          onClick={() => void generate()}
        >
          {job?.state === 'running' ? 'Making example pictures…' : 'Make example pictures'}
        </button>
        {job && (
          <span className="text-xs text-gray-500">
            {job.state === 'running' && `${job.done + job.failed} of ${job.total} done`}
            {job.state === 'done' && `Done: ${job.done} new pictures${job.failed ? `, ${job.failed} kept their old one` : ''}. Guests see them within five minutes.`}
            {job.state === 'failed' && `Did not finish${job.error ? `: ${job.error}` : ''}.`}
          </span>
        )}
      </div>
    </div>
  );
}
