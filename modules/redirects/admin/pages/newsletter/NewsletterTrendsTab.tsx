import { useState, useEffect, useMemo, Fragment } from 'react';
import ReactApexChart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';
import {
  ChartBarIcon,
  CalendarIcon,
  EyeIcon,
  EyeSlashIcon,
  ChevronUpIcon,
  ArrowTopRightOnSquareIcon,
  PencilIcon,
  CheckIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import clsx from 'clsx';
import { Card, Badge, Button, Collapse, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { Spinner } from '@/components/ui/Spinner';
import { Flatpickr } from '@/components/shared/form/Flatpickr';
import { supabase } from '@/lib/supabase';
import { getShortLinkDomain } from '@/config/brands';

// Import flatpickr CSS
import 'flatpickr/dist/flatpickr.min.css';

interface EditionSummary {
  date: string;
  links: number;
  clicks: number;
  topType: string;
  topTypeClicks: number;
  byType: Record<string, number>;
}

interface ContentTypeSummary {
  content_type: string;
  total_clicks: number;
  human_clicks: number;
  link_count: number;
}

interface EditionLink {
  id: string;
  path: string;
  original_url: string;
  title: string | null;
  content_type: string | null;
  content_number: number | null;
  human_clicks: number;
  total_clicks: number;
}

const CONTENT_TYPE_COLORS: Record<string, string> = {
  podcast: '#8B5CF6',
  gem: '#F59E0B',
  blog: '#3B82F6',
  hot_take: '#EF4444',
  job: '#10B981',
  reading_group: '#6366F1',
  ad: '#EC4899',
  intro: '#06B6D4',
  rewind: '#F97316',
  shop: '#14B8A6',
};

// Available content types for the dropdown
const CONTENT_TYPES = [
  'podcast',
  'gem',
  'blog',
  'hot_take',
  'job',
  'reading_group',
  'ad',
  'intro',
  'rewind',
  'shop',
];

// Helper to format date as YYYY-MM-DD for input fields
const formatDateForInput = (date: Date): string => {
  return date.toISOString().split('T')[0];
};

// Helper to get date X weeks ago
const getDateWeeksAgo = (weeks: number): Date => {
  const date = new Date();
  date.setDate(date.getDate() - weeks * 7);
  return date;
};

export function NewsletterTrendsTab() {
  const [editions, setEditions] = useState<EditionSummary[]>([]);
  const [contentTypeSummaries, setContentTypeSummaries] = useState<ContentTypeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [weeks, setWeeks] = useState<number | null>(8);
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(new Set());
  const [visibleEditions, setVisibleEditions] = useState<Set<string>>(new Set());
  const [expandedEdition, setExpandedEdition] = useState<string | null>(null);
  const [editionLinks, setEditionLinks] = useState<EditionLink[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);

  // Edit state for individual links
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [editContentType, setEditContentType] = useState<string>('');
  const [editContentNumber, setEditContentNumber] = useState<string>('');
  const [savingLink, setSavingLink] = useState(false);

  const shortIoDomain = getShortLinkDomain();

  // Calculate effective date range based on weeks or custom dates
  const getDateRange = () => {
    if (customStartDate && customEndDate) {
      return { startDateStr: customStartDate, endDateStr: customEndDate };
    }
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - ((weeks || 8) * 7));
    return {
      startDateStr: startDate.toISOString().split('T')[0],
      endDateStr: endDate.toISOString().split('T')[0],
    };
  };

  useEffect(() => {
    loadData();
  }, [weeks, customStartDate, customEndDate]);

  const selectWeeks = (w: number) => {
    setWeeks(w);
    setCustomStartDate('');
    setCustomEndDate('');
  };

  const applyCustomDateRange = () => {
    if (customStartDate && customEndDate) {
      setWeeks(null); // Clear weeks selection when using custom dates
      loadData();
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const { startDateStr, endDateStr } = getDateRange();

      // First, load valid newsletter dates from the newsletters table
      const { data: newslettersData, error: newslettersError } = await supabase
        .from('newsletters')
        .select('date')
        .eq('published', true)
        .gte('date', startDateStr)
        .lte('date', endDateStr)
        .order('date', { ascending: false });

      if (newslettersError) throw newslettersError;

      // Create a set of valid newsletter dates for filtering
      const validNewsletterDates = new Set(
        (newslettersData || []).map(n => n.date)
      );

      // Get redirects with their metadata
      const { data: redirectsRaw, error: redirectError } = await supabase
        .from('redirects')
        .select('id, content_type, content_number, newsletter_date, human_clicks')
        .eq('domain', shortIoDomain)
        .eq('link_category', 'newsletter')
        .gte('newsletter_date', startDateStr)
        .lte('newsletter_date', endDateStr)
        .not('content_type', 'is', null);

      if (redirectError) throw redirectError;

      // Filter redirects to only include those with newsletter dates that exist in the newsletters table
      const redirects = (redirectsRaw || []).filter(
        r => r.newsletter_date && validNewsletterDates.has(r.newsletter_date)
      );

      // Calculate edition summaries
      const editionMap: Record<string, { links: number; clicks: number; byType: Record<string, number> }> = {};
      (redirects || []).forEach((r: { newsletter_date: string; human_clicks: number; content_type: string }) => {
        if (!r.newsletter_date) return;
        if (!editionMap[r.newsletter_date]) {
          editionMap[r.newsletter_date] = { links: 0, clicks: 0, byType: {} };
        }
        editionMap[r.newsletter_date].links++;
        editionMap[r.newsletter_date].clicks += r.human_clicks || 0;
        editionMap[r.newsletter_date].byType[r.content_type] = (editionMap[r.newsletter_date].byType[r.content_type] || 0) + (r.human_clicks || 0);
      });

      const editionSummaries: EditionSummary[] = Object.entries(editionMap)
        .map(([date, data]) => {
          const topEntry = Object.entries(data.byType).sort((a, b) => b[1] - a[1])[0];
          return {
            date,
            links: data.links,
            clicks: data.clicks,
            topType: topEntry?.[0] || '',
            topTypeClicks: topEntry?.[1] || 0,
            byType: data.byType,
          };
        })
        .sort((a, b) => a.date.localeCompare(b.date)); // Sort oldest to newest for chart

      setEditions(editionSummaries);

      // Calculate content type summaries from redirect totals (always available)
      const contentTypeMap: Record<string, { total_clicks: number; human_clicks: number; link_count: number }> = {};
      (redirects || []).forEach((r: { content_type: string; human_clicks: number }) => {
        if (!r.content_type) return;
        if (!contentTypeMap[r.content_type]) {
          contentTypeMap[r.content_type] = { total_clicks: 0, human_clicks: 0, link_count: 0 };
        }
        contentTypeMap[r.content_type].human_clicks += r.human_clicks || 0;
        contentTypeMap[r.content_type].total_clicks += r.human_clicks || 0; // Using human_clicks as primary metric
        contentTypeMap[r.content_type].link_count++;
      });

      const summaries: ContentTypeSummary[] = Object.entries(contentTypeMap)
        .map(([content_type, data]) => ({ content_type, ...data }))
        .sort((a, b) => b.human_clicks - a.human_clicks);

      setContentTypeSummaries(summaries);

      // Initialize visible types to all content types that have clicks
      const typesWithClicks = summaries.filter(s => s.human_clicks > 0).map(s => s.content_type);
      setVisibleTypes(new Set(typesWithClicks));

      // Initialize visible editions to only Thursday editions by default
      const thursdayDates = editionSummaries
        .filter(e => {
          const date = new Date(e.date + 'T00:00:00'); // Parse as local time
          return date.getDay() === 4; // 4 = Thursday
        })
        .map(e => e.date);
      setVisibleEditions(new Set(thursdayDates));
    } catch (error) {
      console.error('Error loading trends:', error);
      toast.error('Failed to load trend data');
    } finally {
      setLoading(false);
    }
  };

  // Filter editions to only visible ones
  const filteredEditions = useMemo(() => {
    return editions.filter(e => visibleEditions.has(e.date));
  }, [editions, visibleEditions]);

  const toggleType = (type: string) => {
    setVisibleTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const toggleEdition = (date: string) => {
    setVisibleEditions(prev => {
      const next = new Set(prev);
      if (next.has(date)) {
        next.delete(date);
      } else {
        next.add(date);
      }
      return next;
    });
  };

  const isThursday = (dateStr: string) => {
    const date = new Date(dateStr + 'T00:00:00'); // Parse as local time
    return date.getDay() === 4; // 4 = Thursday
  };

  const selectAllEditions = () => {
    setVisibleEditions(new Set(editions.map(e => e.date)));
  };

  const selectThursdaysOnly = () => {
    const thursdayDates = editions.filter(e => isThursday(e.date)).map(e => e.date);
    setVisibleEditions(new Set(thursdayDates));
  };

  const deselectAllEditions = () => {
    setVisibleEditions(new Set());
  };

  const toggleEditionExpand = async (editionDate: string) => {
    if (expandedEdition === editionDate) {
      // Collapse if already expanded
      setExpandedEdition(null);
      setEditionLinks([]);
      return;
    }

    // Expand and load links for this edition
    setExpandedEdition(editionDate);
    setLoadingLinks(true);

    try {
      const { data: links, error } = await supabase
        .from('redirects')
        .select('id, path, original_url, title, content_type, content_number, human_clicks, total_clicks')
        .eq('domain', shortIoDomain)
        .eq('link_category', 'newsletter')
        .eq('newsletter_date', editionDate)
        .order('human_clicks', { ascending: false });

      if (error) throw error;
      setEditionLinks(links || []);
    } catch (error) {
      console.error('Error loading edition links:', error);
      toast.error('Failed to load links for this edition');
      setEditionLinks([]);
    } finally {
      setLoadingLinks(false);
    }
  };

  const startEditingLink = (link: EditionLink) => {
    setEditingLinkId(link.id);
    setEditContentType(link.content_type || '');
    setEditContentNumber(link.content_number?.toString() || '');
  };

  const cancelEditingLink = () => {
    setEditingLinkId(null);
    setEditContentType('');
    setEditContentNumber('');
  };

  const saveLink = async (linkId: string) => {
    setSavingLink(true);
    try {
      const updateData: Record<string, any> = {
        content_type: editContentType || null,
        content_number: editContentNumber ? parseInt(editContentNumber, 10) : null,
      };

      const { error } = await supabase
        .from('redirects')
        .update(updateData)
        .eq('id', linkId);

      if (error) throw error;

      // Update local state
      setEditionLinks((prev) =>
        prev.map((link) =>
          link.id === linkId
            ? {
                ...link,
                content_type: updateData.content_type,
                content_number: updateData.content_number,
              }
            : link
        )
      );

      toast.success('Link updated successfully');
      cancelEditingLink();

      // Reload the main data to update summaries
      loadData();
    } catch (error) {
      console.error('Error saving link:', error);
      toast.error('Failed to save link');
    } finally {
      setSavingLink(false);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const formatFullDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
      {/* Time Range Selector */}
      <Card skin="bordered" className="p-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <CalendarIcon className="size-5 text-gray-500" />
            <span className="text-sm font-medium text-[var(--gray-11)]">Time Range:</span>
          </div>
          <div className="flex items-center gap-4">
            {/* Week preset buttons */}
            <div className="flex items-center gap-2">
              {[4, 8, 12, 24].map((w) => (
                <Button
                  key={w}
                  variant={weeks === w && !customStartDate ? 'soft' : 'ghost'}
                  onClick={() => selectWeeks(w)}
                >
                  {w} weeks
                </Button>
              ))}
            </div>

            {/* Separator */}
            <div className="h-8 w-px bg-gray-300 dark:bg-gray-600" />

            {/* Custom date range */}
            <div className="flex items-center gap-2">
              <Flatpickr
                defaultValue={customStartDate || ''}
                onChange={(dates) => {
                  if (dates && dates.length > 0) {
                    const d = dates[0];
                    const year = d.getFullYear();
                    const month = String(d.getMonth() + 1).padStart(2, '0');
                    const day = String(d.getDate()).padStart(2, '0');
                    setCustomStartDate(`${year}-${month}-${day}`);
                  } else {
                    setCustomStartDate('');
                  }
                }}
                options={{
                  dateFormat: 'M j, Y',
                  allowInput: true,
                }}
                placeholder="Start date"
                className={clsx(
                  'w-32 px-3 py-1.5 text-sm rounded-lg border cursor-pointer',
                  customStartDate && customEndDate
                    ? 'border-primary-300 dark:border-primary-700 bg-primary-50 dark:bg-primary-900/30'
                    : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800'
                )}
              />
              <span className="text-[var(--gray-11)] text-sm">to</span>
              <Flatpickr
                defaultValue={customEndDate || ''}
                onChange={(dates) => {
                  if (dates && dates.length > 0) {
                    const d = dates[0];
                    const year = d.getFullYear();
                    const month = String(d.getMonth() + 1).padStart(2, '0');
                    const day = String(d.getDate()).padStart(2, '0');
                    setCustomEndDate(`${year}-${month}-${day}`);
                  } else {
                    setCustomEndDate('');
                  }
                }}
                options={{
                  dateFormat: 'M j, Y',
                  allowInput: true,
                }}
                placeholder="End date"
                className={clsx(
                  'w-32 px-3 py-1.5 text-sm rounded-lg border cursor-pointer',
                  customStartDate && customEndDate
                    ? 'border-primary-300 dark:border-primary-700 bg-primary-50 dark:bg-primary-900/30'
                    : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800'
                )}
              />
              {customStartDate && customEndDate && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setCustomStartDate('');
                    setCustomEndDate('');
                    setWeeks(8);
                  }}
                  title="Clear custom dates"
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Edition Filter */}
      {editions.length > 0 && (
        <Card skin="bordered" className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <CalendarIcon className="size-5 text-gray-500" />
              <span className="text-sm font-medium text-[var(--gray-11)]">
                Filter Editions ({visibleEditions.size} of {editions.length} selected)
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={selectThursdaysOnly}>
                Thursdays Only
              </Button>
              <Button variant="ghost" onClick={selectAllEditions}>
                Select All
              </Button>
              <Button variant="ghost" onClick={deselectAllEditions}>
                Clear All
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {[...editions].reverse().map((edition) => {
              const isVisible = visibleEditions.has(edition.date);
              const thursday = isThursday(edition.date);
              return (
                <Button
                  key={edition.date}
                  variant={isVisible ? 'soft' : 'surface'}
                  onClick={() => toggleEdition(edition.date)}
                  title={thursday ? 'Thursday (newsletter day)' : undefined}
                >
                  <span className="text-sm font-medium">
                    {formatDate(edition.date)}
                  </span>
                  <span className="text-xs">
                    {edition.clicks.toLocaleString()}
                  </span>
                  {thursday && (
                    <span className="text-xs font-semibold">
                      Thu
                    </span>
                  )}
                  {isVisible ? (
                    <EyeIcon className="size-3.5" />
                  ) : (
                    <EyeSlashIcon className="size-3.5" />
                  )}
                </Button>
              );
            })}
          </div>
        </Card>
      )}

      {/* Content Type Summary (uses totals from redirects table) */}
      <Card variant="surface" className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[var(--gray-11)] flex items-center gap-2">
            <ChartBarIcon className="size-4" />
            Content Types by Human Clicks
          </h3>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setVisibleTypes(new Set(contentTypeSummaries.map(s => s.content_type)))}>
              Select All
            </Button>
            <Button variant="ghost" onClick={() => setVisibleTypes(new Set())}>
              Clear All
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {contentTypeSummaries.map((summary) => {
            const isVisible = visibleTypes.has(summary.content_type);
            const color = CONTENT_TYPE_COLORS[summary.content_type] || '#6B7280';

            return (
              <Button
                key={summary.content_type}
                variant={isVisible ? 'outline' : 'ghost'}
                onClick={() => toggleType(summary.content_type)}
              >
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: color }}
                />
                {summary.content_type.replace(/_/g, ' ')}
                <span className="text-xs">
                  ({summary.human_clicks.toLocaleString()} clicks, {summary.link_count} links)
                </span>
                {isVisible ? (
                  <EyeIcon className="size-4" />
                ) : (
                  <EyeSlashIcon className="size-4" />
                )}
              </Button>
            );
          })}
        </div>
      </Card>

      {/* Clicks by Edition Line Chart */}
      {filteredEditions.length > 0 ? (
        <Card variant="surface" className="p-6">
          <h3 className="text-lg font-semibold text-[var(--gray-12)] mb-4">
            Clicks by Newsletter Edition
          </h3>

          {(() => {
            // Build series data for each visible content type
            const chartSeries = Array.from(visibleTypes).map((contentType) => ({
              name: contentType.replace(/_/g, ' '),
              data: filteredEditions.map((edition) => edition.byType[contentType] || 0),
            }));

            const chartOptions: ApexOptions = {
              chart: {
                type: 'line',
                height: 320,
                toolbar: { show: true },
                zoom: { enabled: true },
              },
              colors: Array.from(visibleTypes).map(
                (type) => CONTENT_TYPE_COLORS[type] || '#6B7280'
              ),
              dataLabels: { enabled: false },
              stroke: {
                curve: 'smooth',
                width: 2.5,
              },
              markers: {
                size: 5,
                strokeWidth: 2,
                strokeColors: '#fff',
                hover: { size: 7 },
              },
              xaxis: {
                categories: filteredEditions.map((e) => e.date),
                labels: {
                  formatter: (value: string) => {
                    const date = new Date(value);
                    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                  },
                  rotate: -45,
                  rotateAlways: filteredEditions.length > 8,
                  style: { fontSize: '11px' },
                },
                tickAmount: Math.min(filteredEditions.length, 12),
              },
              yaxis: {
                title: { text: 'Clicks' },
                labels: {
                  formatter: (value: number) => value.toLocaleString(),
                },
              },
              tooltip: {
                shared: true,
                intersect: false,
                y: {
                  formatter: (value: number) => `${value.toLocaleString()} clicks`,
                },
              },
              legend: {
                show: true,
                position: 'top',
                horizontalAlign: 'left',
              },
              grid: {
                borderColor: '#e5e7eb',
                strokeDashArray: 4,
              },
            };

            return (
              <ReactApexChart
                options={chartOptions}
                series={chartSeries}
                type="line"
                height={320}
              />
            );
          })()}
        </Card>
      ) : (
        <Card skin="bordered" className="p-6">
          <div className="text-center">
            <ChartBarIcon className="size-12 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
            <h3 className="text-lg font-medium text-[var(--gray-12)] mb-2">
              No Edition Data Available
            </h3>
            <p className="text-[var(--gray-11)] mb-4">
              No newsletter editions found for the selected time range.
              Make sure links have been parsed with the "Re-parse" button on the Redirects page.
            </p>
          </div>
        </Card>
      )}

      {/* Edition Comparison */}
      <Card variant="surface" className="overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-[var(--gray-12)]">
            Edition Performance
          </h3>
          <p className="text-sm text-[var(--gray-11)] mt-1">
            Click on an edition to see individual link performance
          </p>
        </div>

        <div className="min-w-full overflow-x-auto">
          <Table className="w-full text-left rtl:text-right">
            <THead>
              <Tr>
                <Th className="w-12 bg-[var(--gray-a3)] font-semibold text-[var(--gray-11)] uppercase">
                  {/* Expand column */}
                </Th>
                <Th className="bg-[var(--gray-a3)] font-semibold text-[var(--gray-11)] uppercase">
                  Edition Date
                </Th>
                <Th className="bg-[var(--gray-a3)] font-semibold text-[var(--gray-11)] uppercase text-right">
                  Links
                </Th>
                <Th className="bg-[var(--gray-a3)] font-semibold text-[var(--gray-11)] uppercase text-right">
                  Total Clicks
                </Th>
                <Th className="bg-[var(--gray-a3)] font-semibold text-[var(--gray-11)] uppercase">
                  Top Performer
                </Th>
                <Th className="bg-[var(--gray-a3)] font-semibold text-[var(--gray-11)] uppercase text-right">
                  Avg/Link
                </Th>
              </Tr>
            </THead>
            <TBody>
              {[...filteredEditions].reverse().map((edition) => {
                // Calculate filtered stats based on visible content types
                const filteredByType = Object.entries(edition.byType)
                  .filter(([type]) => visibleTypes.has(type));
                const filteredClicks = filteredByType.reduce((sum, [, clicks]) => sum + clicks, 0);
                const filteredLinkCount = filteredByType.length;
                const avgPerLink = filteredLinkCount > 0 ? Math.round(filteredClicks / filteredLinkCount) : 0;

                // Find top performer among visible types only
                const topEntry = filteredByType.sort((a, b) => b[1] - a[1])[0];
                const topType = topEntry?.[0] || '';
                const topTypeClicks = topEntry?.[1] || 0;
                const color = CONTENT_TYPE_COLORS[topType] || '#6B7280';
                const isExpanded = expandedEdition === edition.date;

                return (
                  <Fragment key={edition.date}>
                    <Tr
                      onClick={() => toggleEditionExpand(edition.date)}
                      className={clsx(
                        'border-y border-transparent border-b-[var(--gray-a5)] cursor-pointer transition-colors',
                        'hover:bg-gray-50 dark:hover:bg-gray-800/50',
                        isExpanded && 'bg-gray-50 dark:bg-gray-800/30 border-dashed'
                      )}
                    >
                      <Td className="w-12">
                        <ChevronUpIcon
                          className={clsx(
                            'size-5 text-gray-400 transition-transform duration-200',
                            isExpanded ? 'rotate-180' : 'rotate-90'
                          )}
                        />
                      </Td>
                      <Td>
                        <span className="font-medium text-[var(--gray-12)]">
                          {formatFullDate(edition.date)}
                        </span>
                      </Td>
                      <Td className="text-right">
                        <Badge variant="soft" color="secondary">
                          {filteredLinkCount}
                        </Badge>
                      </Td>
                      <Td className="text-right">
                        <span className="text-lg font-semibold text-success-600 dark:text-success-400">
                          {filteredClicks.toLocaleString()}
                        </span>
                      </Td>
                      <Td>
                        {topType && (
                          <span
                            className="inline-flex items-center gap-2 px-2 py-1 rounded text-sm"
                            style={{ backgroundColor: `${color}20`, color }}
                          >
                            <span
                              className="w-2 h-2 rounded-full"
                              style={{ backgroundColor: color }}
                            />
                            {topType.replace(/_/g, ' ')}
                            <span className="text-xs opacity-75">
                              ({topTypeClicks.toLocaleString()})
                            </span>
                          </span>
                        )}
                      </Td>
                      <Td className="text-right text-[var(--gray-11)]">
                        {avgPerLink.toLocaleString()}
                      </Td>
                    </Tr>

                    {/* Expanded links section with Collapse animation */}
                    <tr className="hidden" aria-hidden="true" />
                    <tr>
                      <td colSpan={6} className="p-0">
                        <Collapse in={isExpanded}>
                          <div className="border-b border-b-[var(--gray-a5)] bg-gray-50/50 dark:bg-gray-800/30">
                            {loadingLinks ? (
                              <div className="flex items-center justify-center py-8">
                                <Spinner className="size-6" />
                                <span className="ml-2 text-sm text-[var(--gray-11)]">Loading links...</span>
                              </div>
                            ) : editionLinks.length === 0 ? (
                              <div className="py-8 text-center text-[var(--gray-11)]">
                                No links found for this edition
                              </div>
                            ) : (
                              <div className="px-4 py-3">
                                <Table hoverable className="w-full text-left rtl:text-right">
                                  <THead>
                                    <Tr>
                                      <Th className="w-12 bg-[var(--gray-a3)] font-semibold text-[var(--gray-11)] uppercase text-xs first:rounded-l-lg">
                                        #
                                      </Th>
                                      <Th className="w-36 bg-[var(--gray-a3)] font-semibold text-[var(--gray-11)] uppercase text-xs">
                                        Type
                                      </Th>
                                      <Th className="bg-[var(--gray-a3)] font-semibold text-[var(--gray-11)] uppercase text-xs">
                                        Link
                                      </Th>
                                      <Th className="w-24 bg-[var(--gray-a3)] font-semibold text-[var(--gray-11)] uppercase text-xs text-right">
                                        Clicks
                                      </Th>
                                      <Th className="w-20 bg-[var(--gray-a3)] font-semibold text-[var(--gray-11)] uppercase text-xs text-center last:rounded-r-lg">
                                        Edit
                                      </Th>
                                    </Tr>
                                  </THead>
                                  <TBody>
                                    {editionLinks
                                      .filter((link) => !link.content_type || visibleTypes.has(link.content_type))
                                      .map((link, linkIndex) => {
                                      const linkColor = CONTENT_TYPE_COLORS[link.content_type || ''] || '#6B7280';
                                      const isEditing = editingLinkId === link.id;

                                      return (
                                        <Tr
                                          key={link.id}
                                          className={clsx(
                                            'border-y border-transparent border-b-[var(--gray-a6)]',
                                            isEditing && 'bg-primary-50/50 dark:bg-primary-900/20'
                                          )}
                                        >
                                          <Td className="text-center">
                                            <span className="text-sm font-medium text-gray-400">
                                              {linkIndex + 1}
                                            </span>
                                          </Td>
                                          <Td>
                                            {isEditing ? (
                                              <div className="flex items-center gap-2">
                                                <select
                                                  value={editContentType}
                                                  onChange={(e) => setEditContentType(e.target.value)}
                                                  onClick={(e) => e.stopPropagation()}
                                                  className="block w-24 rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700 text-xs py-1 px-1.5"
                                                >
                                                  <option value="">None</option>
                                                  {CONTENT_TYPES.map((type) => (
                                                    <option key={type} value={type}>
                                                      {type.replace(/_/g, ' ')}
                                                    </option>
                                                  ))}
                                                </select>
                                                <input
                                                  type="number"
                                                  value={editContentNumber}
                                                  onChange={(e) => setEditContentNumber(e.target.value)}
                                                  onClick={(e) => e.stopPropagation()}
                                                  placeholder="#"
                                                  min="1"
                                                  className="block w-12 rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700 text-xs py-1 px-1.5 text-center"
                                                />
                                              </div>
                                            ) : link.content_type ? (
                                              <span
                                                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium"
                                                style={{ backgroundColor: `${linkColor}20`, color: linkColor }}
                                              >
                                                <span
                                                  className="w-1.5 h-1.5 rounded-full"
                                                  style={{ backgroundColor: linkColor }}
                                                />
                                                {link.content_type.replace(/_/g, ' ')}
                                                {link.content_number && (
                                                  <span className="opacity-75">#{link.content_number}</span>
                                                )}
                                              </span>
                                            ) : (
                                              <span className="text-gray-400 text-xs">—</span>
                                            )}
                                          </Td>
                                          <Td>
                                            <div className="flex items-center gap-2">
                                              <span className="font-mono text-sm font-medium text-primary-600 dark:text-primary-400">
                                                /{link.path}
                                              </span>
                                              <a
                                                href={link.original_url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                onClick={(e) => e.stopPropagation()}
                                                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                                              >
                                                <ArrowTopRightOnSquareIcon className="size-4" />
                                              </a>
                                            </div>
                                            {link.title && (
                                              <p className="text-xs text-[var(--gray-11)] truncate mt-0.5 max-w-md">
                                                {link.title}
                                              </p>
                                            )}
                                          </Td>
                                          <Td className="text-right">
                                            <span className="text-base font-semibold text-success-600 dark:text-success-400">
                                              {link.human_clicks.toLocaleString()}
                                            </span>
                                          </Td>
                                          <Td className="text-center">
                                            {isEditing ? (
                                              <div className="flex items-center justify-center gap-1">
                                                <Button
                                                  isIcon
                                                  variant="ghost"
                                                  color="green"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    saveLink(link.id);
                                                  }}
                                                  disabled={savingLink}
                                                  title="Save"
                                                >
                                                  {savingLink ? (
                                                    <Spinner className="size-4" />
                                                  ) : (
                                                    <CheckIcon className="size-4" />
                                                  )}
                                                </Button>
                                                <Button
                                                  isIcon
                                                  variant="ghost"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    cancelEditingLink();
                                                  }}
                                                  disabled={savingLink}
                                                  title="Cancel"
                                                >
                                                  <XMarkIcon className="size-4" />
                                                </Button>
                                              </div>
                                            ) : (
                                              <Button
                                                isIcon
                                                variant="ghost"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  startEditingLink(link);
                                                }}
                                                title="Edit category"
                                              >
                                                <PencilIcon className="size-4" />
                                              </Button>
                                            )}
                                          </Td>
                                        </Tr>
                                      );
                                    })}
                                  </TBody>
                                </Table>

                                <div className="pt-3 pb-1 text-end">
                                  <Button
                                    variant="ghost"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setExpandedEdition(null);
                                      setEditionLinks([]);
                                    }}
                                  >
                                    Close
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>
                        </Collapse>
                      </td>
                    </tr>
                  </Fragment>
                );
              })}

              {filteredEditions.length === 0 && (
                <Tr>
                  <Td colSpan={6} className="px-6 py-12 text-center text-[var(--gray-11)]">
                    {editions.length === 0
                      ? 'No edition data available for the selected time range.'
                      : 'No editions selected. Use the filter above to select editions to display.'}
                  </Td>
                </Tr>
              )}
            </TBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
