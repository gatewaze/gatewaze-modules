import { useState, useEffect } from 'react';
import { Card, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { EngagementService, EngagementBadge } from '../services/engagementService';

export default function BadgesPage() {
  const [badges, setBadges] = useState<EngagementBadge[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const result = await EngagementService.listBadges();
      if (result.success && result.data) setBadges(result.data);
      setLoading(false);
    })();
  }, []);

  return (
    <Page title="Badges">
      {loading ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {badges.map((badge) => (
            <Card key={badge.id} className="p-4">
              <div className="flex items-start gap-3">
                <div
                  className="size-12 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: badge.color || '#888' }}
                >
                  <span className="text-white text-xs font-bold">{badge.label.slice(0, 2)}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-[var(--gray-12)] truncate">{badge.label}</h3>
                    {!badge.is_active && <Badge color="neutral" className="text-[10px]">inactive</Badge>}
                  </div>
                  <p className="text-xs text-[var(--gray-10)] mt-1 line-clamp-2">{badge.description}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <Badge color="info" className="text-[10px] font-mono">{badge.rule_kind}</Badge>
                    <Badge color="neutral" className="text-[10px]">{badge.scope.replace('_', ' ')}</Badge>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}
