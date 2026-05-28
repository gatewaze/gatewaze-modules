import { useState, useEffect } from 'react';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { Card, Input, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase } from '@/lib/supabase';

interface UsernameRow {
  id: string;
  username: string;
  person_id?: string;
}

export default function UsernamesPage() {
  const [rows, setRows] = useState<UsernameRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from('people_profiles')
      .select('id, username')
      .not('username', 'is', null)
      .order('username', { ascending: true })
      .limit(500);
    if (!error && data) {
      setRows(data as UsernameRow[]);
    }
    setLoading(false);
  }

  const filtered = rows.filter((r) =>
    !search || r.username.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Page title="Usernames">
      <div className="space-y-4">
        <Card className="p-4">
          <Input
            placeholder="Search usernames"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            prefix={<MagnifyingGlassIcon className="size-4" />}
          />
        </Card>

        <Card className="p-4">
          {loading ? (
            <div className="flex justify-center py-12"><LoadingSpinner /></div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-[var(--gray-10)] text-center py-8">
              {search ? 'No usernames match.' : 'No usernames set yet.'}
            </p>
          ) : (
            <div className="space-y-1">
              {filtered.map((row) => (
                <div
                  key={row.id}
                  className="flex items-center justify-between px-3 py-2 border border-[var(--gray-6)] rounded"
                >
                  <div className="flex items-center gap-2">
                    <Badge color="info" className="font-mono text-xs">@{row.username}</Badge>
                    <span className="text-xs text-[var(--gray-10)] font-mono">{row.id.slice(0, 8)}…</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
