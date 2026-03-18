import { useState, useEffect } from 'react';
import {
  ExclamationTriangleIcon,
  CheckCircleIcon,
  ArrowPathIcon,
  MagnifyingGlassIcon,
  QuestionMarkCircleIcon,
  TagIcon,
  PlusIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Badge, Button, Modal } from '@/components/ui';
import { Input } from '@/components/ui/Form';
import { Spinner } from '@/components/ui/Spinner';
import { Flatpickr } from '@/components/shared/form/Flatpickr';
import { supabase } from '@/lib/supabase';
import { getShortLinkDomain } from '@/config/brands';

// Import flatpickr CSS
import 'flatpickr/dist/flatpickr.min.css';

interface RedirectNeedsReview {
  id: string;
  path: string;
  title: string | null;
  original_url: string;
  created_at: string;
  total_clicks: number;
  human_clicks: number;
  unknown_segments: string[] | null;
  link_category: string | null;
  content_type: string | null;
}

interface Shortcode {
  id: string;
  prefix: string;
  shortcode: string;
  field_type: string;
  full_value: string;
}

const FIELD_TYPES = [
  { value: 'content_type', label: 'Content Type' },
  { value: 'platform', label: 'Platform' },
  { value: 'region', label: 'Region' },
  { value: 'device_target', label: 'Device Target' },
  { value: 'distribution_channel', label: 'Distribution Channel' },
  { value: 'ad_type', label: 'Ad Type' },
];

const LINK_CATEGORIES = [
  { value: 'newsletter', label: 'Newsletter' },
  { value: 'event', label: 'Event' },
  { value: 'social', label: 'Social' },
  { value: 'website', label: 'Website' },
  { value: 'other', label: 'Other' },
];

const CONTENT_TYPES = [
  { value: 'podcast', label: 'Podcast' },
  { value: 'gem', label: 'Gem' },
  { value: 'blog', label: 'Blog' },
  { value: 'hot_take', label: 'Hot Take' },
  { value: 'job', label: 'Job' },
  { value: 'reading_group', label: 'Reading Group' },
  { value: 'ad', label: 'Ad' },
  { value: 'intro', label: 'Intro' },
  { value: 'rewind', label: 'Rewind' },
  { value: 'event', label: 'Event' },
  { value: 'sponsor', label: 'Sponsor' },
];

const PLATFORMS = [
  { value: 'spotify', label: 'Spotify' },
  { value: 'apple', label: 'Apple' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'web', label: 'Web' },
];

const AD_TYPES = [
  { value: 'primary', label: 'Primary' },
  { value: 'secondary', label: 'Secondary' },
  { value: 'banner', label: 'Banner' },
  { value: 'inline', label: 'Inline' },
];

const DEVICE_TARGETS = [
  { value: 'desktop', label: 'Desktop' },
  { value: 'mobile', label: 'Mobile' },
];

const REGIONS = [
  { value: 'us', label: 'US' },
  { value: 'row', label: 'Rest of World' },
];

