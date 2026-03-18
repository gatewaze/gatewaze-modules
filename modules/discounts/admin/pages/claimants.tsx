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
import { EventService, Event } from '@/utils/eventService';
import { ActiveDiscountService as DiscountService } from '@/utils/serviceSwitcher';
import { PersonProfile } from '@/utils/winnerSelectionService';
import { useAccountAccess } from '@/hooks/useAccountAccess';

export default function DiscountClaimantsPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const { isAccountUser, isSystemAdmin, canEdit } = useAccountAccess();

  const [discount, setDiscount] = useState<Event | null>(null);
  const [claimants, setClaimants] = useState<PersonProfile[]>([]);
  const [isLoadingClaimants, setIsLoadingClaimants] = useState(false);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedClaimants, setSelectedClaimants] = useState<Set<string>>(new Set());

  useEffect(() => {
    console.log('Discount Claimants Page - eventId:', eventId);
    if (eventId) {
      loadDiscount(eventId);
      loadClaimants(eventId);
    }
  }, [eventId]);

  const loadDiscount = async (id: string) => {
    try {
      console.log('Loading discount with UUID:', id);
      const response = await EventService.getEventById(id);
      console.log('Discount loaded:', response);
      if (response.success && response.data) {
        setDiscount(response.data);
      } else {
        console.error('Discount not found');
        setDiscount({} as Event); // Set empty object to prevent infinite loading
      }
    } catch (error) {
      console.error('Error loading discount:', error);
      setDiscount({} as Event); // Set empty object to prevent infinite loading
    }
  };

  const loadClaimants = async (id: string) => {
    setIsLoadingClaimants(true);
    setClaimants([]);
    setSelectedClaimants(new Set());

    try {
      console.log('📊 [1/2] Loading discount details...');
      const response = await EventService.getEventById(id);
      const event = response.data;
      if (!event || !event.offerSlug) {
        console.error('❌ No offer slug found for discount');
        setIsLoadingClaimants(false);
        return;
      }
      console.log('✅ Discount loaded:', event.eventTitle);

      // Get claimants from discount_interactions table
      console.log('📊 [2/2] Fetching claimants from discount_interactions table...');
      const customers = await DiscountService.getClaimantsForOffer(event.offerSlug);
      console.log(`✅ Fetched ${customers.length} claimants from database`);

      console.log(`🎉 Successfully loaded ${customers.length} claimants`);
      setClaimants(customers);
    } catch (error) {
      console.error('❌ Fatal error loading claimants:', error);
      if (error instanceof Error) {
        console.error('   Error details:', {
          name: error.name,
          message: error.message,
          stack: error.stack
        });
      }
    } finally {
      setIsLoadingClaimants(false);
    }
  };

  const handleToggleClaimant = (email: string) => {
    setSelectedClaimants(prev => {
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
    if (selectedClaimants.size === claimants.length) {
      setSelectedClaimants(new Set());
    } else {
      setSelectedClaimants(new Set(claimants.map(c => c.email)));
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
    const customersToExport = selectedClaimants.size > 0
      ? claimants.filter(c => selectedClaimants.has(c.email))
      : claimants;

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
    link.setAttribute('download', `discount_claimants_${discount?.eventTitle?.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const filteredClaimants = claimants.filter(customer =>
    customer.email.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (!discount || !discount.eventTitle) {
    return (
      <Page title="Discount Claimants">
        <div className="p-6">
          <div className="text-center py-12">
            <ArrowPathIcon className="size-12 mx-auto text-neutral-400 animate-spin mb-3" />
            <p className="text-neutral-600 dark:text-neutral-400">Loading discount...</p>
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title={`Claimants - ${discount.eventTitle || 'Discount'}`}>
      <div className="p-6 space-y-6">
        {/* Back Button */}
        <div>
          <Button
            onClick={() => navigate('/discounts')}
            variant="outline"

          >
            <ArrowLeftIcon className="size-4" />
            Back to Discounts
          </Button>
        </div>

        {/* Header */}
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Discount Claimants
            </h1>
            {isAccountUser && !canEdit && (
              <span className="px-3 py-1 text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-400 rounded-full">
                View Only
              </span>
            )}
          </div>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            {discount.eventTitle}
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-500 mt-1">
            {discount.eventCity && discount.eventCountryCode && (
              <>{discount.eventCity}, {discount.eventCountryCode} • </>
            )}
            {discount.eventStart && formatDate(discount.eventStart)}
          </p>
        </div>

        {/* Stats Card */}
        <Card variant="surface" className="p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="text-sm text-neutral-600 dark:text-neutral-400">
                {claimants.length > 0 ? `${filteredClaimants.length} of ${claimants.length} claimants` : 'Loading claimants...'}
                {selectedClaimants.size > 0 && (
                  <span className="ml-2 text-primary-600 dark:text-primary-400 font-medium">
                    ({selectedClaimants.size} selected)
                  </span>
                )}
              </div>
              {claimants.length > 0 && (
                <Button
                  variant="ghost"
                  onClick={handleSelectAll}
                >
                  {selectedClaimants.size === claimants.length ? 'Deselect All' : 'Select All'}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={handleExportCSV}
                disabled={claimants.length === 0}
    
                variant="outline"
              >
                <ArrowDownTrayIcon className="size-5" />
                Export {selectedClaimants.size > 0 ? `${selectedClaimants.size} Selected` : 'All'} to CSV
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

        {/* Claimants List */}
        <Card variant="surface" className="p-6">
          {isLoadingClaimants ? (
            <div className="text-center py-12">
              <ArrowPathIcon className="size-12 mx-auto text-neutral-400 animate-spin mb-3" />
              <p className="text-neutral-600 dark:text-neutral-400">Loading claimants...</p>
            </div>
          ) : claimants.length === 0 ? (
            <div className="text-center py-12">
              <UserGroupIcon className="size-12 mx-auto text-neutral-400 mb-3" />
              <p className="text-neutral-600 dark:text-neutral-400">No claimants found for this discount</p>
            </div>
          ) : filteredClaimants.length === 0 ? (
            <div className="text-center py-12">
              <UserGroupIcon className="size-12 mx-auto text-neutral-400 mb-3" />
              <p className="text-neutral-600 dark:text-neutral-400">No claimants match your search</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredClaimants.map((customer, idx) => {
                const isSelected = selectedClaimants.has(customer.email);
                const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'No name';

                return (
                  <div
                    key={`${customer.email}-${idx}`}
                    onClick={() => handleToggleClaimant(customer.email)}
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
