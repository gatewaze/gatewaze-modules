import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import ReactApexChart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  LinkIcon,
  ChartBarIcon,
  GlobeAltIcon,
  DevicePhoneMobileIcon,
  ComputerDesktopIcon,
  ClipboardDocumentIcon,
  ArrowTopRightOnSquareIcon,
  CalendarIcon,
  MapPinIcon,
  CursorArrowRaysIcon,
} from '@heroicons/react/24/outline';
import { Card, Badge, Button } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { supabase } from '@/lib/supabase';
import { getShortLinkDomain } from '@/config/brands';
import { toast } from 'sonner';

// Types
interface Redirect {
  id: string;
  shortio_id: string;
  original_url: string;
  short_url: string;
  secure_short_url: string | null;
  path: string;
  domain: string;
  title: string | null;
  archived: boolean;
  tags: string[] | null;
  total_clicks: number;
  unique_clicks: number;
  human_clicks: number;
  source_type: string | null;
  source_id: string | null;
  shortio_created_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ClickData {
  date: string;
  clicks: number;
  humanClicks: number;
}

interface BrowserData {
  browser: string;
  count: number;
}

interface DeviceData {
  device: string;
  count: number;
}

interface CountryData {
  country: string;
  count: number;
}

interface ReferrerData {
  referrer: string;
  count: number;
}

interface LinkStatistics {
  totalClicks: number;
  humanClicks: number;
  uniqueClicks: number;
  clicksByDate: ClickData[];
  browsers: BrowserData[];
  devices: DeviceData[];
  countries: CountryData[];
  referrers: ReferrerData[];
}

export default function RedirectDetailPage() {
  const { redirectId } = useParams<{ redirectId: string }>();
  const navigate = useNavigate();

  const [redirect, setRedirect] = useState<Redirect | null>(null);
  const [statistics, setStatistics] = useState<LinkStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(false);

  // Get the current brand's Short.io domain
  const shortIoDomain = getShortLinkDomain();

  useEffect(() => {
    if (redirectId) {
      loadRedirectDetails();
    }
  }, [redirectId]);

  const loadRedirectDetails = async () => {
    setLoading(true);
    try {
      // Load redirect from database
      const { data: redirectData, error: redirectError } = await supabase
        .from('redirects')
        .select('*')
        .eq('id', redirectId)
        .single();

      if (redirectError) {
        console.error('Error loading redirect:', redirectError);
        toast.error('Failed to load redirect details');
        return;
      }

      setRedirect(redirectData);

      // Load statistics from API
      await loadStatistics(redirectData.shortio_id);
    } catch (error) {
      console.error('Error loading redirect details:', error);
      toast.error('Failed to load redirect details');
    } finally {
      setLoading(false);
    }
  };

  const loadStatistics = async (shortioId: string) => {
    setStatsLoading(true);
    try {
      // Call API to get detailed statistics
      const response = await fetch(
        `${import.meta.env.VITE_API_BASE_URL}/api/redirects/${shortioId}/statistics?domain=${shortIoDomain}`
      );

      if (!response.ok) {
        if (response.status === 404) {
          // No statistics available yet
          console.log('No statistics available for this link');
          return;
        }
        throw new Error('Failed to load statistics');
      }

      const stats = await response.json();
      setStatistics(stats);
    } catch (error) {
      console.error('Error loading statistics:', error);
      // Don't show error toast for stats - they might not be available
    } finally {
      setStatsLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatShortDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });
  };

