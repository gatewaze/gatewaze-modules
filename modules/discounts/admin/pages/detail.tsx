import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import ReactApexChart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  TicketIcon,
  UserGroupIcon,
  CalendarIcon,
  ClockIcon,
  MapIcon,
  ChartBarIcon,
  ArrowDownTrayIcon,
} from '@heroicons/react/24/outline';
import { Card, Button } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { EventService, Event } from '@/utils/eventService';
import { ActiveDiscountService as DiscountService } from '@/utils/serviceSwitcher';
import { DiscountCodesStats } from '../utils/discountService'; // Keep interface import
import { HybridOfferService } from '@/utils/hybridOfferService';
import { supabase } from '@/lib/supabase';
import { ConversionFunnelChart } from '@/components/charts/ConversionFunnelChart';
import { GeographicHeatmap } from '@/components/charts/GeographicHeatmap';
import { GeographicMapLeaflet } from '@/components/charts/GeographicMapLeaflet';

interface ClaimData {
  date: string;
  count: number;
  cumulative: number;
}

interface AcceptanceData {
  date: string;
  count: number;
  cumulative: number;
}

export default function DiscountDetailPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();

  const [discount, setDiscount] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [isDownloading, setIsDownloading] = useState(false);
  const [codesStats, setCodesStats] = useState<DiscountCodesStats>({ total: 0, available: 0, claimed: 0 });
  const [registrationStats, setRegistrationStats] = useState<{
    total: number;
    issued: number;
    registered: number;
    attended: number;
  }>({ total: 0, issued: 0, registered: 0, attended: 0 });
  const [claimData, setClaimData] = useState<ClaimData[]>([]);
  const [acceptanceData, setAcceptanceData] = useState<AcceptanceData[]>([]);
  const [geographicData, setGeographicData] = useState<{
    claimed: { country: string; city: string; lat: number; lng: number; count: number }[];
    registered: { country: string; city: string; lat: number; lng: number; count: number }[];
    attended: { country: string; city: string; lat: number; lng: number; count: number }[];
  }>({ claimed: [], registered: [], attended: [] });

  useEffect(() => {
    if (eventId) {
      loadDiscountDetails();
    }
  }, [eventId]);

  const loadDiscountDetails = async () => {
    setLoading(true);
    try {
      // Load discount event
      const eventResult = await EventService.getEventById(eventId!);
      if (eventResult.success && eventResult.data) {
        setDiscount(eventResult.data);

        // Load codes stats
        const stats = await DiscountService.getDiscountCodesStats(eventResult.data.eventId);
        setCodesStats(stats);

        // Load registration and attendance stats
        const regStats = await DiscountService.getRegistrationAttendanceStats(eventResult.data.eventId);
        setRegistrationStats(regStats);

        // Load geographic distribution
        const geoData = await DiscountService.getGeographicDistribution(eventResult.data.eventId);
        console.log('Geographic data loaded:', geoData);
        setGeographicData(geoData);

        // Load claim timeline data (discount codes)
        await loadClaimTimeline(eventResult.data.eventId);

        // Load acceptance timeline data (traditional offer acceptance)
        if (eventResult.data.offerSlug) {
          await loadAcceptanceTimeline(eventResult.data.offerSlug);
        }
      }
    } catch (error) {
      console.error('Error loading discount details:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadClaimTimeline = async (eventIdValue: string) => {
    try {
      // Fetch all discount codes with pagination to avoid Supabase's 1000 row limit
      let allData: Array<{ issued_at: string | null; issued: boolean }> = [];
      let from = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from('events_discount_codes')
          .select('issued_at, issued')
          .eq('event_id', eventIdValue)
          .eq('issued', true)
          .order('issued_at', { ascending: true })
          .range(from, from + pageSize - 1);

        if (error) {
          console.error('Error loading claim timeline:', error);
          return;
        }

        if (data && data.length > 0) {
          allData = allData.concat(data);
          from += pageSize;
          hasMore = data.length === pageSize;
        } else {
          hasMore = false;
        }
      }

      if (!allData || allData.length === 0) {
        setClaimData([]);
        return;
      }

      const data = allData;

      // Group by 1-minute intervals
      const groupedByInterval = data.reduce((acc: { [key: string]: number }, code) => {
        if (code.issued_at) {
          const timestamp = new Date(code.issued_at);
          // Round down to the nearest 1-minute interval (set seconds and milliseconds to 0)
          timestamp.setSeconds(0, 0);
          const intervalKey = timestamp.toISOString();
          acc[intervalKey] = (acc[intervalKey] || 0) + 1;
        }
        return acc;
      }, {});

      // Convert to timeline array with cumulative count
      const sortedIntervals = Object.keys(groupedByInterval).sort();
      let cumulative = 0;
      const timeline = sortedIntervals.map(interval => {
        cumulative += groupedByInterval[interval];
        return {
          date: interval,
          count: groupedByInterval[interval],
          cumulative
        };
      });

      setClaimData(timeline);
    } catch (error) {
      console.error('Error loading claim timeline:', error);
    }
  };

  const loadAcceptanceTimeline = async (offerSlug: string) => {
    try {
      console.log('Loading acceptance data for discount:', offerSlug);

      // Get acceptance timeline from hybrid service
      const timeline = await HybridOfferService.getAcceptedTimeline(offerSlug);

      if (timeline.length === 0) {
        console.log('No acceptances found for discount:', offerSlug);
        setAcceptanceData([]);
        return;
      }

      // Get the total count from the last timeline entry (cumulative)
      const totalCount = timeline[timeline.length - 1]?.cumulative || 0;

      console.log(`Found ${totalCount} acceptances`);

      setAcceptanceData(timeline);
    } catch (error) {
      console.error('Error loading acceptance timeline:', error);
    }
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const formatEventDate = (startDate?: string, endDate?: string) => {
    if (!startDate) return 'TBA';
    const start = new Date(startDate);
    const startFormatted = start.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });

    if (!endDate || endDate === startDate) {
      return startFormatted;
    }

    const end = new Date(endDate);
    const startMonth = start.getMonth();
    const endMonth = end.getMonth();
    const startDay = start.getDate();
    const endDay = end.getDate();

    if (startMonth === endMonth) {
      return `${start.toLocaleDateString('en-US', { month: 'short' })} ${startDay}-${endDay}`;
    }

    return `${startFormatted} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  };

  const handleDownloadClaimantsCSV = async () => {
    if (!discount?.eventId) {
      console.error('No event ID available for this discount');
      return;
    }

    setIsDownloading(true);
    try {
      // Fetch all discount codes with pagination to avoid Supabase's 1000 row limit
      let codes: Array<{ code: string; issued_to: string | null; issued_at: string | null }> = [];
      let from = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from('events_discount_codes')
          .select('code, issued_to, issued_at')
          .eq('event_id', discount.eventId)
          .eq('issued', true)
          .not('issued_to', 'is', null)
          .range(from, from + pageSize - 1);

        if (error) {
          console.error('Error fetching discount codes:', error);
          alert('Failed to fetch discount codes. Please try again.');
          return;
        }

        if (data && data.length > 0) {
          codes = codes.concat(data);
          from += pageSize;
          hasMore = data.length === pageSize;
        } else {
          hasMore = false;
        }
      }

      if (!codes || codes.length === 0) {
        alert('No claimants found for this discount offer');
        return;
      }

      // Get unique emails from issued codes
      const uniqueEmails = [...new Set(codes.map(code => code.issued_to).filter(Boolean))];

      if (uniqueEmails.length === 0) {
        alert('No claimants found for this discount offer');
        return;
      }

      // Fetch customer data for these emails in batches
      const batchSize = 100;
      const allCustomers: any[] = [];

      for (let i = 0; i < uniqueEmails.length; i += batchSize) {
        const batch = uniqueEmails.slice(i, i + batchSize);

        const { data: customers, error: customersError } = await supabase
          .from('people')
          .select('email, attributes')
          .in('email', batch);

        if (customersError) {
          console.error('Error fetching customers:', customersError);
          continue;
        }

        if (customers) {
          allCustomers.push(...customers);
        }
      }

      // Create a map of email to customer data
      const customerMap = new Map(
        allCustomers.map(customer => [customer.email, customer])
      );

      // Convert to CSV format
      const headers = ['Email', 'First Name', 'Last Name', 'Job Title', 'Company'];
      const csvRows = [headers.join(',')];

      uniqueEmails.forEach(email => {
        const customer = customerMap.get(email);
        const row = [
          email || '',
          customer?.attributes?.first_name || '',
          customer?.attributes?.last_name || '',
          customer?.attributes?.job_title || '',
          customer?.attributes?.company || '',
        ];

        // Escape fields that contain commas or quotes
        const escapedRow = row.map(field => {
          const stringField = String(field);
          if (stringField.includes(',') || stringField.includes('"') || stringField.includes('\n')) {
            return `"${stringField.replace(/"/g, '""')}"`;
          }
          return stringField;
        });

        csvRows.push(escapedRow.join(','));
      });

      const csvContent = csvRows.join('\n');

      // Create a blob and download it
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);

      link.setAttribute('href', url);
      link.setAttribute('download', `${discount.eventTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_claimants_${new Date().toISOString().split('T')[0]}.csv`);
      link.style.visibility = 'hidden';

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Error downloading claimants CSV:', error);
      alert('Failed to download claimants CSV. Please try again.');
    } finally {
      setIsDownloading(false);
    }
  };

  // Chart configuration
  const chartOptions: ApexOptions = {
    chart: {
      type: 'area',
      height: 350,
      toolbar: {
        show: true
      },
      zoom: {
        enabled: false
      }
    },
    dataLabels: {
      enabled: false
    },
    stroke: {
      curve: 'smooth',
      width: 2
    },
    xaxis: {
      type: 'datetime',
      categories: claimData.map(d => d.date),
      labels: {
        format: 'MMM dd HH:mm',
        datetimeUTC: false
      }
    },
    yaxis: {
      title: {
        text: 'Cumulative Claims'
      },
      labels: {
        formatter: (value) => Math.floor(value).toString()
      }
    },
    tooltip: {
      x: {
        format: 'MMM dd, yyyy HH:mm'
      },
      y: {
        formatter: (value) => `${Math.floor(value)} claims`
      }
    },
    fill: {
      type: 'gradient',
      gradient: {
        shadeIntensity: 1,
        opacityFrom: 0.7,
        opacityTo: 0.3,
        stops: [0, 90, 100]
      }
    },
    colors: ['#3b82f6'],
    grid: {
      borderColor: '#e5e7eb',
      strokeDashArray: 4
    }
  };

  const chartSeries = [{
    name: 'Cumulative Claims',
    data: claimData.map(d => d.cumulative)
  }];

  const dailyChartOptions: ApexOptions = {
    chart: {
      type: 'bar',
      height: 300,
      toolbar: {
        show: true
      },
      zoom: {
        enabled: false
      }
    },
    plotOptions: {
      bar: {
        borderRadius: 4,
        columnWidth: '60%'
      }
    },
    dataLabels: {
      enabled: false
    },
    xaxis: {
      type: 'datetime',
      categories: claimData.map(d => d.date),
      labels: {
        format: 'MMM dd HH:mm',
        datetimeUTC: false
      }
    },
    yaxis: {
      title: {
        text: 'Claims per Minute'
      },
      labels: {
        formatter: (value) => Math.floor(value).toString()
      }
    },
    tooltip: {
      x: {
        format: 'MMM dd, yyyy HH:mm'
      },
      y: {
        formatter: (value) => `${Math.floor(value)} claims`
      }
    },
    colors: ['#10b981'],
    grid: {
      borderColor: '#e5e7eb',
      strokeDashArray: 4
    }
  };

  const dailyChartSeries = [{
    name: 'Claims per Minute',
    data: claimData.map(d => d.count)
  }];

  // Acceptance chart configuration
  const acceptanceChartOptions: ApexOptions = {
    chart: {
      type: 'area',
      height: 350,
      toolbar: {
        show: true
      },
      zoom: {
        enabled: false
      }
    },
    dataLabels: {
      enabled: false
    },
    stroke: {
      curve: 'smooth',
      width: 2
    },
    xaxis: {
      type: 'datetime',
      categories: acceptanceData.map(d => d.date),
      labels: {
        format: 'MMM dd HH:mm',
        datetimeUTC: false
      }
    },
    yaxis: {
      title: {
        text: 'Cumulative Acceptances'
      },
      labels: {
        formatter: (value) => Math.floor(value).toString()
      }
    },
    tooltip: {
      x: {
        format: 'MMM dd, yyyy HH:mm'
      },
      y: {
        formatter: (value) => `${Math.floor(value)} acceptances`
      }
    },
    fill: {
      type: 'gradient',
      gradient: {
        shadeIntensity: 1,
        opacityFrom: 0.7,
        opacityTo: 0.3,
        stops: [0, 90, 100]
      }
    },
    colors: ['#8b5cf6'],
    grid: {
      borderColor: '#e5e7eb',
      strokeDashArray: 4
    }
  };

  const acceptanceChartSeries = [{
    name: 'Cumulative Acceptances',
    data: acceptanceData.map(d => d.cumulative)
  }];

  const acceptanceHourlyChartOptions: ApexOptions = {
    chart: {
      type: 'bar',
      height: 300,
      toolbar: {
        show: true
      },
      zoom: {
        enabled: false
      }
    },
    plotOptions: {
      bar: {
        borderRadius: 4,
        columnWidth: '60%'
      }
    },
    dataLabels: {
      enabled: false
    },
    xaxis: {
      type: 'datetime',
      categories: acceptanceData.map(d => d.date),
      labels: {
        format: 'MMM dd HH:mm',
        datetimeUTC: false
      }
    },
    yaxis: {
      title: {
        text: 'Acceptances per Hour'
      },
      labels: {
        formatter: (value) => Math.floor(value).toString()
      }
    },
    tooltip: {
      x: {
        format: 'MMM dd, yyyy HH:mm'
      },
      y: {
        formatter: (value) => `${Math.floor(value)} acceptances`
      }
    },
    colors: ['#f59e0b'],
    grid: {
      borderColor: '#e5e7eb',
      strokeDashArray: 4
    }
  };

  const acceptanceHourlyChartSeries = [{
    name: 'Acceptances per Hour',
    data: acceptanceData.map(d => d.count)
  }];

  if (loading) {
    return (
      <Page title="Discount Details">
        <div className="p-6 flex items-center justify-center h-64">
          <div className="text-neutral-500">Loading discount details...</div>
        </div>
      </Page>
    );
  }

  if (!discount) {
    return (
      <Page title="Discount Not Found">
        <div className="p-6">
          <div className="text-center py-12">
            <h3 className="text-lg font-medium text-gray-900 dark:text-white">Discount not found</h3>
            <Button onClick={() => navigate('/discounts')} className="mt-4">
              Back to Discounts
            </Button>
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title={`Discount Details - ${discount.eventTitle}`}>
      <div className="p-6 space-y-6">
        {/* Back Button */}
        <div>
          <Button
            onClick={() => navigate('/discounts')}
            variant="outlined"
            className="gap-2"
          >
            <ArrowLeftIcon className="size-4" />
            Back to Discounts
          </Button>
        </div>

        {/* Header */}
        <div className="flex items-start gap-4">
          {discount.eventLogo && (
            <div className="flex-shrink-0 w-24 h-16 bg-black rounded p-2">
              <img
                src={discount.eventLogo.startsWith('http') ? discount.eventLogo : `https://www.tech.tickets${discount.eventLogo}`}
                alt={discount.eventTitle}
                className="w-full h-full object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
          )}
          <div className="flex-1">
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              {discount.eventTitle}
            </h1>
            <div className="flex items-center gap-4 mt-2 text-sm text-gray-600 dark:text-gray-400">
              <span className="flex items-center gap-1">
                <CalendarIcon className="size-4" />
                {formatEventDate(discount.eventStart, discount.eventEnd)}
              </span>
              <span>{discount.eventCity}, {discount.eventCountryCode}</span>
            </div>
            {discount.offerCloseDate && (
              <div className="flex items-center gap-1 mt-1 text-sm text-gray-500">
                <ClockIcon className="size-4" />
                Closes: {formatDate(discount.offerCloseDate)}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              onClick={handleDownloadClaimantsCSV}
              disabled={isDownloading || codesStats.claimed === 0}
              variant="outlined"
              className="gap-2"
            >
              <ArrowDownTrayIcon className="size-4" />
              {isDownloading ? 'Downloading...' : 'Download Claimants CSV'}
            </Button>
            <Button
              onClick={loadDiscountDetails}
              variant="outlined"
              className="gap-2"
            >
              <ArrowPathIcon className="size-4" />
              Refresh
            </Button>
          </div>
        </div>

        {/* Summary Stats Bar */}
        <div className="mt-6 grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card variant="surface" className="p-4">
            <div className="text-xs font-medium text-neutral-500 uppercase">Total Codes</div>
            <div className="text-2xl font-bold mt-1">{codesStats.total}</div>
          </Card>
          <Card variant="surface" className="p-4">
            <div className="text-xs font-medium text-neutral-500 uppercase">Claimed</div>
            <div className="text-2xl font-bold mt-1 text-blue-600">{codesStats.claimed}</div>
            <div className="text-xs text-neutral-500">
              {codesStats.total > 0 ? Math.round((codesStats.claimed / codesStats.total) * 100) : 0}%
            </div>
          </Card>
          <Card variant="surface" className="p-4">
            <div className="text-xs font-medium text-neutral-500 uppercase">Registered</div>
            <div className="text-2xl font-bold mt-1 text-purple-600">{registrationStats.registered}</div>
            <div className="text-xs text-neutral-500">
              {codesStats.claimed > 0 ? Math.round((registrationStats.registered / codesStats.claimed) * 100) : 0}%
            </div>
          </Card>
          <Card variant="surface" className="p-4">
            <div className="text-xs font-medium text-neutral-500 uppercase">Attended</div>
            <div className="text-2xl font-bold mt-1 text-green-600">{registrationStats.attended}</div>
            <div className="text-xs text-neutral-500">
              {registrationStats.registered > 0 ? Math.round((registrationStats.attended / registrationStats.registered) * 100) : 0}%
            </div>
          </Card>
          <Card variant="surface" className="p-4">
            <div className="text-xs font-medium text-neutral-500 uppercase">Conversion</div>
            <div className="text-2xl font-bold mt-1">
              {codesStats.claimed > 0 ? Math.round((registrationStats.attended / codesStats.claimed) * 100) : 0}%
            </div>
            <div className="text-xs text-neutral-500">Claimed → Attended</div>
          </Card>
        </div>

        {/* Charts */}
        <div className="space-y-6">
          {/* Discount Code Claims Charts */}
          {claimData.length > 0 && (
            <div className="space-y-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Discount Code Distribution Timeline</h3>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Cumulative Claims Chart */}
                <Card variant="surface" className="p-6">
                  <div className="mb-4">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                      Cumulative Claims Over Time
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      Total number of discount codes claimed over time
                    </p>
                  </div>
                  <ReactApexChart
                    options={chartOptions}
                    series={chartSeries}
                    type="area"
                    height={300}
                  />
                </Card>

                {/* Claims per Minute Chart */}
                <Card variant="surface" className="p-6">
                  <div className="mb-4">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                      Claims per Minute
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      Number of discount codes claimed per minute
                    </p>
                  </div>
                  <ReactApexChart
                    options={dailyChartOptions}
                    series={dailyChartSeries}
                    type="bar"
                    height={300}
                  />
                </Card>
              </div>
            </div>
          )}

          {/* Offer Acceptance Charts */}
          {acceptanceData.length > 0 && (
            <div className="space-y-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Offer Acceptance Timeline</h3>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Cumulative Acceptances Chart */}
                <Card variant="surface" className="p-6">
                  <div className="mb-4">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                      Cumulative Acceptances Over Time
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      Total number of offer acceptances over time
                    </p>
                  </div>
                  <ReactApexChart
                    options={acceptanceChartOptions}
                    series={acceptanceChartSeries}
                    type="area"
                    height={300}
                  />
                </Card>

                {/* Acceptances per Hour Chart */}
                <Card variant="surface" className="p-6">
                  <div className="mb-4">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                      Acceptances per Hour
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      Number of offer acceptances per hour
                    </p>
                  </div>
                  <ReactApexChart
                    options={acceptanceHourlyChartOptions}
                    series={acceptanceHourlyChartSeries}
                    type="bar"
                    height={300}
                  />
                </Card>
              </div>
            </div>
          )}

          {/* Conversion Funnel */}
          {codesStats.total > 0 && (
            <div className="mt-8">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-4">
                <ChartBarIcon className="size-5" />
                Conversion Funnel Analysis
              </h3>
              <Card variant="surface" className="p-6">
                <ConversionFunnelChart
                  total={codesStats.total}
                  claimed={codesStats.claimed}
                  registered={registrationStats.registered}
                  attended={registrationStats.attended}
                />
              </Card>
            </div>
          )}

          {/* Geographic Distribution */}
          <div className="mt-8">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-4">
              <MapIcon className="size-5" />
              Geographic Distribution
            </h3>

            {/* Map Visualization */}
            <Card variant="surface" className="p-6 mb-6">
              {(geographicData.claimed.length > 0 || geographicData.registered.length > 0 || geographicData.attended.length > 0) ? (
                <GeographicMapLeaflet
                  claimed={geographicData.claimed}
                  registered={geographicData.registered}
                  attended={geographicData.attended}
                />
              ) : (
                <div className="text-center py-12">
                  <MapIcon className="mx-auto h-12 w-12 text-gray-400" />
                  <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                    No Geographic Data Available
                  </h3>
                  <p className="mt-1 text-sm text-gray-500">
                    Geographic distribution will appear once discount codes are claimed by users with location data.
                  </p>
                </div>
              )}
            </Card>

            {/* Heatmap Visualization - for aggregated city/country data without coordinates */}
            {(geographicData.claimed.length > 0 || geographicData.registered.length > 0 || geographicData.attended.length > 0) && (
              <Card variant="surface" className="p-6">
                <GeographicHeatmap
                  claimed={geographicData.claimed}
                  registered={geographicData.registered}
                  attended={geographicData.attended}
                />
              </Card>
            )}
          </div>

          {/* No Data Message */}
          {claimData.length === 0 && acceptanceData.length === 0 && codesStats.claimed === 0 && (
            <Card variant="surface" className="p-12">
              <div className="text-center">
                <TicketIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                  No activity yet
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  No discount codes have been claimed yet. Check back later.
                </p>
              </div>
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
}
