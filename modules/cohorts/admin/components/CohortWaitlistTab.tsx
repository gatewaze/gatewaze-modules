import { useState, useEffect } from 'react';
import { EnvelopeIcon, CalendarIcon, GlobeAltIcon } from '@heroicons/react/24/outline';
import { Card, Table, THead, TBody, Tr, Th, Td, Badge } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase } from '@/lib/supabase';
import { Cohort } from '../lib/types';

interface CohortWaitlistTabProps {
  cohort: Cohort;
}

interface WaitlistEntry {
  id: string;
  email: string;
  customer_id: number | null;
  interaction_type: string;
  metadata: Record<string, any> | null;
  created_at: string;
  updated_at: string;
  // Joined from customers
  customer_name?: string;
  customer_company?: string;
}

export function CohortWaitlistTab({ cohort }: CohortWaitlistTabProps) {
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadWaitlist();
  }, [cohort.id]);

  const loadWaitlist = async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch waitlist entries from cohorts_interactions
      const { data, error: fetchError } = await supabase
        .from('cohorts_interactions')
        .select(`
          id,
          email,
          customer_id,
          interaction_type,
          metadata,
          created_at,
          updated_at,
          customers (
            attributes
          )
        `)
        .eq('cohort_id', cohort.id)
        .eq('interaction_type', 'waitlist')
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;

      // Map data to include customer details
      const mappedData: WaitlistEntry[] = (data || []).map((entry: any) => ({
        id: entry.id,
        email: entry.email,
        customer_id: entry.customer_id,
        interaction_type: entry.interaction_type,
        metadata: entry.metadata,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        customer_name: entry.customers?.attributes?.first_name && entry.customers?.attributes?.last_name
          ? `${entry.customers.attributes.first_name} ${entry.customers.attributes.last_name}`
          : entry.customers?.attributes?.full_name || null,
        customer_company: entry.customers?.attributes?.company || null,
      }));

      setWaitlist(mappedData);
    } catch (err) {
      console.error('Error loading waitlist:', err);
      setError('Failed to load waitlist data');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <LoadingSpinner size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-8 text-center">
        <p className="text-red-600 dark:text-red-400">{error}</p>
        <button
          onClick={loadWaitlist}
          className="mt-4 text-primary-600 hover:text-primary-700 dark:text-primary-400"
        >
          Try again
        </button>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats Card */}
      <Card className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Waitlist
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              People waiting for spots to open up
            </p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold text-primary-600 dark:text-primary-400">
              {waitlist.length}
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {waitlist.length === 1 ? 'person' : 'people'} waiting
            </div>
          </div>
        </div>
      </Card>

      {/* Waitlist Table */}
      {waitlist.length === 0 ? (
        <Card className="p-8 text-center">
          <EnvelopeIcon className="w-12 h-12 mx-auto text-gray-400 mb-4" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            No one on the waitlist yet
          </h3>
          <p className="text-gray-600 dark:text-gray-400">
            When the cohort is full or has started, people can join the waitlist to be notified when spots open up.
          </p>
        </Card>
      ) : (
        <Card>
          <Table>
            <THead>
              <Tr>
                <Th>Email</Th>
                <Th>Name</Th>
                <Th>Company</Th>
                <Th>Source</Th>
                <Th>Joined</Th>
              </Tr>
            </THead>
            <TBody>
              {waitlist.map((entry) => (
                <Tr key={entry.id}>
                  <Td>
                    <div className="flex items-center gap-2">
                      <EnvelopeIcon className="w-4 h-4 text-gray-400" />
                      <a
                        href={`mailto:${entry.email}`}
                        className="text-primary-600 hover:text-primary-700 dark:text-primary-400"
                      >
                        {entry.email}
                      </a>
                    </div>
                  </Td>
                  <Td>
                    {entry.customer_name || (
                      <span className="text-gray-400 italic">Not provided</span>
                    )}
                  </Td>
                  <Td>
                    {entry.customer_company || (
                      <span className="text-gray-400 italic">Not provided</span>
                    )}
                  </Td>
                  <Td>
                    {entry.metadata?.source ? (
                      <div className="flex items-center gap-1 text-sm text-gray-500">
                        <GlobeAltIcon className="w-3.5 h-3.5" />
                        <span className="truncate max-w-[200px]" title={entry.metadata.source}>
                          {new URL(entry.metadata.source).pathname || '/'}
                        </span>
                      </div>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1 text-sm text-gray-500">
                      <CalendarIcon className="w-3.5 h-3.5" />
                      {formatDate(entry.created_at)}
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