  // Chart configuration for clicks over time
  const clicksChartOptions: ApexOptions = {
    chart: {
      type: 'area',
      height: 350,
      toolbar: {
        show: true
      },
      zoom: {
        enabled: true
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
      categories: statistics?.clicksByDate.map(d => d.date) || [],
      labels: {
        format: 'MMM dd',
        datetimeUTC: false
      }
    },
    yaxis: {
      title: {
        text: 'Clicks'
      },
      labels: {
        formatter: (value) => Math.floor(value).toString()
      }
    },
    tooltip: {
      x: {
        format: 'MMM dd, yyyy'
      },
      y: {
        formatter: (value) => `${Math.floor(value)} clicks`
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
    colors: ['#3b82f6', '#10b981'],
    grid: {
      borderColor: '#e5e7eb',
      strokeDashArray: 4
    },
    legend: {
      position: 'top'
    }
  };

  const clicksChartSeries = [
    {
      name: 'Total Clicks',
      data: statistics?.clicksByDate.map(d => d.clicks) || []
    },
    {
      name: 'Human Clicks',
      data: statistics?.clicksByDate.map(d => d.humanClicks) || []
    }
  ];

  // Browser chart options
  const browserChartOptions: ApexOptions = {
    chart: {
      type: 'donut',
      height: 300,
    },
    labels: statistics?.browsers.slice(0, 6).map(b => b.browser) || [],
    colors: ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'],
    legend: {
      position: 'bottom'
    },
    plotOptions: {
      pie: {
        donut: {
          size: '60%',
          labels: {
            show: true,
            total: {
              show: true,
              label: 'Total',
              formatter: () => statistics?.browsers.reduce((sum, b) => sum + b.count, 0).toString() || '0'
            }
          }
        }
      }
    },
    dataLabels: {
      enabled: true,
      formatter: (val: number) => `${val.toFixed(1)}%`
    }
  };

  const browserChartSeries = statistics?.browsers.slice(0, 6).map(b => b.count) || [];

  // Device chart options
  const deviceChartOptions: ApexOptions = {
    chart: {
      type: 'bar',
      height: 300,
      toolbar: { show: false }
    },
    plotOptions: {
      bar: {
        horizontal: true,
        distributed: true,
        dataLabels: { position: 'bottom' }
      }
    },
    colors: ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6'],
    dataLabels: {
      enabled: true,
      formatter: (val: any) => val.toString(),
      style: { colors: ['#fff'], fontSize: '11px' }
    },
    xaxis: {
      categories: statistics?.devices.map(d => d.device) || [],
    },
    yaxis: { labels: { style: { fontSize: '11px' } } },
    legend: { show: false }
  };

  const deviceChartSeries = [{
    name: 'Clicks',
    data: statistics?.devices.map(d => d.count) || []
  }];

  // Country chart options
  const countryChartOptions: ApexOptions = {
    chart: {
      type: 'treemap',
      height: 350,
      toolbar: { show: false }
    },
    colors: ['#10B981'],
    plotOptions: {
      treemap: {
        distributed: false,
        enableShades: true,
        shadeIntensity: 0.5
      }
    },
    dataLabels: {
      enabled: true,
      style: { fontSize: '12px', colors: ['#fff'] },
      formatter: function(text: any, opts: any) {
        const data = statistics?.countries.find(d => d.country === text);
        return [text, `${data?.count || 0} clicks`];
      }
    }
  };

  const countryTreemapSeries = [{
    data: statistics?.countries.slice(0, 20).map(d => ({ x: d.country, y: d.count })) || []
  }];

  // Referrer chart options
  const referrerChartOptions: ApexOptions = {
    chart: {
      type: 'bar',
      height: 350,
      toolbar: { show: false }
    },
    plotOptions: {
      bar: {
        horizontal: true,
        distributed: true,
        dataLabels: { position: 'bottom' }
      }
    },
    colors: ['#8B5CF6', '#7C3AED', '#6D28D9', '#5B21B6', '#4C1D95', '#A78BFA', '#C4B5FD', '#DDD6FE', '#EDE9FE', '#F5F3FF'],
    dataLabels: {
      enabled: true,
      formatter: (val: any) => val.toString(),
      style: { colors: ['#fff'], fontSize: '11px' }
    },
    xaxis: {
      categories: statistics?.referrers.slice(0, 10).map(r =>
        r.referrer.length > 40 ? r.referrer.substring(0, 40) + '...' : r.referrer
      ) || [],
    },
    yaxis: { labels: { style: { fontSize: '11px' } } },
    legend: { show: false },
    tooltip: {
      y: { formatter: (val: number) => `${val} clicks` }
    }
  };

  const referrerChartSeries = [{
    name: 'Clicks',
    data: statistics?.referrers.slice(0, 10).map(r => r.count) || []
  }];

  if (loading) {
    return (
      <Page title="Redirect Details">
        <div className="p-6 flex items-center justify-center h-64">
          <div className="text-neutral-500">Loading redirect details...</div>
        </div>
      </Page>
    );
  }

  if (!redirect) {
    return (
      <Page title="Redirect Not Found">
        <div className="p-6">
          <div className="text-center py-12">
            <h3 className="text-lg font-medium text-gray-900 dark:text-white">Redirect not found</h3>
            <Button onClick={() => navigate('/admin/redirects')} className="mt-4">
              Back to Redirects
            </Button>
          </div>
        </div>
      </Page>
    );
  }

  const shortUrl = redirect.secure_short_url || redirect.short_url;

  return (
    <Page title={`Redirect Details - /${redirect.path}`}>
      <div className="p-6 space-y-6">
        {/* Back Button */}
        <div>
          <Button
            onClick={() => navigate('/admin/redirects')}
            variant="outlined"
            className="gap-2"
          >
            <ArrowLeftIcon className="size-4" />
            Back to Redirects
          </Button>
        </div>

        {/* Header */}
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold text-[var(--gray-12)] font-mono">
                /{redirect.path}
              </h1>
              <Badge color={redirect.archived ? 'warning' : 'success'} variant="soft">
                {redirect.archived ? 'Archived' : 'Active'}
              </Badge>
            </div>
            <div className="flex items-center gap-4 mt-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">{shortUrl}</span>
                <Button isIcon variant="ghost" onClick={() => copyToClipboard(shortUrl)} title="Copy short URL">
                  <ClipboardDocumentIcon className="h-4 w-4" />
                </Button>
                <a
                  href={shortUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1 hover:bg-gray-100 rounded"
                  title="Open short URL"
                >
                  <ArrowTopRightOnSquareIcon className="h-4 w-4 text-gray-400" />
                </a>
              </div>
            </div>
            <div className="flex items-center gap-4 mt-2 text-sm text-gray-600 dark:text-gray-400">
              <span className="flex items-center gap-1">
                <CalendarIcon className="size-4" />
                Created: {formatDate(redirect.shortio_created_at)}
              </span>
              <span>Last updated: {formatDate(redirect.updated_at)}</span>
            </div>
          </div>
          <Button
            onClick={loadRedirectDetails}
            variant="outlined"
            className="gap-2"
            disabled={loading || statsLoading}
          >
            <ArrowPathIcon className={`size-4 ${(loading || statsLoading) ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Destination URL */}
        <Card variant="surface" className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="text-xs font-medium text-neutral-500 uppercase mb-1">Destination URL</div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-700 dark:text-gray-300 break-all">
                  {redirect.original_url}
                </span>
                <a
                  href={redirect.original_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1 hover:bg-gray-100 rounded flex-shrink-0"
                  title="Open destination"
                >
                  <ArrowTopRightOnSquareIcon className="h-4 w-4 text-gray-400" />
                </a>
              </div>
            </div>
          </div>
          {redirect.title && (
            <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
              <div className="text-xs font-medium text-neutral-500 uppercase mb-1">Title</div>
              <div className="text-sm text-gray-700 dark:text-gray-300">{redirect.title}</div>
            </div>
          )}
          {redirect.tags && redirect.tags.length > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
              <div className="text-xs font-medium text-neutral-500 uppercase mb-2">Tags</div>
              <div className="flex flex-wrap gap-2">
                {redirect.tags.map((tag, i) => (
                  <Badge key={i} color="secondary" variant="soft">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </Card>

        {/* Summary Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card variant="surface" className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary-100 rounded-lg">
                <CursorArrowRaysIcon className="h-5 w-5 text-primary-600" />
              </div>
              <div>
                <div className="text-xs font-medium text-neutral-500 uppercase">Total Clicks</div>
                <div className="text-2xl font-bold text-primary-600">
                  {(statistics?.totalClicks || redirect.total_clicks).toLocaleString()}
                </div>
              </div>
            </div>
          </Card>
          <Card variant="surface" className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-success-100 rounded-lg">
                <ChartBarIcon className="h-5 w-5 text-success-600" />
              </div>
              <div>
                <div className="text-xs font-medium text-neutral-500 uppercase">Unique Clicks</div>
                <div className="text-2xl font-bold text-success-600">
                  {(statistics?.uniqueClicks || redirect.unique_clicks).toLocaleString()}
                </div>
              </div>
            </div>
          </Card>
          <Card variant="surface" className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-info-100 rounded-lg">
                <ChartBarIcon className="h-5 w-5 text-info-600" />
              </div>
              <div>
                <div className="text-xs font-medium text-neutral-500 uppercase">Human Clicks</div>
                <div className="text-2xl font-bold text-info-600">
                  {(statistics?.humanClicks || redirect.human_clicks).toLocaleString()}
                </div>
              </div>
            </div>
          </Card>
          <Card variant="surface" className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <GlobeAltIcon className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <div className="text-xs font-medium text-neutral-500 uppercase">Countries</div>
                <div className="text-2xl font-bold text-purple-600">
                  {statistics?.countries.length || 0}
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Clicks Over Time Chart */}
        {statistics?.clicksByDate && statistics.clicksByDate.length > 0 && (
          <Card variant="surface" className="p-6">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <ChartBarIcon className="size-5" />
                Clicks Over Time
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Daily click trends for this redirect
              </p>
            </div>
            <ReactApexChart
              options={clicksChartOptions}
              series={clicksChartSeries}
              type="area"
              height={300}
            />
          </Card>
        )}

        {/* Browser and Device Charts */}
        {statistics && (statistics.browsers.length > 0 || statistics.devices.length > 0) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Browsers */}
            {statistics.browsers.length > 0 && (
              <Card variant="surface" className="p-6">
                <div className="flex items-center gap-2 mb-4">
                  <ComputerDesktopIcon className="size-5 text-gray-500" />
                  <h4 className="text-lg font-semibold text-gray-900 dark:text-white">Browsers</h4>
                </div>
                <ReactApexChart
                  options={browserChartOptions}
                  series={browserChartSeries}
                  type="donut"
                  height={300}
                />
              </Card>
            )}

            {/* Devices */}
            {statistics.devices.length > 0 && (
              <Card variant="surface" className="p-6">
                <div className="flex items-center gap-2 mb-4">
                  <DevicePhoneMobileIcon className="size-5 text-gray-500" />
                  <h4 className="text-lg font-semibold text-gray-900 dark:text-white">Devices</h4>
                </div>
                <ReactApexChart
                  options={deviceChartOptions}
                  series={deviceChartSeries}
                  type="bar"
                  height={300}
                />
              </Card>
            )}
          </div>
        )}

        {/* Geographic Distribution */}
        {statistics?.countries && statistics.countries.length > 0 && (
          <Card variant="surface" className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <MapPinIcon className="size-5 text-gray-500" />
              <h4 className="text-lg font-semibold text-gray-900 dark:text-white">
                Geographic Distribution
              </h4>
              <span className="text-sm font-normal text-gray-500">
                ({statistics.countries.length} countries)
              </span>
            </div>
            <ReactApexChart
              options={countryChartOptions}
              series={countryTreemapSeries}
              type="treemap"
              height={350}
            />
          </Card>
        )}

        {/* Referrers */}
        {statistics?.referrers && statistics.referrers.length > 0 && (
          <Card variant="surface" className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <LinkIcon className="size-5 text-gray-500" />
              <h4 className="text-lg font-semibold text-gray-900 dark:text-white">
                Top Referrers
              </h4>
              <span className="text-sm font-normal text-gray-500">
                (showing top 10)
              </span>
            </div>
            <ReactApexChart
              options={referrerChartOptions}
              series={referrerChartSeries}
              type="bar"
              height={350}
            />
          </Card>
        )}

        {/* No Statistics Message */}
        {!statsLoading && !statistics && (
          <Card variant="surface" className="p-12">
            <div className="text-center">
              <ChartBarIcon className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                No statistics available yet
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                Detailed statistics will appear once the link receives clicks and the statistics API is configured.
              </p>
            </div>
          </Card>
        )}

        {/* Loading Statistics */}
        {statsLoading && (
          <Card variant="surface" className="p-12">
            <div className="text-center">
              <ArrowPathIcon className="mx-auto h-12 w-12 text-gray-400 animate-spin" />
              <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                Loading statistics...
              </h3>
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}
