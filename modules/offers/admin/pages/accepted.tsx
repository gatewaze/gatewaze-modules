import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  ArrowPathIcon,
  UserGroupIcon,
  MagnifyingGlassIcon,
  ArrowLeftIcon,
  ArrowDownTrayIcon,
} from '@heroicons/react/24/outline';
import { Card, Button } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { ActiveOfferService as OfferService } from '@/utils/serviceSwitcher';
import { PersonProfile } from '@/utils/winnerSelectionService';

export default function OfferAcceptedPage() {
  const { eventId: offerIdParam } = useParams<{ eventId: string }>();
  const navigate = useNavigate();

  const [offerId, setOfferId] = useState<string>('');
  const [acceptedCustomers, setAcceptedCustomers] = useState<PersonProfile[]>([]);
  const [isLoadingCustomers, setIsLoadingCustomers] = useState(false);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedCustomers, setSelectedCustomers] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (offerIdParam) {
      const decoded = decodeURIComponent(offerIdParam);
      setOfferId(decoded);
      loadAcceptedCustomers(decoded);
    }
  }, [offerIdParam]);

  const loadAcceptedCustomers = async (id: string) => {
    setIsLoadingCustomers(true);
    setAcceptedCustomers([]);
    setSelectedCustomers(new Set());

    try {
      console.log('📊 Fetching accepted customers from offer_interactions table...');
      const customers = await OfferService.getAcceptedForOffer(id);
      console.log(`✅ Fetched ${customers.length} accepted customers from database`);

      setAcceptedCustomers(customers);
    } catch (error) {
      console.error('❌ Fatal error loading accepted customers:', error);
      if (error instanceof Error) {
        console.error('   Error details:', {
          name: error.name,
          message: error.message,
          stack: error.stack
        });
      }
    } finally {
      setIsLoadingCustomers(false);
    }
  };

  const handleToggleCustomer = (email: string) => {
    setSelectedCustomers(prev => {
      const newSet = new Set(prev);
      if (newSet.has(email)) {
        newSet.delete(email);
      } else {
        newSet.add(email);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    if (selectedCustomers.size === acceptedCustomers.length) {
      setSelectedCustomers(new Set());
    } else {
      setSelectedCustomers(new Set(acceptedCustomers.map(c => c.email)));
    }
  };

  const handleExportCSV = () => {
    // Define CSV columns - matching members page export
    const columns = [
      'email',
      'first_name',
      'last_name',
      'job_title',
      'company',
      'linkedin_url',
      'city',
      'country',
      'continent'
    ];

    // Create CSV header
    const csvHeader = columns.join(',');

    // Get customers to export
    const customersToExport = selectedCustomers.size > 0
      ? acceptedCustomers.filter(c => selectedCustomers.has(c.email))
      : acceptedCustomers;

    // Create CSV rows
    const csvRows = customersToExport.map(customer => {
      const row = [
        customer.email || '',
        customer.first_name || '',
        customer.last_name || '',
        customer.job_title || '',
        customer.company || '',
        customer.linkedin_url || '',
        customer.city || '',
        customer.country || '',
        customer.continent || ''
      ];

      // Escape fields that contain commas, quotes, or newlines
      return row.map(field => {
        const fieldStr = String(field);
        if (fieldStr.includes(',') || fieldStr.includes('"') || fieldStr.includes('\n')) {
          return `"${fieldStr.replace(/"/g, '""')}"`;
        }
        return fieldStr;
      }).join(',');
    });

    // Combine header and rows
    const csvContent = [csvHeader, ...csvRows].join('\n');

    // Create blob and download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `offer_accepted_${offerId.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const filteredCustomers = acceptedCustomers.filter(customer =>
    customer.email.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (!offerId) {
    return (
      <Page title="Offer Accepted">
        <div className="p-6">
          <div className="text-center py-12">
            <ArrowPathIcon className="size-12 mx-auto text-neutral-400 animate-spin mb-3" />
            <p className="text-neutral-600 dark:text-neutral-400">Loading offer...</p>
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title={`Accepted - ${offerId}`}>
      <div className="p-6 space-y-6">
        {/* Back Button */}
        <div>
          <Button
            onClick={() => navigate('/offers')}
            variant="outline"

          >
            <ArrowLeftIcon className="size-4" />
            Back to Offers
          </Button>
        </div>

        {/* Header */}
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Offer Accepted
            </h1>
          </div>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1 font-mono">
            {offerId}
          </p>
        </div>

        {/* Stats Card */}
        <Card variant="surface" className="p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="text-sm text-neutral-600 dark:text-neutral-400">
                {acceptedCustomers.length > 0 ? `${filteredCustomers.length} of ${acceptedCustomers.length} accepted` : 'Loading accepted customers...'}
                {selectedCustomers.size > 0 && (
                  <span className="ml-2 text-primary-600 dark:text-primary-400 font-medium">
                    ({selectedCustomers.size} selected)
                  </span>
                )}
              </div>
              {acceptedCustomers.length > 0 && (
                <Button
                  variant="ghost"
                  onClick={handleSelectAll}
                >
                  {selectedCustomers.size === acceptedCustomers.length ? 'Deselect All' : 'Select All'}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={handleExportCSV}
                disabled={acceptedCustomers.length === 0}
    
                variant="outline"
              >
                <ArrowDownTrayIcon className="size-5" />
                Export {selectedCustomers.size > 0 ? `${selectedCustomers.size} Selected` : 'All'} to CSV
              </Button>
            </div>
          </div>
        </Card>

        {/* Search */}
        <Card variant="surface" className="p-4">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-5 text-neutral-400" />
            <input
              type="text"
              placeholder="Filter by email address..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-neutral-900 dark:text-white"
            />
          </div>
        </Card>

        {/* Accepted Customers List */}
        <Card variant="surface" className="p-6">
          {isLoadingCustomers ? (
            <div className="text-center py-12">
              <ArrowPathIcon className="size-12 mx-auto text-neutral-400 animate-spin mb-3" />
              <p className="text-neutral-600 dark:text-neutral-400">Loading accepted customers...</p>
            </div>
          ) : acceptedCustomers.length === 0 ? (
            <div className="text-center py-12">
              <UserGroupIcon className="size-12 mx-auto text-neutral-400 mb-3" />
              <p className="text-neutral-600 dark:text-neutral-400">No customers have accepted this offer yet</p>
            </div>
          ) : filteredCustomers.length === 0 ? (
            <div className="text-center py-12">
              <UserGroupIcon className="size-12 mx-auto text-neutral-400 mb-3" />
              <p className="text-neutral-600 dark:text-neutral-400">No customers match your search</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredCustomers.map((customer, idx) => {
                const isSelected = selectedCustomers.has(customer.email);
                const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'No name';

                return (
                  <div
                    key={`${customer.email}-${idx}`}
                    onClick={() => handleToggleCustomer(customer.email)}
                    className={`relative p-4 rounded-lg border-2 cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-primary-50 dark:bg-primary-900/20 border-primary-500'
                        : 'bg-white dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700 hover:border-primary-300 dark:hover:border-primary-600'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <h3 className="font-semibold text-neutral-900 dark:text-white text-base">
                        {fullName}
                      </h3>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => e.stopPropagation()}
                        className="size-5 rounded border-gray-300 text-primary-600 focus:ring-primary-500 cursor-pointer flex-shrink-0"
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm text-neutral-600 dark:text-neutral-400 font-mono truncate">
                        {customer.email}
                      </p>
                      {customer.company && (
                        <p className="text-sm text-neutral-500 dark:text-neutral-500">
                          {customer.company}
                        </p>
                      )}
                      {customer.city && (
                        <p className="text-sm text-neutral-500 dark:text-neutral-500">
                          {customer.city}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
