import { useState, useEffect, useMemo } from 'react';
import {
  TrophyIcon,
  FunnelIcon,
  ArrowTopRightOnSquareIcon,
  ChevronDownIcon,
  ChartBarIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Badge, Button } from '@/components/ui';
import { Spinner } from '@/components/ui/Spinner';
import { supabase } from '@/lib/supabase';
import { getShortLinkDomain } from '@/config/brands';

interface NewsletterLink {
  id: string;
  path: string;
  title: string | null;
  content_type: string | null;
  content_number: number | null;
  platform: string | null;
  newsletter_date: string | null;
  distribution_channel: string;
  ad_type: string | null;
  total_clicks: number;
  human_clicks: number;
  unique_clicks: number;
  is_current: boolean;
}

interface Edition {
  date: string;
  customerio: number;
  substack: number;
}

const CONTENT_TYPE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  podcast: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-300', border: 'border-purple-200 dark:border-purple-800' },
  gem: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300', border: 'border-amber-200 dark:border-amber-800' },
  blog: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-300', border: 'border-blue-200 dark:border-blue-800' },
  hot_take: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-300', border: 'border-red-200 dark:border-red-800' },
  job: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-300', border: 'border-green-200 dark:border-green-800' },
  reading_group: { bg: 'bg-indigo-100 dark:bg-indigo-900/30', text: 'text-indigo-700 dark:text-indigo-300', border: 'border-indigo-200 dark:border-indigo-800' },
  ad: { bg: 'bg-pink-100 dark:bg-pink-900/30', text: 'text-pink-700 dark:text-pink-300', border: 'border-pink-200 dark:border-pink-800' },
  intro: { bg: 'bg-cyan-100 dark:bg-cyan-900/30', text: 'text-cyan-700 dark:text-cyan-300', border: 'border-cyan-200 dark:border-cyan-800' },
  rewind: { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-300', border: 'border-orange-200 dark:border-orange-800' },
};

const PLATFORM_ICONS: Record<string, string> = {
  spotify: '🎧',
  apple: '🍎',
  gradual: '📺',
  youtube: '▶️',
};

