import { useState, useEffect } from 'react';
import {
  DocumentTextIcon,
  CheckCircleIcon,
  XCircleIcon,
  MagnifyingGlassIcon,
  ClockIcon,
  UserIcon,
} from '@heroicons/react/24/outline';
import { supabase } from '@/lib/supabase';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Card, Input, Button, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';

interface ConsentRecord {
  id: string;
  person_id: number | null;
  email: string;
  consent_type: string;
  consented: boolean;
  consent_text?: string;
  ip_address?: string;
  user_agent?: string;
  consented_at: string;
  withdrawn_at?: string;
  created_at: string;
  customer?: {
    email: string;
    attributes: Record<string, any>;
  };
}

type ConsentFilter = 'all' | 'active' | 'withdrawn';
type ConsentTypeFilter = 'all' | 'marketing_email' | 'marketing_sms' | 'analytics' | 'data_processing' | 'third_party_sharing' | 'profiling';

const CONSENT_TYPE_LABELS: Record<string, string> = {
  marketing_email: 'Marketing Email',
  marketing_sms: 'Marketing SMS',
  marketing_push: 'Marketing Push',
  data_processing: 'Data Processing',
  third_party_sharing: 'Third-Party Sharing',
  analytics: 'Analytics & Tracking',
  profiling: 'User Profiling',
  event_photography: 'Event Photography',
  testimonials: 'Testimonials',
};