export function NeedsReviewTab() {
  const [redirects, setRedirects] = useState<RedirectNeedsReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [reparsing, setReparsing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRedirect, setSelectedRedirect] = useState<RedirectNeedsReview | null>(null);
  const [showAddShortcodeModal, setShowAddShortcodeModal] = useState(false);
  const [selectedSegment, setSelectedSegment] = useState<string>('');
  const [shortcodeForm, setShortcodeForm] = useState({
    field_type: 'content_type',
    full_value: '',
    description: '',
  });
  const [showResolveModal, setShowResolveModal] = useState(false);
  const [resolveForm, setResolveForm] = useState({
    link_category: '',
    content_type: '',
    content_number: '',
    platform: '',
    ad_type: '',
    device_target: '',
    region: '',
    newsletter_date: '',
  });
  const [saving, setSaving] = useState(false);

  const shortIoDomain = getShortLinkDomain();

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      if (!supabase) {
        throw new Error('Supabase client not initialized');
      }

      // Paginate to get all records (Supabase default limit is 1000)
      let allRedirects: RedirectNeedsReview[] = [];
      let offset = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from('redirects')
          .select('id, path, title, original_url, created_at, total_clicks, human_clicks, unknown_segments, link_category, content_type')
          .eq('domain', shortIoDomain)
          .eq('needs_review', true)
          .order('human_clicks', { ascending: false })
          .range(offset, offset + pageSize - 1);

        if (error) {
          console.error('Supabase error:', error.message, error.details, error.hint);
          throw error;
        }

        if (data && data.length > 0) {
          allRedirects = allRedirects.concat(data);
          offset += pageSize;
          hasMore = data.length === pageSize;
        } else {
          hasMore = false;
        }
      }

      setRedirects(allRedirects);
    } catch (error: any) {
      console.error('Error loading redirects:', error?.message || error);
      toast.error(`Failed to load redirects: ${error?.message || 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleReparse = async () => {
    setReparsing(true);
    try {
      // Get the API URL based on environment
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';

      const response = await fetch(`${apiUrl}/api/redirects/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: shortIoDomain, forceReparse: true }),
      });

      if (!response.ok) {
        throw new Error('Failed to trigger reparse');
      }

      const result = await response.json();
      toast.success(`Reparsed ${result.stats?.parsed || 0} redirects`);
      loadData();
    } catch (error) {
      console.error('Error reparsing:', error);
      toast.error('Failed to reparse redirects');
    } finally {
      setReparsing(false);
    }
  };

  const openResolveModal = (redirect: RedirectNeedsReview) => {
    setSelectedRedirect(redirect);
    setResolveForm({
      link_category: redirect.link_category || '',
      content_type: redirect.content_type || '',
      content_number: '',
      platform: '',
      ad_type: '',
      device_target: '',
      region: '',
      newsletter_date: '',
    });
    setShowResolveModal(true);
  };

  const handleResolve = async () => {
    if (!selectedRedirect) return;

    setSaving(true);
    try {
      // Build update object with only non-empty values
      const updateData: Record<string, any> = {
        needs_review: false,
        unknown_segments: [],
      };

      if (resolveForm.link_category) updateData.link_category = resolveForm.link_category;
      if (resolveForm.content_type) updateData.content_type = resolveForm.content_type;
      if (resolveForm.content_number) updateData.content_number = parseInt(resolveForm.content_number, 10);
      if (resolveForm.platform) updateData.platform = resolveForm.platform;
      if (resolveForm.ad_type) updateData.ad_type = resolveForm.ad_type;
      if (resolveForm.device_target) updateData.device_target = resolveForm.device_target;
      if (resolveForm.region) updateData.region = resolveForm.region;
      if (resolveForm.newsletter_date) updateData.newsletter_date = resolveForm.newsletter_date;

      const { error } = await supabase
        .from('redirects')
        .update(updateData)
        .eq('id', selectedRedirect.id);

      if (error) throw error;
      toast.success('Redirect resolved and categorized');
      setShowResolveModal(false);
      setSelectedRedirect(null);
      loadData();
    } catch (error) {
      console.error('Error resolving:', error);
      toast.error('Failed to resolve redirect');
    } finally {
      setSaving(false);
    }
  };

  const handleQuickResolve = async (redirect: RedirectNeedsReview) => {
    // Quick resolve without opening modal - just mark as resolved
    try {
      const { error } = await supabase
        .from('redirects')
        .update({ needs_review: false, unknown_segments: [] })
        .eq('id', redirect.id);

      if (error) throw error;
      toast.success('Marked as resolved');
      loadData();
    } catch (error) {
      console.error('Error resolving:', error);
      toast.error('Failed to mark as resolved');
    }
  };

  const handleAddShortcode = async () => {
    if (!selectedRedirect || !selectedSegment) return;

    try {
      // Determine prefix from the redirect path
      const prefix = selectedRedirect.path.match(/^([A-Z]+_)/)?.[1] || 'NL_';

      const { error } = await supabase.from('redirects_shortcodes').insert({
        prefix,
        shortcode: selectedSegment,
        field_type: shortcodeForm.field_type,
        full_value: shortcodeForm.full_value,
        description: shortcodeForm.description || null,
      });

      if (error) throw error;

      toast.success(`Added shortcode: ${selectedSegment} → ${shortcodeForm.full_value}`);
      setShowAddShortcodeModal(false);
      setSelectedSegment('');
      setShortcodeForm({ field_type: 'content_type', full_value: '', description: '' });

      // Trigger reparse for this specific redirect
      handleReparse();
    } catch (error) {
      console.error('Error adding shortcode:', error);
      toast.error('Failed to add shortcode');
    }
  };

  const openAddShortcodeModal = (redirect: RedirectNeedsReview, segment: string) => {
    setSelectedRedirect(redirect);
    setSelectedSegment(segment);
    setShortcodeForm({
      field_type: 'content_type',
      full_value: segment.toLowerCase(),
      description: '',
    });
    setShowAddShortcodeModal(true);
  };

  const filteredRedirects = redirects.filter((r) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const segments = r.unknown_segments || [];
    return (
      r.path.toLowerCase().includes(q) ||
      segments.some((s) => s.toLowerCase().includes(q)) ||
      (r.title?.toLowerCase().includes(q) ?? false)
    );
  });

  // Group by unknown segments for quick patterns
  const segmentCounts: Record<string, number> = {};
  redirects.forEach((r) => {
    const segments = r.unknown_segments || [];
    segments.forEach((seg) => {
      segmentCounts[seg] = (segmentCounts[seg] || 0) + 1;
    });
  });
  const topUnknownSegments = Object.entries(segmentCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="size-10" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-warning-100 dark:bg-warning-900/30 rounded-xl">
            <ExclamationTriangleIcon className="size-8 text-warning-600 dark:text-warning-400" />
          </div>
          <div>
            <h3 className="text-2xl font-bold text-gray-900 dark:text-white">{redirects.length}</h3>
            <p className="text-gray-600 dark:text-gray-400">redirects need review</p>
          </div>
        </div>

        <Button
          variant="outlined"
          color="primary"
          className="gap-2"
          onClick={handleReparse}
          disabled={reparsing}
        >
          <ArrowPathIcon className={`size-4 ${reparsing ? 'animate-spin' : ''}`} />
          {reparsing ? 'Reparsing...' : 'Reparse All'}
        </Button>
      </div>

      {/* Top Unknown Segments */}
      {topUnknownSegments.length > 0 && (
        <Card skin="bordered" className="p-4">
          <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
            <QuestionMarkCircleIcon className="size-4" />
            Most Common Unknown Segments
          </h4>
          <div className="flex flex-wrap gap-2">
            {topUnknownSegments.map(([segment, count]) => (
              <Button
                key={segment}
                variant="soft"
                color="orange"
                onClick={() => setSearchQuery(segment)}
              >
                <span className="font-mono font-medium">
                  {segment}
                </span>
                <Badge color="warning" variant="soft">
                  {count}
                </Badge>
              </Button>
            ))}
          </div>
        </Card>
      )}

      {/* Search */}
      <Card skin="bordered" className="p-4">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search paths or unknown segments..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
          {searchQuery && (
            <Button
              isIcon
              variant="ghost"
              onClick={() => setSearchQuery('')}
              style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)' }}
            >
              <XMarkIcon className="size-4" />
            </Button>
          )}
        </div>
      </Card>

      {/* Redirect List */}
      <Card variant="surface" className="overflow-hidden">
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {filteredRedirects.length === 0 ? (
            <div className="px-6 py-12 text-center">
              {redirects.length === 0 ? (
                <>
                  <CheckCircleIcon className="size-16 mx-auto mb-4 text-success-500" />
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">All Clear!</h3>
                  <p className="text-gray-600 dark:text-gray-400">
                    No redirects need review. All paths have been successfully parsed.
                  </p>
                </>
              ) : (
                <>
                  <MagnifyingGlassIcon className="size-12 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
                  <p className="text-gray-500 dark:text-gray-400">No redirects match your search.</p>
                </>
              )}
            </div>
          ) : (
            filteredRedirects.map((redirect) => (
              <div
                key={redirect.id}
                className="px-6 py-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    {/* Path */}
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-mono text-sm font-medium text-primary-600 dark:text-primary-400">
                        /{redirect.path}
                      </span>
                      {redirect.link_category && (
                        <Badge color="info" variant="soft" className="text-xs">
                          {redirect.link_category}
                        </Badge>
                      )}
                    </div>

                    {/* Title */}
                    {redirect.title && (
                      <p className="text-sm text-gray-600 dark:text-gray-400 mb-2 truncate">{redirect.title}</p>
                    )}

                    {/* Unknown Segments */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-gray-500">Unknown segments:</span>
                      {(redirect.unknown_segments || []).map((segment, i) => (
                        <Button
                          key={i}
                          variant="soft"
                          color="orange"
                          onClick={() => openAddShortcodeModal(redirect, segment)}
                        >
                          <span className="font-mono text-xs">{segment}</span>
                          <PlusIcon className="size-3" />
                        </Button>
                      ))}
                    </div>

                    {/* Original URL (truncated) */}
                    <p className="text-xs text-gray-400 mt-2 truncate">{redirect.original_url}</p>
                  </div>

                  {/* Stats & Actions */}
                  <div className="flex-shrink-0 flex flex-col items-end gap-2">
                    <div className="text-right">
                      <div className="text-lg font-bold text-gray-900 dark:text-white">
                        {redirect.human_clicks.toLocaleString()}
                      </div>
                      <div className="text-xs text-gray-500">clicks</div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="soft"
                        color="primary"
                        className="gap-1.5 text-xs"
                        onClick={() => openResolveModal(redirect)}
                      >
                        <TagIcon className="size-4" />
                        Categorize
                      </Button>
                      <Button
                        variant="soft"
                        color="success"
                        className="gap-1.5 text-xs"
                        onClick={() => handleQuickResolve(redirect)}
                        title="Mark as resolved without categorizing"
                      >
                        <CheckCircleIcon className="size-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      {/* Add Shortcode Modal */}
      <Modal
        isOpen={showAddShortcodeModal}
        onClose={() => {
          setShowAddShortcodeModal(false);
          setSelectedSegment('');
        }}
        title="Add New Shortcode"
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="outlined" onClick={() => setShowAddShortcodeModal(false)}>
              Cancel
            </Button>
            <Button
              variant="filled"
              color="primary"
              onClick={handleAddShortcode}
              disabled={!shortcodeForm.full_value}
            >
              Add & Reparse
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Creating shortcode for:</p>
            <p className="font-mono text-lg font-bold text-primary-600 dark:text-primary-400">{selectedSegment}</p>
            {selectedRedirect && (
              <p className="text-xs text-gray-500 mt-2">From: /{selectedRedirect.path}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Field Type</label>
            <select
              value={shortcodeForm.field_type}
              onChange={(e) => setShortcodeForm({ ...shortcodeForm, field_type: e.target.value })}
              className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500"
            >
              {FIELD_TYPES.map((ft) => (
                <option key={ft.value} value={ft.value}>
                  {ft.label}
                </option>
              ))}
            </select>
          </div>

          <Input
            label="Full Value"
            placeholder="e.g., podcast, spotify, etc."
            value={shortcodeForm.full_value}
            onChange={(e) => setShortcodeForm({ ...shortcodeForm, full_value: e.target.value })}
            description="The expanded value this shortcode represents"
          />

          <Input
            label="Description (optional)"
            placeholder="e.g., Podcast episode link"
            value={shortcodeForm.description}
            onChange={(e) => setShortcodeForm({ ...shortcodeForm, description: e.target.value })}
          />
        </div>
      </Modal>

      {/* Resolve/Categorize Modal */}
      <Modal
        isOpen={showResolveModal}
        onClose={() => {
          setShowResolveModal(false);
          setSelectedRedirect(null);
        }}
        title="Categorize & Resolve"
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="outlined" onClick={() => setShowResolveModal(false)}>
              Cancel
            </Button>
            <Button
              variant="filled"
              color="success"
              onClick={handleResolve}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save & Resolve'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          {/* Redirect Info */}
          <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <p className="font-mono text-sm font-medium text-primary-600 dark:text-primary-400 mb-1">
              /{selectedRedirect?.path}
            </p>
            {selectedRedirect?.title && (
              <p className="text-sm text-gray-600 dark:text-gray-400 truncate">{selectedRedirect.title}</p>
            )}
            {selectedRedirect?.unknown_segments && selectedRedirect.unknown_segments.length > 0 && (
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <span className="text-xs text-gray-500">Unknown:</span>
                {selectedRedirect.unknown_segments.map((seg, i) => (
                  <span key={i} className="px-2 py-0.5 bg-warning-100 dark:bg-warning-900/30 text-warning-700 dark:text-warning-300 rounded text-xs font-mono">
                    {seg}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Link Category */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Link Category
            </label>
            <select
              value={resolveForm.link_category}
              onChange={(e) => setResolveForm({ ...resolveForm, link_category: e.target.value })}
              className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500"
            >
              <option value="">-- Select Category --</option>
              {LINK_CATEGORIES.map((cat) => (
                <option key={cat.value} value={cat.value}>
                  {cat.label}
                </option>
              ))}
            </select>
          </div>

          {/* Content Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Content Type
            </label>
            <select
              value={resolveForm.content_type}
              onChange={(e) => setResolveForm({ ...resolveForm, content_type: e.target.value })}
              className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500"
            >
              <option value="">-- Select Content Type --</option>
              {CONTENT_TYPES.map((ct) => (
                <option key={ct.value} value={ct.value}>
                  {ct.label}
                </option>
              ))}
            </select>
          </div>

          {/* Content Number (e.g., Gem 2, Hot Take 3) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Content Number (optional)
            </label>
            <input
              type="number"
              min="1"
              max="99"
              placeholder="e.g., 1, 2, 3..."
              value={resolveForm.content_number}
              onChange={(e) => setResolveForm({ ...resolveForm, content_number: e.target.value })}
              className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500"
            />
            <p className="text-xs text-gray-500 mt-1">For Gem 2, Hot Take 3, etc.</p>
          </div>

          {/* Platform */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Platform (optional)
            </label>
            <select
              value={resolveForm.platform}
              onChange={(e) => setResolveForm({ ...resolveForm, platform: e.target.value })}
              className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500"
            >
              <option value="">-- Select Platform --</option>
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {/* Device Target */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Device Target (optional)
            </label>
            <select
              value={resolveForm.device_target}
              onChange={(e) => setResolveForm({ ...resolveForm, device_target: e.target.value })}
              className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500"
            >
              <option value="">-- Select Device --</option>
              {DEVICE_TARGETS.map((dt) => (
                <option key={dt.value} value={dt.value}>
                  {dt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Region */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Region (optional)
            </label>
            <select
              value={resolveForm.region}
              onChange={(e) => setResolveForm({ ...resolveForm, region: e.target.value })}
              className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500"
            >
              <option value="">-- Select Region --</option>
              {REGIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          {/* Ad Type - show only when content_type is 'ad' */}
          {resolveForm.content_type === 'ad' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Ad Type
              </label>
              <select
                value={resolveForm.ad_type}
                onChange={(e) => setResolveForm({ ...resolveForm, ad_type: e.target.value })}
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500"
              >
                <option value="">-- Select Ad Type --</option>
                {AD_TYPES.map((at) => (
                  <option key={at.value} value={at.value}>
                    {at.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Newsletter Date - show only when link_category is 'newsletter' */}
          {resolveForm.link_category === 'newsletter' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Newsletter Date
              </label>
              <Flatpickr
                defaultValue={resolveForm.newsletter_date || ''}
                onChange={(dates) => {
                  if (dates && dates.length > 0) {
                    const d = dates[0];
                    const year = d.getFullYear();
                    const month = String(d.getMonth() + 1).padStart(2, '0');
                    const day = String(d.getDate()).padStart(2, '0');
                    setResolveForm({ ...resolveForm, newsletter_date: `${year}-${month}-${day}` });
                  } else {
                    setResolveForm({ ...resolveForm, newsletter_date: '' });
                  }
                }}
                options={{
                  dateFormat: 'Y-m-d',
                  allowInput: true,
                }}
                placeholder="Select date"
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 cursor-pointer"
              />
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

// Standalone page wrapper for routing
import { Page } from '@/components/shared/Page';

export function NeedsReviewPage() {
  return (
    <Page title="Redirects Needing Review">
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
            Redirects Needing Review
          </h1>
          <p className="text-[var(--gray-11)] mt-1">
            Review and categorize redirects with unknown shortcodes or missing metadata
          </p>
        </div>
        <NeedsReviewTab />
      </div>
    </Page>
  );
}
