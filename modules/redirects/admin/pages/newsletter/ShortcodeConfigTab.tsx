import { useState, useEffect } from 'react';
import {
  Cog6ToothIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  CheckIcon,
  XMarkIcon,
  TagIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Badge, Button, Modal } from '@/components/ui';
import { Input, Select } from '@/components/ui/Form';
import { Spinner } from '@/components/ui/Spinner';
import { supabase } from '@/lib/supabase';

interface Prefix {
  id: string;
  prefix: string;
  category: string;
  description: string | null;
  is_active: boolean;
}

interface Shortcode {
  id: string;
  prefix: string;
  shortcode: string;
  field_type: string;
  full_value: string;
  description: string | null;
}

const FIELD_TYPES = [
  { value: 'content_type', label: 'Content Type' },
  { value: 'platform', label: 'Platform' },
  { value: 'region', label: 'Region' },
  { value: 'device_target', label: 'Device Target' },
  { value: 'distribution_channel', label: 'Distribution Channel' },
  { value: 'ad_type', label: 'Ad Type' },
];

const FIELD_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  content_type: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-300' },
  platform: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-300' },
  region: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-300' },
  device_target: { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-300' },
  distribution_channel: { bg: 'bg-pink-100 dark:bg-pink-900/30', text: 'text-pink-700 dark:text-pink-300' },
  ad_type: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300' },
};