export function ConsentRecordsTab() {
  const [consents, setConsents] = useState<ConsentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [consentFilter, setConsentFilter] = useState<ConsentFilter>('all');
  const [typeFilter, setTypeFilter] = useState<ConsentTypeFilter>('all');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const pageSize = 50;

  const [stats, setStats] = useState({
    total: 0,
    active: 0,
    withdrawn: 0,
    byType: {} as Record<string, number>,
  });

  useEffect(() => {
    fetchConsents();
  }, [page, consentFilter, typeFilter]);

  const fetchConsents = async () => {
    setLoading(true);
    try {
      let query = supabase
        .from('compliance_consent_records')
        .select(`
          *,
          customer:people!person_id(email, attributes)
        `)
        .order('consented_at', { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1);

      if (consentFilter === 'active') {
        query = query.eq('consented', true).is('withdrawn_at', null);
      } else if (consentFilter === 'withdrawn') {
        query = query.not('withdrawn_at', 'is', null);
      }

      if (typeFilter !== 'all') {
        query = query.eq('consent_type', typeFilter);
      }

      if (searchQuery) {
        // Search by email through a subquery
        const { data: customerIds } = await supabase
          .from('people')
          .select('id')
          .ilike('email', `%${searchQuery}%`);

        if (customerIds && customerIds.length > 0) {
          query = query.in('person_id', customerIds.map(c => c.id));
        }
      }

      const { data, error } = await query;

      if (error) throw error;

      setConsents(data || []);
      setHasMore((data || []).length === pageSize);

      // Calculate stats (on first page)
      if (page === 1 && consentFilter === 'all' && typeFilter === 'all' && !searchQuery) {
        const { data: allConsents } = await supabase
          .from('compliance_consent_records')
          .select('consent_type, consented, withdrawn_at');

        if (allConsents) {
          const total = allConsents.length;
          const active = allConsents.filter(c => c.consented && !c.withdrawn_at).length;
          const withdrawn = allConsents.filter(c => c.withdrawn_at).length;
          const byType: Record<string, number> = {};

          allConsents.forEach(c => {
            byType[c.consent_type] = (byType[c.consent_type] || 0) + 1;
          });

          setStats({ total, active, withdrawn, byType });
        }
      }
    } catch (error) {
      console.error('Error fetching consent records:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
  };

  const getConsentTypeBadge = (type: string) => {
    const colors: Record<string, string> = {
      marketing_email: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-200',
      marketing_sms: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-200',
      marketing_push: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-200',
      analytics: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200',
      data_processing: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200',
      third_party_sharing: 'bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-200',
      profiling: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200',
      event_photography: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-200',
      testimonials: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200',
    };

    return (
      <span className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded-full ${colors[type] || 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'}`}>
        {CONSENT_TYPE_LABELS[type] || type}
      </span>
    );
  };

  const getStatusBadge = (consent: ConsentRecord) => {
    if (consent.withdrawn_at) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200">
          <XCircleIcon className="size-3" />
          Withdrawn
        </span>
      );
    }
    if (consent.consented) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200">
          <CheckCircleIcon className="size-3" />
          Active
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200">
        <XCircleIcon className="size-3" />
        Declined
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.total}</div>
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Records</div>
        </div>
        <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-green-900 dark:text-green-200">{stats.active}</div>
          <div className="text-sm text-green-600 dark:text-green-400">Active Consents</div>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-red-900 dark:text-red-200">{stats.withdrawn}</div>
          <div className="text-sm text-red-600 dark:text-red-400">Withdrawn</div>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-blue-900 dark:text-blue-200">
            {Object.keys(stats.byType).length}
          </div>
          <div className="text-sm text-blue-600 dark:text-blue-400">Consent Types</div>
        </div>
      </div>

      {/* Consent Type Breakdown */}
      {Object.keys(stats.byType).length > 0 && (
        <Card className="p-4">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
            Consent by Type
          </h3>
          <div className="flex flex-wrap gap-3">
            {Object.entries(stats.byType).map(([type, count]) => (
              <div key={type} className="flex items-center gap-2">
                {getConsentTypeBadge(type)}
                <span className="text-sm text-gray-600 dark:text-gray-400">{count}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Filters */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-4 items-end">
          {/* Search */}
          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Search by Email
            </label>
            <div className="flex gap-2">
              <Input
                placeholder="Search by email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && fetchConsents()}
                className="flex-1"
              />
              <Button onClick={fetchConsents} variant="outlined" className="gap-1">
                <MagnifyingGlassIcon className="size-4" />
                Search
              </Button>
            </div>
          </div>

          {/* Status Filter */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Status
            </label>
            <select
              value={consentFilter}
              onChange={(e) => { setConsentFilter(e.target.value as ConsentFilter); setPage(1); }}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            >
              <option value="all">All Status</option>
              <option value="active">Active</option>
              <option value="withdrawn">Withdrawn</option>
            </select>
          </div>

          {/* Type Filter */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Consent Type
            </label>
            <select
              value={typeFilter}
              onChange={(e) => { setTypeFilter(e.target.value as ConsentTypeFilter); setPage(1); }}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            >
              <option value="all">All Types</option>
              <option value="marketing_email">Marketing Email</option>
              <option value="marketing_sms">Marketing SMS</option>
              <option value="analytics">Analytics</option>
              <option value="data_processing">Data Processing</option>
              <option value="third_party_sharing">Third-Party Sharing</option>
              <option value="profiling">Profiling</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Consent List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner size="medium" />
        </div>
      ) : consents.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <DocumentTextIcon className="size-12 mx-auto mb-4 opacity-50" />
          <p>No consent records found.</p>
          <p className="text-sm mt-2">Consent records are created when users interact with consent forms.</p>
        </div>
      ) : (
        <>
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <Tr>
                    <Th>User</Th>
                    <Th>Consent Type</Th>
                    <Th>Status</Th>
                    <Th>Consented At</Th>
                    <Th>Withdrawn At</Th>
                  </Tr>
                </THead>
                <TBody>
                  {consents.map((consent) => (
                    <Tr key={consent.id}>
                      <Td>
                        <div className="flex items-center gap-3">
                          <div className="flex-shrink-0">
                            <div className="size-8 rounded-full bg-[var(--gray-a3)] flex items-center justify-center">
                              <UserIcon className="size-4" />
                            </div>
                          </div>
                          <div>
                            <div className="text-sm font-medium">
                              {consent.email || consent.customer?.email || `Customer #${consent.person_id}`}
                            </div>
                            {consent.person_id && (
                              <div className="text-xs">
                                Customer ID: {consent.person_id}
                              </div>
                            )}
                          </div>
                        </div>
                      </Td>
                      <Td>
                        {getConsentTypeBadge(consent.consent_type)}
                      </Td>
                      <Td>
                        {getStatusBadge(consent)}
                      </Td>
                      <Td>
                        <div className="flex items-center gap-1">
                          <ClockIcon className="size-3" />
                          {formatDate(consent.consented_at)}
                        </div>
                        {consent.ip_address && (
                          <div className="text-xs mt-1">
                            IP: {consent.ip_address}
                          </div>
                        )}
                      </Td>
                      <Td>
                        {consent.withdrawn_at ? (
                          <div className="text-[var(--red-11)]">
                            {formatDate(consent.withdrawn_at)}
                          </div>
                        ) : (
                          <span>-</span>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          </Card>

          {/* Pagination */}
          <div className="flex justify-between items-center">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Page {page}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outlined"
                size="sm"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                Previous
              </Button>
              <Button
                variant="outlined"
                size="sm"
                onClick={() => setPage(p => p + 1)}
                disabled={!hasMore}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
