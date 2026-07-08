import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { Card, Button, Input, Modal, Badge } from '@/components/ui';
import {
  UserIcon,
  MagnifyingGlassIcon,
  LinkIcon,
  PencilIcon,
} from '@heroicons/react/24/outline';

interface BlogAuthor {
  id: string;
  slug: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  person_id: string | null;
  is_external: boolean;
  source_url: string | null;
  created_at: string;
  post_count: number;
}

function initials(name: string): string {
  return (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

const BlogAuthorsPage: React.FC = () => {
  const [authors, setAuthors] = useState<BlogAuthor[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<BlogAuthor | null>(null);
  const [editName, setEditName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [offering, setOffering] = useState<BlogAuthor | null>(null);
  const [offerEmail, setOfferEmail] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      // blog_posts.blog_author_id → blog_authors enables the embedded count.
      const { data, error } = await supabase
        .from('blog_authors')
        .select('id, slug, display_name, avatar_url, bio, person_id, is_external, source_url, created_at, posts:blog_posts(count)')
        .order('display_name', { ascending: true });
      if (error) throw error;
      const rows: BlogAuthor[] = (data ?? []).map((r: any) => ({
        ...r,
        post_count: Array.isArray(r.posts) ? (r.posts[0]?.count ?? 0) : 0,
      }));
      setAuthors(rows);
    } catch (e: any) {
      toast.error(`Failed to load authors: ${e.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return authors;
    return authors.filter(
      (a) => a.display_name.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q),
    );
  }, [authors, search]);

  function openEdit(a: BlogAuthor) {
    setEditing(a);
    setEditName(a.display_name);
    setEditBio(a.bio ?? '');
  }

  async function saveEdit() {
    if (!editing) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('blog_authors')
        .update({ display_name: editName.trim(), bio: editBio.trim() || null, updated_at: new Date().toISOString() })
        .eq('id', editing.id);
      if (error) throw error;
      toast.success('Author updated');
      setEditing(null);
      load();
    } catch (e: any) {
      toast.error(`Save failed: ${e.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }

  async function issueOffer() {
    if (!offering) return;
    const email = offerEmail.trim().toLowerCase();
    if (!email) return;
    setSaving(true);
    try {
      // Resolve the person by any owned email (alias table), else base people.
      const { data: alias } = await supabase
        .from('person_emails')
        .select('person_id')
        .eq('email', email)
        .maybeSingle();
      let personId = alias?.person_id ?? null;
      if (!personId) {
        const { data: p } = await supabase.from('people').select('id').eq('email', email).maybeSingle();
        personId = p?.id ?? null;
      }
      if (!personId) {
        toast.error('No person found for that email');
        return;
      }
      const me = (await supabase.auth.getUser()).data.user?.id ?? null;
      let createdBy: string | null = null;
      if (me) {
        const { data: mine } = await supabase.from('people').select('id').eq('auth_user_id', me).maybeSingle();
        createdBy = mine?.id ?? null;
      }
      const { error } = await supabase.from('blog_author_claim_offers').upsert(
        { blog_author_id: offering.id, person_id: personId, created_by: createdBy },
        { onConflict: 'blog_author_id,person_id' },
      );
      if (error) throw error;
      toast.success('Claim offer issued (valid 7 days)');
      setOffering(null);
      setOfferEmail('');
    } catch (e: any) {
      toast.error(`Offer failed: ${e.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <UserIcon className="w-6 h-6" /> Blog Authors
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Authors discovered by scrapers or created in the platform. Linked authors resolve to a person record
            (avatars, provenance); issue a claim offer to let a signed-in member take ownership of their profile.
          </p>
        </div>
      </div>

      <div className="relative max-w-sm">
        <MagnifyingGlassIcon className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
        <Input
          className="pl-9"
          placeholder="Search authors…"
          value={search}
          onChange={(e: any) => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="text-gray-500">Loading…</div>
      ) : filtered.length === 0 ? (
        <Card className="p-8 text-center text-gray-500">No authors yet. Run a blog scraper to populate them.</Card>
      ) : (
        <div className="grid gap-3">
          {filtered.map((a) => (
            <Card key={a.id} className="p-4 flex items-center gap-4">
              {a.avatar_url ? (
                <img src={a.avatar_url} alt={a.display_name} className="w-10 h-10 rounded-full object-cover" />
              ) : (
                <span className="w-10 h-10 rounded-full bg-gray-200 text-gray-600 flex items-center justify-center text-sm font-medium">
                  {initials(a.display_name)}
                </span>
              )}
              <div className="flex-1 min-w-0">
                <div className="font-medium flex items-center gap-2">
                  {a.display_name}
                  {a.is_external && <Badge variant="secondary">external</Badge>}
                  {a.person_id ? (
                    <Badge variant="success" className="flex items-center gap-1">
                      <LinkIcon className="w-3 h-3" /> linked
                    </Badge>
                  ) : (
                    <Badge variant="warning">no person</Badge>
                  )}
                </div>
                <div className="text-xs text-gray-500 truncate">
                  /blog/author/{a.slug} · {a.post_count} {a.post_count === 1 ? 'post' : 'posts'}
                  {a.source_url ? (
                    <>
                      {' · '}
                      <a href={a.source_url} target="_blank" rel="noopener noreferrer" className="underline">
                        source
                      </a>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => openEdit(a)}>
                  <PencilIcon className="w-4 h-4 mr-1" /> Edit
                </Button>
                <Button variant="outline" size="sm" onClick={() => setOffering(a)}>
                  <LinkIcon className="w-4 h-4 mr-1" /> Offer claim
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Edit modal */}
      <Modal isOpen={!!editing} onClose={() => setEditing(null)} title="Edit author">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Display name</label>
            <Input value={editName} onChange={(e: any) => setEditName(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Bio</label>
            <textarea
              className="w-full border rounded-md p-2 text-sm"
              rows={4}
              value={editBio}
              onChange={(e) => setEditBio(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={saveEdit} disabled={saving}>Save</Button>
          </div>
        </div>
      </Modal>

      {/* Claim-offer modal */}
      <Modal isOpen={!!offering} onClose={() => setOffering(null)} title={`Offer claim: ${offering?.display_name ?? ''}`}>
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            Enter the email of the member who should be able to claim this author profile. They must be a registered
            person; on claim their account takes over the profile (the synthetic record is merged in). Offers expire
            after 7 days.
          </p>
          <div>
            <label className="block text-sm font-medium mb-1">Member email</label>
            <Input
              type="email"
              placeholder="person@example.com"
              value={offerEmail}
              onChange={(e: any) => setOfferEmail(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOffering(null)}>Cancel</Button>
            <Button onClick={issueOffer} disabled={saving || !offerEmail.trim()}>Issue offer</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default BlogAuthorsPage;
