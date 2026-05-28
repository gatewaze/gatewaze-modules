import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { MagnifyingGlassIcon, MicrophoneIcon } from '@heroicons/react/24/outline';
import { Card, Input, Button, Badge } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import {
  SpeakersRollupService,
  SpeakerProfile,
} from '../services/speakersRollupService';

export default function SpeakersIndexPage() {
  const navigate = useNavigate();
  const [speakers, setSpeakers] = useState<SpeakerProfile[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => load(), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function load() {
    setLoading(true);
    const result = await SpeakersRollupService.listSpeakers({ search, limit: 100 });
    if (result.success && result.data) {
      setSpeakers(result.data.speakers);
      setTotal(result.data.total);
    }
    setLoading(false);
  }

  return (
    <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-[var(--gray-11)]">
            Everyone who has spoken or offered to speak across your brand.
            <span className="ml-2 text-[var(--gray-10)]">({total})</span>
          </p>
          <Button onClick={() => navigate('/speakers/talks')} variant="outline">
            View talk pool
          </Button>
        </div>

        <Card className="p-4">
          <Input
            placeholder="Search by name, email, or company"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            prefix={<MagnifyingGlassIcon className="size-4" />}
          />
        </Card>

        <Card className="p-4">
          {loading ? (
            <div className="flex justify-center py-12"><LoadingSpinner /></div>
          ) : speakers.length === 0 ? (
            <p className="text-sm text-[var(--gray-10)] text-center py-8">
              {search ? 'No speakers match your search.' : 'No speakers in the directory yet.'}
            </p>
          ) : (
            <div className="space-y-2">
              {speakers.map((speaker) => (
                <button
                  key={speaker.id}
                  onClick={() => navigate(`/speakers/${speaker.id}`)}
                  className="w-full text-left flex items-start gap-3 border border-[var(--gray-6)] rounded px-4 py-3 hover:border-[var(--gray-8)] transition-colors"
                >
                  <div className="size-10 rounded-full bg-[var(--gray-3)] flex items-center justify-center flex-shrink-0">
                    {speaker.avatar_url ? (
                      <img src={speaker.avatar_url} alt={speaker.name} className="size-10 rounded-full object-cover" />
                    ) : (
                      <MicrophoneIcon className="size-5 text-[var(--gray-10)]" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[var(--gray-12)]">{speaker.name}</span>
                      {!speaker.is_active && <Badge color="neutral" className="text-[10px]">inactive</Badge>}
                    </div>
                    {(speaker.title || speaker.company) && (
                      <div className="text-xs text-[var(--gray-10)] mt-0.5">
                        {[speaker.title, speaker.company].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    {speaker.topics && speaker.topics.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {speaker.topics.slice(0, 4).map((topic) => (
                          <span
                            key={topic}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--gray-3)] text-[var(--gray-11)]"
                          >
                            {topic}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {speaker.email && (
                    <span className="text-xs text-[var(--gray-10)] font-mono truncate max-w-[200px]">
                      {speaker.email}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </Card>
    </div>
  );
}
