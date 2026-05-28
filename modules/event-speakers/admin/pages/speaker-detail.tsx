import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import { Card, Badge, Button } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase } from '@/lib/supabase';
import {
  SpeakersRollupService,
  SpeakerProfile,
  Talk,
} from '../services/speakersRollupService';

export default function SpeakerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [speaker, setSpeaker] = useState<SpeakerProfile | null>(null);
  const [talks, setTalks] = useState<Talk[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function load() {
    if (!id) return;
    setLoading(true);
    const result = await SpeakersRollupService.getSpeaker(id);
    if (result.success && result.data) {
      setSpeaker(result.data);

      // Load talks attributed to this speaker via the junction
      const { data: junctionRows } = await supabase
        .from('events_talk_speakers')
        .select('talk_id, events_talks!inner(*), events_speakers!inner(speaker_id)')
        .eq('events_speakers.speaker_id', id);

      const talkRows: Talk[] = (junctionRows || [])
        .map((row: any) => row.events_talks)
        .filter(Boolean);
      setTalks(talkRows);
    }
    setLoading(false);
  }

  if (loading || !speaker) {
    return (
      <Page title="Speaker">
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      </Page>
    );
  }

  return (
    <Page title={speaker.name}>
      <div className="space-y-4">
        <button
          onClick={() => navigate('/speakers')}
          className="text-xs text-[var(--gray-10)] hover:text-[var(--gray-12)] flex items-center gap-1"
        >
          <ArrowLeftIcon className="size-3" />
          Back to directory
        </button>

        {/* Header */}
        <Card className="p-6">
          <div className="flex items-start gap-4">
            <div className="size-16 rounded-full bg-[var(--gray-3)] flex items-center justify-center flex-shrink-0">
              {speaker.avatar_url ? (
                <img src={speaker.avatar_url} alt={speaker.name} className="size-16 rounded-full object-cover" />
              ) : (
                <span className="text-xl font-bold text-[var(--gray-11)]">
                  {speaker.name.split(' ').map((s) => s[0]).slice(0, 2).join('')}
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-bold text-[var(--gray-12)]">{speaker.name}</h1>
              {(speaker.title || speaker.company) && (
                <p className="text-sm text-[var(--gray-10)] mt-1">
                  {[speaker.title, speaker.company].filter(Boolean).join(' · ')}
                </p>
              )}
              {speaker.email && (
                <p className="text-xs text-[var(--gray-10)] font-mono mt-1">{speaker.email}</p>
              )}
              {speaker.bio && (
                <p className="text-sm text-[var(--gray-11)] mt-3 whitespace-pre-wrap">{speaker.bio}</p>
              )}
              <div className="flex flex-wrap gap-2 mt-3">
                {speaker.linkedin_url && (
                  <a href={speaker.linkedin_url} target="_blank" rel="noreferrer" className="text-xs text-[var(--accent-11)] hover:underline">
                    LinkedIn
                  </a>
                )}
                {speaker.twitter_url && (
                  <a href={speaker.twitter_url} target="_blank" rel="noreferrer" className="text-xs text-[var(--accent-11)] hover:underline">
                    Twitter
                  </a>
                )}
                {speaker.website_url && (
                  <a href={speaker.website_url} target="_blank" rel="noreferrer" className="text-xs text-[var(--accent-11)] hover:underline">
                    Website
                  </a>
                )}
              </div>
              {speaker.topics && speaker.topics.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-3">
                  {speaker.topics.map((t) => (
                    <Badge key={t} color="info" className="text-[10px]">{t}</Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Card>

        {/* Talks */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">
            Talks <span className="text-sm font-normal text-[var(--gray-10)]">({talks.length})</span>
          </h2>
          {talks.length === 0 ? (
            <p className="text-sm text-[var(--gray-10)]">No talks attributed to this speaker yet.</p>
          ) : (
            <div className="space-y-2">
              {talks.map((talk) => (
                <div key={talk.id} className="border border-[var(--gray-6)] rounded px-4 py-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge color="neutral" className="text-[10px]">{talk.scope}</Badge>
                    <Badge
                      color={talk.status === 'accepted' ? 'success' : talk.status === 'pending' ? 'warning' : 'neutral'}
                      className="text-[10px]"
                    >
                      {talk.status}
                    </Badge>
                  </div>
                  <div className="text-sm font-medium text-[var(--gray-12)]">{talk.title}</div>
                  {talk.synopsis && (
                    <p className="text-xs text-[var(--gray-10)] line-clamp-2 mt-1">{talk.synopsis}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