export function NewsletterLeaderboardTab() {
  const [links, setLinks] = useState<NewsletterLink[]>([]);
  const [editions, setEditions] = useState<Edition[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedContentType, setSelectedContentType] = useState<string>('all');
  const [selectedEdition, setSelectedEdition] = useState<string>('all');
  const [selectedAdType, setSelectedAdType] = useState<string>('all');
  const [limit, setLimit] = useState(25);
  const [showFilters, setShowFilters] = useState(false);

  const shortIoDomain = getShortLinkDomain();

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      // First, load valid newsletter dates from the newsletters table
      const { data: newslettersData, error: newslettersError } = await supabase
        .from('newsletters')
        .select('date')
        .eq('published', true)
        .order('date', { ascending: false });

      if (newslettersError) throw newslettersError;

      // Create a set of valid newsletter dates for filtering
      const validNewsletterDates = new Set(
        (newslettersData || []).map(n => n.date)
      );

      // Load all newsletter links
      const { data: linksData, error: linksError } = await supabase
        .from('redirects')
        .select('id, path, title, content_type, content_number, platform, newsletter_date, distribution_channel, ad_type, total_clicks, human_clicks, unique_clicks, is_current')
        .eq('domain', shortIoDomain)
        .eq('link_category', 'newsletter')
        .order('human_clicks', { ascending: false });

      if (linksError) throw linksError;

      // Filter links to only include those with newsletter dates that exist in the newsletters table
      const filteredLinks = (linksData || []).filter(
        link => link.newsletter_date && validNewsletterDates.has(link.newsletter_date)
      );
      setLinks(filteredLinks);

      // Build editions from filtered links
      const editionMap: Record<string, Edition> = {};
      filteredLinks.forEach((r) => {
        if (!r.newsletter_date) return;
        if (!editionMap[r.newsletter_date]) {
          editionMap[r.newsletter_date] = { date: r.newsletter_date, customerio: 0, substack: 0 };
        }
        if (r.distribution_channel === 'substack') {
          editionMap[r.newsletter_date].substack++;
        } else {
          editionMap[r.newsletter_date].customerio++;
        }
      });
      setEditions(Object.values(editionMap).sort((a, b) => b.date.localeCompare(a.date)));
    } catch (error) {
      console.error('Error loading data:', error);
      toast.error('Failed to load newsletter data');
    } finally {
      setLoading(false);
    }
  };

  // Get unique content types
  const contentTypes = useMemo(() => {
    const types = new Set(links.map(l => l.content_type).filter(Boolean));
    return Array.from(types).sort();
  }, [links]);

  // Get unique ad types
  const adTypes = useMemo(() => {
    const types = new Set(links.map(l => l.ad_type).filter(Boolean));
    return Array.from(types).sort();
  }, [links]);

  // Filter and limit links
  const filteredLinks = useMemo(() => {
    let result = links;

    if (selectedContentType !== 'all') {
      result = result.filter(l => l.content_type === selectedContentType);
    }

    if (selectedEdition !== 'all') {
      result = result.filter(l => l.newsletter_date === selectedEdition);
    }

    if (selectedAdType !== 'all') {
      result = result.filter(l => l.ad_type === selectedAdType);
    }

    return result.slice(0, limit);
  }, [links, selectedContentType, selectedEdition, selectedAdType, limit]);

  // Calculate stats
  const stats = useMemo(() => {
    const hasFilters = selectedContentType !== 'all' || selectedEdition !== 'all' || selectedAdType !== 'all';
    const filtered = hasFilters ? filteredLinks : links;
    return {
      totalLinks: filtered.length,
      totalClicks: filtered.reduce((sum, l) => sum + l.human_clicks, 0),
      avgClicks: filtered.length > 0 ? Math.round(filtered.reduce((sum, l) => sum + l.human_clicks, 0) / filtered.length) : 0,
    };
  }, [links, filteredLinks, selectedContentType, selectedEdition]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getContentTypeStyle = (type: string | null) => {
    if (!type) return { bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-600 dark:text-gray-400', border: 'border-gray-200 dark:border-gray-700' };
    return CONTENT_TYPE_COLORS[type] || { bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-600 dark:text-gray-400', border: 'border-gray-200 dark:border-gray-700' };
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="size-10" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card skin="bordered" className="p-5 bg-gradient-to-br from-primary-50 to-white dark:from-primary-900/20 dark:to-gray-900">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-primary-100 dark:bg-primary-900/50 rounded-xl">
              <TrophyIcon className="size-6 text-primary-600 dark:text-primary-400" />
            </div>
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400 font-medium">Total Links</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{stats.totalLinks.toLocaleString()}</p>
            </div>
          </div>
        </Card>
        <Card skin="bordered" className="p-5 bg-gradient-to-br from-success-50 to-white dark:from-success-900/20 dark:to-gray-900">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-success-100 dark:bg-success-900/50 rounded-xl">
              <ChevronDownIcon className="size-6 text-success-600 dark:text-success-400 rotate-180" />
            </div>
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400 font-medium">Total Human Clicks</p>
              <p className="text-2xl font-bold text-success-600 dark:text-success-400">{stats.totalClicks.toLocaleString()}</p>
            </div>
          </div>
        </Card>
        <Card skin="bordered" className="p-5 bg-gradient-to-br from-info-50 to-white dark:from-info-900/20 dark:to-gray-900">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-info-100 dark:bg-info-900/50 rounded-xl">
              <ChartBarIcon className="size-6 text-info-600 dark:text-info-400" />
            </div>
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400 font-medium">Avg Clicks/Link</p>
              <p className="text-2xl font-bold text-info-600 dark:text-info-400">{stats.avgClicks.toLocaleString()}</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Filters */}
      <Card variant="surface" className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Button
            variant="outlined"
            onClick={() => setShowFilters(!showFilters)}
            className="gap-2"
          >
            <FunnelIcon className="size-4" />
            Filters
            {(selectedContentType !== 'all' || selectedEdition !== 'all' || selectedAdType !== 'all') && (
              <Badge color="primary" variant="filled" className="ml-1">
                {(selectedContentType !== 'all' ? 1 : 0) + (selectedEdition !== 'all' ? 1 : 0) + (selectedAdType !== 'all' ? 1 : 0)}
              </Badge>
            )}
          </Button>

          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500 dark:text-gray-400">Show:</span>
            {[25, 50, 100].map((n) => (
              <Button
                key={n}
                variant={limit === n ? 'soft' : 'ghost'}
                onClick={() => setLimit(n)}
              >
                {n}
              </Button>
            ))}
          </div>
        </div>

        {showFilters && (
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Content Type
              </label>
              <select
                value={selectedContentType}
                onChange={(e) => setSelectedContentType(e.target.value)}
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="all">All Types</option>
                {contentTypes.map((type) => (
                  <option key={type} value={type!}>
                    {type!.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Ad Type
              </label>
              <select
                value={selectedAdType}
                onChange={(e) => setSelectedAdType(e.target.value)}
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="all">All Ad Types</option>
                {adTypes.map((type) => (
                  <option key={type} value={type!}>
                    {type!.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Newsletter Edition
              </label>
              <select
                value={selectedEdition}
                onChange={(e) => setSelectedEdition(e.target.value)}
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="all">All Editions</option>
                {editions.map((edition) => (
                  <option key={edition.date} value={edition.date}>
                    {formatDate(edition.date)} ({edition.customerio + edition.substack} links)
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </Card>

      {/* Leaderboard */}
      <Card variant="surface" className="overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-gray-50 to-white dark:from-gray-800/50 dark:to-gray-900">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <TrophyIcon className="size-5 text-amber-500" />
            Top Performing Links
          </h3>
        </div>

        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {filteredLinks.map((link, index) => {
            const style = getContentTypeStyle(link.content_type);
            const isTop3 = index < 3;

            return (
              <div
                key={link.id}
                className={`px-6 py-4 flex items-center gap-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${
                  isTop3 ? 'bg-gradient-to-r from-amber-50/50 to-transparent dark:from-amber-900/10' : ''
                }`}
              >
                {/* Rank */}
                <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center font-bold ${
                  index === 0 ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300' :
                  index === 1 ? 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300' :
                  index === 2 ? 'bg-orange-100 dark:bg-orange-900/50 text-orange-700 dark:text-orange-300' :
                  'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                }`}>
                  {index + 1}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-sm font-medium text-primary-600 dark:text-primary-400">
                      /{link.path}
                    </span>
                    {link.platform && (
                      <span className="text-lg" title={link.platform}>
                        {PLATFORM_ICONS[link.platform] || '🔗'}
                      </span>
                    )}
                    {!link.is_current && (
                      <Badge color="warning" variant="soft" className="text-xs">
                        Superseded
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 truncate">
                    {link.title || 'No title'}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {link.content_type && (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${style.bg} ${style.text}`}>
                        {link.content_type.replace(/_/g, ' ')}
                        {link.content_number && ` ${link.content_number}`}
                      </span>
                    )}
                    {link.ad_type && (
                      <Badge color="secondary" variant="soft" className="text-xs">
                        {link.ad_type.replace(/_/g, ' ')}
                      </Badge>
                    )}
                    {link.newsletter_date && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {formatDate(link.newsletter_date)}
                      </span>
                    )}
                    <Badge
                      color={link.distribution_channel === 'substack' ? 'warning' : 'info'}
                      variant="soft"
                      className="text-xs"
                    >
                      {link.distribution_channel === 'substack' ? 'Substack' : 'Customer.io'}
                    </Badge>
                  </div>
                </div>

                {/* Clicks */}
                <div className="flex-shrink-0 text-right">
                  <div className="text-xl font-bold text-gray-900 dark:text-white">
                    {link.human_clicks.toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    human clicks
                  </div>
                </div>

                {/* Link */}
                <a
                  href={`/admin/redirects/${link.id}/detail`}
                  className="flex-shrink-0 p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  title="View details"
                >
                  <ArrowTopRightOnSquareIcon className="size-5 text-gray-400" />
                </a>
              </div>
            );
          })}

          {filteredLinks.length === 0 && (
            <div className="px-6 py-12 text-center text-gray-500 dark:text-gray-400">
              <TrophyIcon className="size-12 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
              <p>No newsletter links found matching your filters.</p>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