export function ShortcodeConfigTab() {
  const [prefixes, setPrefixes] = useState<Prefix[]>([]);
  const [shortcodes, setShortcodes] = useState<Shortcode[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPrefix, setSelectedPrefix] = useState<string>('all');
  const [selectedFieldType, setSelectedFieldType] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Modal states
  const [showPrefixModal, setShowPrefixModal] = useState(false);
  const [showShortcodeModal, setShowShortcodeModal] = useState(false);
  const [editingPrefix, setEditingPrefix] = useState<Prefix | null>(null);
  const [editingShortcode, setEditingShortcode] = useState<Shortcode | null>(null);

  // Form states
  const [prefixForm, setPrefixForm] = useState({ prefix: '', category: '', description: '' });
  const [shortcodeForm, setShortcodeForm] = useState({
    prefix: '',
    shortcode: '',
    field_type: 'content_type',
    full_value: '',
    description: '',
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [prefixRes, shortcodeRes] = await Promise.all([
        supabase.from('redirects_prefixes').select('*').order('prefix'),
        supabase.from('redirects_shortcodes').select('*').order('prefix, shortcode'),
      ]);

      if (prefixRes.error) throw prefixRes.error;
      if (shortcodeRes.error) throw shortcodeRes.error;

      setPrefixes(prefixRes.data || []);
      setShortcodes(shortcodeRes.data || []);

      // Set default selected prefix
      if (prefixRes.data && prefixRes.data.length > 0 && selectedPrefix === 'all') {
        setSelectedPrefix(prefixRes.data[0].prefix);
      }
    } catch (error) {
      console.error('Error loading config:', error);
      toast.error('Failed to load configuration');
    } finally {
      setLoading(false);
    }
  };

  // Filter shortcodes
  const filteredShortcodes = shortcodes.filter((sc) => {
    if (selectedPrefix !== 'all' && sc.prefix !== selectedPrefix) return false;
    if (selectedFieldType !== 'all' && sc.field_type !== selectedFieldType) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        sc.shortcode.toLowerCase().includes(q) ||
        sc.full_value.toLowerCase().includes(q) ||
        (sc.description?.toLowerCase().includes(q) ?? false)
      );
    }
    return true;
  });

  // Group shortcodes by field type
  const groupedShortcodes = filteredShortcodes.reduce(
    (acc, sc) => {
      if (!acc[sc.field_type]) acc[sc.field_type] = [];
      acc[sc.field_type].push(sc);
      return acc;
    },
    {} as Record<string, Shortcode[]>
  );

  // Prefix handlers
  const handleSavePrefix = async () => {
    try {
      if (editingPrefix) {
        const { error } = await supabase
          .from('redirects_prefixes')
          .update({
            prefix: prefixForm.prefix,
            category: prefixForm.category,
            description: prefixForm.description || null,
          })
          .eq('id', editingPrefix.id);

        if (error) throw error;
        toast.success('Prefix updated');
      } else {
        const { error } = await supabase.from('redirects_prefixes').insert({
          prefix: prefixForm.prefix,
          category: prefixForm.category,
          description: prefixForm.description || null,
          is_active: true,
        });

        if (error) throw error;
        toast.success('Prefix created');
      }

      setShowPrefixModal(false);
      setEditingPrefix(null);
      setPrefixForm({ prefix: '', category: '', description: '' });
      loadData();
    } catch (error) {
      console.error('Error saving prefix:', error);
      toast.error('Failed to save prefix');
    }
  };

  const handleDeletePrefix = async (prefix: Prefix) => {
    if (!confirm(`Delete prefix "${prefix.prefix}"? This will not delete associated shortcodes.`)) return;

    try {
      const { error } = await supabase.from('redirects_prefixes').delete().eq('id', prefix.id);

      if (error) throw error;
      toast.success('Prefix deleted');
      loadData();
    } catch (error) {
      console.error('Error deleting prefix:', error);
      toast.error('Failed to delete prefix');
    }
  };

  // Shortcode handlers
  const handleSaveShortcode = async () => {
    try {
      if (editingShortcode) {
        const { error } = await supabase
          .from('redirects_shortcodes')
          .update({
            prefix: shortcodeForm.prefix,
            shortcode: shortcodeForm.shortcode,
            field_type: shortcodeForm.field_type,
            full_value: shortcodeForm.full_value,
            description: shortcodeForm.description || null,
          })
          .eq('id', editingShortcode.id);

        if (error) throw error;
        toast.success('Shortcode updated');
      } else {
        const { error } = await supabase.from('redirects_shortcodes').insert({
          prefix: shortcodeForm.prefix,
          shortcode: shortcodeForm.shortcode,
          field_type: shortcodeForm.field_type,
          full_value: shortcodeForm.full_value,
          description: shortcodeForm.description || null,
        });

        if (error) throw error;
        toast.success('Shortcode created');
      }

      setShowShortcodeModal(false);
      setEditingShortcode(null);
      setShortcodeForm({
        prefix: selectedPrefix !== 'all' ? selectedPrefix : '',
        shortcode: '',
        field_type: 'content_type',
        full_value: '',
        description: '',
      });
      loadData();
    } catch (error) {
      console.error('Error saving shortcode:', error);
      toast.error('Failed to save shortcode');
    }
  };

  const handleDeleteShortcode = async (shortcode: Shortcode) => {
    if (!confirm(`Delete shortcode "${shortcode.shortcode}"?`)) return;

    try {
      const { error } = await supabase.from('redirects_shortcodes').delete().eq('id', shortcode.id);

      if (error) throw error;
      toast.success('Shortcode deleted');
      loadData();
    } catch (error) {
      console.error('Error deleting shortcode:', error);
      toast.error('Failed to delete shortcode');
    }
  };

  const openEditPrefix = (prefix: Prefix) => {
    setEditingPrefix(prefix);
    setPrefixForm({
      prefix: prefix.prefix,
      category: prefix.category,
      description: prefix.description || '',
    });
    setShowPrefixModal(true);
  };

  const openEditShortcode = (shortcode: Shortcode) => {
    setEditingShortcode(shortcode);
    setShortcodeForm({
      prefix: shortcode.prefix,
      shortcode: shortcode.shortcode,
      field_type: shortcode.field_type,
      full_value: shortcode.full_value,
      description: shortcode.description || '',
    });
    setShowShortcodeModal(true);
  };

  const openNewShortcode = () => {
    setEditingShortcode(null);
    setShortcodeForm({
      prefix: selectedPrefix !== 'all' ? selectedPrefix : prefixes[0]?.prefix || '',
      shortcode: '',
      field_type: 'content_type',
      full_value: '',
      description: '',
    });
    setShowShortcodeModal(true);
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
      {/* Prefixes Section */}
      <Card variant="surface" className="overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-gray-50 to-white dark:from-gray-800/50 dark:to-gray-900 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary-100 dark:bg-primary-900/50 rounded-lg">
              <Cog6ToothIcon className="size-5 text-primary-600 dark:text-primary-400" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Link Prefixes</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Define prefixes that identify link categories (e.g., NL_ for newsletter)
              </p>
            </div>
          </div>
          <Button
            variant="filled"
            color="primary"
            className="gap-2"
            onClick={() => {
              setEditingPrefix(null);
              setPrefixForm({ prefix: '', category: '', description: '' });
              setShowPrefixModal(true);
            }}
          >
            <PlusIcon className="size-4" />
            Add Prefix
          </Button>
        </div>

        <div className="p-6">
          {prefixes.length === 0 ? (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              <Cog6ToothIcon className="size-12 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
              <p>No prefixes configured yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {prefixes.map((prefix) => (
                <div
                  key={prefix.id}
                  className={`relative p-4 rounded-xl border-2 transition-all ${
                    prefix.is_active
                      ? 'border-primary-200 dark:border-primary-800 bg-primary-50/50 dark:bg-primary-900/20'
                      : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 opacity-60'
                  }`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <span className="font-mono text-xl font-bold text-gray-900 dark:text-white">
                        {prefix.prefix}
                      </span>
                      <Badge
                        color={prefix.is_active ? 'success' : 'secondary'}
                        variant="soft"
                        className="ml-2 text-xs"
                      >
                        {prefix.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                    </div>
                    <div className="flex gap-1">
                      <Button isIcon variant="ghost" onClick={() => openEditPrefix(prefix)}>
                        <PencilIcon className="size-4" />
                      </Button>
                      <Button isIcon variant="ghost" color="red" onClick={() => handleDeletePrefix(prefix)}>
                        <TrashIcon className="size-4" />
                      </Button>
                    </div>
                  </div>
                  <Badge color="info" variant="outlined" className="mb-2">
                    {prefix.category}
                  </Badge>
                  {prefix.description && (
                    <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">{prefix.description}</p>
                  )}
                  <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                    <span className="text-xs text-gray-500">
                      {shortcodes.filter((s) => s.prefix === prefix.prefix).length} shortcodes
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Shortcodes Section */}
      <Card variant="surface" className="overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-gray-50 to-white dark:from-gray-800/50 dark:to-gray-900">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-info-100 dark:bg-info-900/50 rounded-lg">
                <TagIcon className="size-5 text-info-600 dark:text-info-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Shortcode Dictionary</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Map short codes to their full values (e.g., Pod → podcast)
                </p>
              </div>
            </div>
            <Button variant="filled" color="primary" className="gap-2" onClick={openNewShortcode}>
              <PlusIcon className="size-4" />
              Add Shortcode
            </Button>
          </div>

          {/* Filters */}
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex flex-wrap items-center gap-4">
            <div className="flex-1 min-w-[200px]">
              <Input
                placeholder="Search shortcodes..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                classNames={{ root: 'w-full' }}
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                value={selectedPrefix}
                onChange={(e) => setSelectedPrefix(e.target.value)}
                className="px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-primary-500"
              >
                <option value="all">All Prefixes</option>
                {prefixes.map((p) => (
                  <option key={p.prefix} value={p.prefix}>
                    {p.prefix}
                  </option>
                ))}
              </select>
              <select
                value={selectedFieldType}
                onChange={(e) => setSelectedFieldType(e.target.value)}
                className="px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-primary-500"
              >
                <option value="all">All Types</option>
                {FIELD_TYPES.map((ft) => (
                  <option key={ft.value} value={ft.value}>
                    {ft.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="p-6">
          {Object.keys(groupedShortcodes).length === 0 ? (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              <TagIcon className="size-12 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
              <p>No shortcodes found matching your filters.</p>
            </div>
          ) : (
            <div className="space-y-6">
              {Object.entries(groupedShortcodes).map(([fieldType, codes]) => {
                const colors = FIELD_TYPE_COLORS[fieldType] || {
                  bg: 'bg-gray-100 dark:bg-gray-800',
                  text: 'text-gray-700 dark:text-gray-300',
                };
                const label = FIELD_TYPES.find((ft) => ft.value === fieldType)?.label || fieldType;

                return (
                  <div key={fieldType}>
                    <div className="flex items-center gap-2 mb-3">
                      <span className={`px-3 py-1 rounded-full text-sm font-medium ${colors.bg} ${colors.text}`}>
                        {label}
                      </span>
                      <span className="text-sm text-gray-500 dark:text-gray-400">{codes.length} codes</span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                      {codes.map((sc) => (
                        <div
                          key={sc.id}
                          className="group relative p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-primary-300 dark:hover:border-primary-700 hover:shadow-md transition-all"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-primary-600 dark:text-primary-400">
                                {sc.shortcode}
                              </span>
                              <span className="text-gray-400">→</span>
                              <span className="text-gray-700 dark:text-gray-300">{sc.full_value}</span>
                            </div>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button isIcon variant="ghost" onClick={() => openEditShortcode(sc)}>
                                <PencilIcon className="size-3.5" />
                              </Button>
                              <Button isIcon variant="ghost" color="red" onClick={() => handleDeleteShortcode(sc)}>
                                <TrashIcon className="size-3.5" />
                              </Button>
                            </div>
                          </div>
                          {sc.description && (
                            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{sc.description}</p>
                          )}
                          <div className="mt-2">
                            <span className="text-xs font-mono text-gray-400">{sc.prefix}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      {/* Prefix Modal */}
      <Modal
        isOpen={showPrefixModal}
        onClose={() => {
          setShowPrefixModal(false);
          setEditingPrefix(null);
        }}
        title={editingPrefix ? 'Edit Prefix' : 'Add Prefix'}
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="outlined" onClick={() => setShowPrefixModal(false)}>
              Cancel
            </Button>
            <Button variant="filled" color="primary" onClick={handleSavePrefix}>
              {editingPrefix ? 'Save Changes' : 'Create Prefix'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Input
            label="Prefix"
            placeholder="e.g., NL_"
            value={prefixForm.prefix}
            onChange={(e) => setPrefixForm({ ...prefixForm, prefix: e.target.value })}
            description="The prefix that identifies links in this category (include trailing underscore if needed)"
          />
          <Input
            label="Category"
            placeholder="e.g., newsletter"
            value={prefixForm.category}
            onChange={(e) => setPrefixForm({ ...prefixForm, category: e.target.value })}
            description="The category name for this prefix"
          />
          <Input
            label="Description"
            placeholder="e.g., Weekly newsletter links"
            value={prefixForm.description}
            onChange={(e) => setPrefixForm({ ...prefixForm, description: e.target.value })}
          />
        </div>
      </Modal>

      {/* Shortcode Modal */}
      <Modal
        isOpen={showShortcodeModal}
        onClose={() => {
          setShowShortcodeModal(false);
          setEditingShortcode(null);
        }}
        title={editingShortcode ? 'Edit Shortcode' : 'Add Shortcode'}
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="outlined" onClick={() => setShowShortcodeModal(false)}>
              Cancel
            </Button>
            <Button variant="filled" color="primary" onClick={handleSaveShortcode}>
              {editingShortcode ? 'Save Changes' : 'Create Shortcode'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Prefix</label>
            <select
              value={shortcodeForm.prefix}
              onChange={(e) => setShortcodeForm({ ...shortcodeForm, prefix: e.target.value })}
              className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500"
            >
              {prefixes.map((p) => (
                <option key={p.prefix} value={p.prefix}>
                  {p.prefix} ({p.category})
                </option>
              ))}
            </select>
          </div>
          <Input
            label="Shortcode"
            placeholder="e.g., Pod"
            value={shortcodeForm.shortcode}
            onChange={(e) => setShortcodeForm({ ...shortcodeForm, shortcode: e.target.value })}
            description="The short code used in links (case-insensitive)"
          />
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
            placeholder="e.g., podcast"
            value={shortcodeForm.full_value}
            onChange={(e) => setShortcodeForm({ ...shortcodeForm, full_value: e.target.value })}
            description="The expanded value this shortcode represents"
          />
          <Input
            label="Description"
            placeholder="e.g., Podcast episode link"
            value={shortcodeForm.description}
            onChange={(e) => setShortcodeForm({ ...shortcodeForm, description: e.target.value })}
          />
        </div>
      </Modal>
    </div>
  );
}

// Standalone page wrapper for routing
import { Page } from '@/components/shared/Page';

export function ShortcodeConfigPage() {
  return (
    <Page title="Shortcode Configuration">
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
            Shortcode Configuration
          </h1>
          <p className="text-[var(--gray-11)] mt-1">
            Configure link prefixes and shortcode mappings for redirect parsing
          </p>
        </div>
        <ShortcodeConfigTab />
      </div>
    </Page>
  );
}
