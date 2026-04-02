import { useState, useEffect } from 'react';
import {
  NoSymbolIcon,
  MagnifyingGlassIcon,
  UserIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
} from '@heroicons/react/24/outline';
import { supabase } from '@/lib/supabase';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Card, Input, Button, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';

interface CCPACustomer {
  id: number;
  email: string;
  do_not_sell: boolean | null;
  do_not_sell_set_at: string | null;
  do_not_share: boolean | null;
  do_not_share_set_at: string | null;
  limit_sensitive_data_use: boolean | null;
  limit_sensitive_data_use_set_at: string | null;
  attributes: Record<string, any>;
  created_at: string;
}

type CCPAFilter = 'all' | 'do_not_sell' | 'do_not_share' | 'limit_sensitive';

export function CCPAPreferencesTab() {
  const [customers, setCustomers] = useState<CCPACustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<CCPAFilter>('all');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const pageSize = 50;

  const [stats, setStats] = useState({
    total: 0,
    doNotSell: 0,
    doNotShare: 0,
    limitSensitive: 0,
  });

  useEffect(() => {
    fetchCustomers();
  }, [page, filter]);

  const fetchCustomers = async () => {
    setLoading(true);
    try {
      // Build query for customers with any CCPA preference set
      let query = supabase
        .from('people')
        .select('id, email, do_not_sell, do_not_sell_set_at, do_not_share, do_not_share_set_at, limit_sensitive_data_use, limit_sensitive_data_use_set_at, attributes, created_at')
        .or('do_not_sell.eq.true,do_not_share.eq.true,limit_sensitive_data_use.eq.true')
        .order('do_not_sell_set_at', { ascending: false, nullsFirst: false })
        .range((page - 1) * pageSize, page * pageSize - 1);

      if (filter === 'do_not_sell') {
        query = supabase
          .from('people')
          .select('id, email, do_not_sell, do_not_sell_set_at, do_not_share, do_not_share_set_at, limit_sensitive_data_use, limit_sensitive_data_use_set_at, attributes, created_at')
          .eq('do_not_sell', true)
          .order('do_not_sell_set_at', { ascending: false, nullsFirst: false })
          .range((page - 1) * pageSize, page * pageSize - 1);
      } else if (filter === 'do_not_share') {
        query = supabase
          .from('people')
          .select('id, email, do_not_sell, do_not_sell_set_at, do_not_share, do_not_share_set_at, limit_sensitive_data_use, limit_sensitive_data_use_set_at, attributes, created_at')
          .eq('do_not_share', true)
          .order('do_not_share_set_at', { ascending: false, nullsFirst: false })
          .range((page - 1) * pageSize, page * pageSize - 1);
      } else if (filter === 'limit_sensitive') {
        query = supabase
          .from('people')
          .select('id, email, do_not_sell, do_not_sell_set_at, do_not_share, do_not_share_set_at, limit_sensitive_data_use, limit_sensitive_data_use_set_at, attributes, created_at')
          .eq('limit_sensitive_data_use', true)
          .order('limit_sensitive_data_use_set_at', { ascending: false, nullsFirst: false })
          .range((page - 1) * pageSize, page * pageSize - 1);
      }

      if (searchQuery) {
        query = query.ilike('email', `%${searchQuery}%`);
      }

      const { data, error } = await query;

      if (error) throw error;

      setCustomers(data || []);
      setHasMore((data || []).length === pageSize);

      // Calculate stats (on first page with no filters)
      if (page === 1 && filter === 'all' && !searchQuery) {
        const [doNotSellRes, doNotShareRes, limitSensitiveRes] = await Promise.all([
          supabase.from('people').select('id', { count: 'exact', head: true }).eq('do_not_sell', true),
          supabase.from('people').select('id', { count: 'exact', head: true }).eq('do_not_share', true),
          supabase.from('people').select('id', { count: 'exact', head: true }).eq('limit_sensitive_data_use', true),
        ]);

        const doNotSell = doNotSellRes.count || 0;
        const doNotShare = doNotShareRes.count || 0;
        const limitSensitive = limitSensitiveRes.count || 0;

        // Get total unique customers with any CCPA preference
        const { count: total } = await supabase
          .from('people')
          .select('id', { count: 'exact', head: true })
          .or('do_not_sell.eq.true,do_not_share.eq.true,limit_sensitive_data_use.eq.true');

        setStats({
          total: total || 0,
          doNotSell,
          doNotShare,
          limitSensitive,
        });
      }
    } catch (error) {
      console.error('Error fetching CCPA preferences:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString?: string | null) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
  };

  const getPreferenceBadge = (enabled: boolean | null, label: string) => {
    if (enabled === true) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200">
          <CheckCircleIcon className="size-3" />
          {label}
        </span>
      );
    }
    return null;
  };

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.total}</div>
          <div className="text-sm text-gray-600 dark:text-gray-400">Customers with Preferences</div>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-red-900 dark:text-red-200">{stats.doNotSell}</div>
          <div className="text-sm text-red-600 dark:text-red-400">Do Not Sell</div>
        </div>
        <div className="bg-orange-50 dark:bg-orange-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-orange-900 dark:text-orange-200">{stats.doNotShare}</div>
          <div className="text-sm text-orange-600 dark:text-orange-400">Do Not Share</div>
        </div>
        <div className="bg-purple-50 dark:bg-purple-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-purple-900 dark:text-purple-200">{stats.limitSensitive}</div>
          <div className="text-sm text-purple-600 dark:text-purple-400">Limit Sensitive Data</div>
        </div>
      </div>

      {/* Info Banner */}
      <Card className="p-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
        <div className="flex items-start gap-3">
          <NoSymbolIcon className="size-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="text-sm font-medium text-blue-900 dark:text-blue-200">
              CCPA Privacy Rights
            </h3>
            <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
              This tab shows customers who have exercised their California Consumer Privacy Act (CCPA) rights.
              These preferences must be honored for data sales, sharing, and sensitive data processing.
            </p>
          </div>
        </div>
      </Card>

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
                onKeyDown={(e) => e.key === 'Enter' && fetchCustomers()}
                className="flex-1"
              />
              <Button onClick={fetchCustomers} variant="outlined" className="gap-1">
                <MagnifyingGlassIcon className="size-4" />
                Search
              </Button>
            </div>
          </div>

          {/* Filter */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Preference Type
            </label>
            <select
              value={filter}
              onChange={(e) => { setFilter(e.target.value as CCPAFilter); setPage(1); }}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            >
              <option value="all">All Preferences</option>
              <option value="do_not_sell">Do Not Sell</option>
              <option value="do_not_share">Do Not Share</option>
              <option value="limit_sensitive">Limit Sensitive Data</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Customer List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner size="medium" />
        </div>
      ) : customers.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <NoSymbolIcon className="size-12 mx-auto mb-4 opacity-50" />
          <p>No CCPA preferences found.</p>
          <p className="text-sm mt-2">
            Customers can set their CCPA preferences through the privacy request form.
          </p>
        </div>
      ) : (
        <>
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <Tr>
                    <Th>Customer</Th>
                    <Th>Preferences</Th>
                    <Th>Do Not Sell Set At</Th>
                    <Th>Do Not Share Set At</Th>
                    <Th>Limit Sensitive Set At</Th>
                  </Tr>
                </THead>
                <TBody>
                  {customers.map((customer) => (
                    <Tr key={customer.id}>
                      <Td>
                        <div className="flex items-center gap-3">
                          <div className="flex-shrink-0">
                            <div className="size-8 rounded-full bg-[var(--gray-a3)] flex items-center justify-center">
                              <UserIcon className="size-4" />
                            </div>
                          </div>
                          <div>
                            <div className="text-sm font-medium">
                              {customer.email}
                            </div>
                            <div className="text-xs">
                              ID: {customer.id}
                            </div>
                          </div>
                        </div>
                      </Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          {getPreferenceBadge(customer.do_not_sell, 'Do Not Sell')}
                          {getPreferenceBadge(customer.do_not_share, 'Do Not Share')}
                          {getPreferenceBadge(customer.limit_sensitive_data_use, 'Limit Sensitive')}
                        </div>
                      </Td>
                      <Td>
                        {customer.do_not_sell ? (
                          <div className="flex items-center gap-1">
                            <ClockIcon className="size-3" />
                            {formatDate(customer.do_not_sell_set_at)}
                          </div>
                        ) : (
                          <span>-</span>
                        )}
                      </Td>
                      <Td>
                        {customer.do_not_share ? (
                          <div className="flex items-center gap-1">
                            <ClockIcon className="size-3" />
                            {formatDate(customer.do_not_share_set_at)}
                          </div>
                        ) : (
                          <span>-</span>
                        )}
                      </Td>
                      <Td>
                        {customer.limit_sensitive_data_use ? (
                          <div className="flex items-center gap-1">
                            <ClockIcon className="size-3" />
                            {formatDate(customer.limit_sensitive_data_use_set_at)}
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
