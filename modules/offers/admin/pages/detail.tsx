import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import ReactApexChart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';
import { MapContainer, TileLayer, CircleMarker, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  GiftIcon,
  MapIcon,
  BriefcaseIcon,
  BuildingOfficeIcon,
  GlobeAltIcon,
  ArrowDownTrayIcon,
  UsersIcon,
  FunnelIcon,
  XMarkIcon,
  DocumentIcon,
  PlusIcon,
  TrashIcon,
  CloudArrowUpIcon,
  EyeIcon,
  EyeSlashIcon,
} from '@heroicons/react/24/outline';
import { Card, Button, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { ScrollableTable } from '@/components/shared/table/ScrollableTable';
import { RowActions } from '@/components/shared/table/RowActions';
import { Page } from '@/components/shared/Page';
import { ActiveOfferService as OfferService, ActiveHybridOfferService as HybridOfferService } from '@/utils/serviceSwitcher';
import { OfferSummary } from '@/utils/offerService';
import { OfferResourceService, OfferResource } from '@/utils/offerResourceService';

interface AcceptedData {
  date: string;
  count: number;
  cumulative: number;
}

interface LocationData {
  country: string;
  city: string;
  lat: number;
  lng: number;
  count: number;
}

interface JobTitleData {
  title: string;
  count: number;
}

interface CompanyData {
  company: string;
  count: number;
}

interface CountryData {
  country: string;
  count: number;
}

interface AcceptedMember {
  email: string;
  first_name: string | null;
  last_name: string | null;
  job_title: string | null;
  company: string | null;
  city: string | null;
  country: string | null;
  accepted_at: string;
}

type DateFilterMode = 'all' | 'after' | 'between';

export default function OfferDetailPage() {
  const { eventId: offerId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();

  const [offer, setOffer] = useState<OfferSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [isDownloading, setIsDownloading] = useState(false);
  const [acceptedData, setAcceptedData] = useState<AcceptedData[]>([]);
  const [geographicData, setGeographicData] = useState<LocationData[]>([]);
  const [jobTitleData, setJobTitleData] = useState<JobTitleData[]>([]);
  const [companyData, setCompanyData] = useState<CompanyData[]>([]);
  const [countryData, setCountryData] = useState<CountryData[]>([]);

  // Members table state
  const [acceptedMembers, setAcceptedMembers] = useState<AcceptedMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [dateFilterMode, setDateFilterMode] = useState<DateFilterMode>('all');
  const [filterStartDate, setFilterStartDate] = useState<string>('');
  const [filterEndDate, setFilterEndDate] = useState<string>('');
  const [selectedJobTitles, setSelectedJobTitles] = useState<string[]>([]);
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [membersPage, setMembersPage] = useState(0);
  const MEMBERS_PER_PAGE = 25;

  // Resources state
  const [resources, setResources] = useState<OfferResource[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [showAddResource, setShowAddResource] = useState(false);
  const [uploadingResource, setUploadingResource] = useState(false);
  const [newResourceName, setNewResourceName] = useState('');
  const [newResourceDescription, setNewResourceDescription] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  useEffect(() => {
    if (offerId) {
      loadOfferDetails();
    }
  }, [offerId]);

  const loadOfferDetails = async () => {
    setLoading(true);
    try {
      const decodedOfferId = decodeURIComponent(offerId!);

      // Load offer summary
      const offerSummary = await OfferService.getOfferById(decodedOfferId);
      if (offerSummary) {
        setOffer(offerSummary);

        // Load all data in parallel
        await Promise.all([
          loadAcceptedTimeline(decodedOfferId),
          loadGeographicData(decodedOfferId),
          loadJobTitleData(decodedOfferId),
          loadCompanyData(decodedOfferId),
          loadCountryData(decodedOfferId),
          loadAcceptedMembers(decodedOfferId),
          loadResources(decodedOfferId),
        ]);
      }
    } catch (error) {
      console.error('Error loading offer details:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadAcceptedTimeline = async (offerIdValue: string) => {
    try {
      const timeline = await OfferService.getAcceptedTimeline(offerIdValue);
      setAcceptedData(timeline);
    } catch (error) {
      console.error('Error loading accepted timeline:', error);
    }
  };

  const loadGeographicData = async (offerIdValue: string) => {
    try {
      const geoData = await HybridOfferService.getGeographicDistribution(offerIdValue);
      setGeographicData(geoData.accepted);
    } catch (error) {
      console.error('Error loading geographic data:', error);
    }
  };

  const loadJobTitleData = async (offerIdValue: string) => {
    try {
      const data = await HybridOfferService.getJobTitleBreakdown(offerIdValue);
      setJobTitleData(data);
    } catch (error) {
      console.error('Error loading job title data:', error);
    }
  };

  const loadCompanyData = async (offerIdValue: string) => {
    try {
      const data = await HybridOfferService.getCompanyBreakdown(offerIdValue);
      setCompanyData(data);
    } catch (error) {
      console.error('Error loading company data:', error);
    }
  };

  const loadCountryData = async (offerIdValue: string) => {
    try {
      const data = await HybridOfferService.getCountryBreakdown(offerIdValue);
      setCountryData(data);
    } catch (error) {
      console.error('Error loading country data:', error);
    }
  };

  const loadAcceptedMembers = async (offerIdValue: string) => {
    setMembersLoading(true);
    try {
      const members = await HybridOfferService.getAcceptedMembersWithTimestamps(offerIdValue);
      setAcceptedMembers(members);
      setMembersPage(0); // Reset to first page when data reloads
    } catch (error) {
      console.error('Error loading accepted members:', error);
    } finally {
      setMembersLoading(false);
    }
  };

  const loadResources = async (offerIdValue: string) => {
    setResourcesLoading(true);
    try {
      const data = await OfferResourceService.getResourcesForOffer(offerIdValue);
      setResources(data);
    } catch (error) {
      console.error('Error loading resources:', error);
    } finally {
      setResourcesLoading(false);
    }
  };

  const handleUploadResource = async () => {
    if (!selectedFile || !newResourceName || !offerId) return;

    setUploadingResource(true);
    try {
      const decodedOfferId = decodeURIComponent(offerId);
      await OfferResourceService.uploadAndCreateResource(
        decodedOfferId,
        selectedFile,
        newResourceName,
        newResourceDescription || undefined
      );

      // Reload resources and reset form
      await loadResources(decodedOfferId);
      setShowAddResource(false);
      setNewResourceName('');
      setNewResourceDescription('');
      setSelectedFile(null);
    } catch (error) {
      console.error('Error uploading resource:', error);
      alert('Failed to upload resource. Please try again.');
    } finally {
      setUploadingResource(false);
    }
  };

  const handleToggleResourceActive = async (resourceId: string) => {
    try {
      await OfferResourceService.toggleActive(resourceId);
      if (offerId) {
        await loadResources(decodeURIComponent(offerId));
      }
    } catch (error) {
      console.error('Error toggling resource:', error);
      alert('Failed to update resource.');
    }
  };

  const handleDeleteResource = async (resourceId: string, deleteFile: boolean = false) => {
    if (!confirm('Are you sure you want to delete this resource?')) return;

    try {
      await OfferResourceService.deleteResource(resourceId, deleteFile);
      if (offerId) {
        await loadResources(decodeURIComponent(offerId));
      }
    } catch (error) {
      console.error('Error deleting resource:', error);
      alert('Failed to delete resource.');
    }
  };

  // Filter members based on date, job title, and country filters
  const filteredMembers = useMemo(() => {
    return acceptedMembers.filter(member => {
      // Date filter
      if (dateFilterMode !== 'all') {
        const acceptedDate = new Date(member.accepted_at);

        if (dateFilterMode === 'after' && filterStartDate) {
          const startDate = new Date(filterStartDate);
          startDate.setHours(0, 0, 0, 0);
          if (acceptedDate < startDate) return false;
        }

        if (dateFilterMode === 'between' && filterStartDate && filterEndDate) {
          const startDate = new Date(filterStartDate);
          startDate.setHours(0, 0, 0, 0);
          const endDate = new Date(filterEndDate);
          endDate.setHours(23, 59, 59, 999);
          if (acceptedDate < startDate || acceptedDate > endDate) return false;
        }
      }

      // Job title filter
      if (selectedJobTitles.length > 0) {
        const memberJobTitle = member.job_title || 'Unknown';
        if (!selectedJobTitles.includes(memberJobTitle)) return false;
      }

      // Country filter
      if (selectedCountries.length > 0) {
        const memberCountry = member.country || 'Unknown';
        if (!selectedCountries.includes(memberCountry)) return false;
      }

      return true;
    });
  }, [acceptedMembers, dateFilterMode, filterStartDate, filterEndDate, selectedJobTitles, selectedCountries]);

  // Paginated members
  const paginatedMembers = useMemo(() => {
    const start = membersPage * MEMBERS_PER_PAGE;
    return filteredMembers.slice(start, start + MEMBERS_PER_PAGE);
  }, [filteredMembers, membersPage]);

  const totalPages = Math.ceil(filteredMembers.length / MEMBERS_PER_PAGE);

  const clearFilters = () => {
    setDateFilterMode('all');
    setFilterStartDate('');
    setFilterEndDate('');
    setSelectedJobTitles([]);
    setSelectedCountries([]);
    setMembersPage(0);
  };

  const hasActiveFilters = dateFilterMode !== 'all' || selectedJobTitles.length > 0 || selectedCountries.length > 0;

  const formatMemberDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const handleDownloadCSV = () => {
    if (!offerId || filteredMembers.length === 0) {
      alert('No members to download');
      return;
    }

    setIsDownloading(true);
    try {
      const decodedOfferId = decodeURIComponent(offerId);

      // Convert filtered members to CSV format
      const headers = ['Email', 'First Name', 'Last Name', 'Job Title', 'Company', 'City', 'Country', 'Accepted At'];
      const csvRows = [headers.join(',')];

      filteredMembers.forEach(member => {
        const row = [
          member.email || '',
          member.first_name || '',
          member.last_name || '',
          member.job_title || '',
          member.company || '',
          member.city || '',
          member.country || '',
          member.accepted_at ? new Date(member.accepted_at).toISOString() : '',
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

      // Include filter info in filename if filtering is active
      let filename = `${decodedOfferId.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_accepted`;
      if (dateFilterMode === 'after' && filterStartDate) {
        filename += `_after_${filterStartDate}`;
      } else if (dateFilterMode === 'between' && filterStartDate && filterEndDate) {
        filename += `_${filterStartDate}_to_${filterEndDate}`;
      }
      if (selectedJobTitles.length > 0) {
        filename += `_${selectedJobTitles.length}titles`;
      }
      if (selectedCountries.length > 0) {
        filename += `_${selectedCountries.length}countries`;
      }
      filename += `_${new Date().toISOString().split('T')[0]}.csv`;

      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      link.style.visibility = 'hidden';

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Error downloading CSV:', error);
      alert('Failed to download CSV. Please try again.');
    } finally {
      setIsDownloading(false);
    }
  };

  const formatDate = (dateStr?: string) => {
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

  // Map configuration
  const mapConfig = useMemo(() => {
    if (geographicData.length === 0) {
      return {
        center: [20, 0] as [number, number],
        zoom: 2
      };
    }

    const lats = geographicData.map(d => d.lat);
    const lngs = geographicData.map(d => d.lng);

    const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;

    const latDiff = Math.max(...lats) - Math.min(...lats);
    const lngDiff = Math.max(...lngs) - Math.min(...lngs);
    const maxDiff = Math.max(latDiff, lngDiff);

    let zoom = 2;
    if (maxDiff < 1) zoom = 10;
    else if (maxDiff < 5) zoom = 7;
    else if (maxDiff < 10) zoom = 5;
    else if (maxDiff < 50) zoom = 3;

    return {
      center: [centerLat, centerLng] as [number, number],
      zoom
    };
  }, [geographicData]);

  const totalGeoCount = useMemo(() =>
    geographicData.reduce((sum, loc) => sum + loc.count, 0),
    [geographicData]
  );

  const getMarkerRadius = (count: number) => {
    const percentage = (count / totalGeoCount) * 100;
    return Math.max(5, Math.min(40, Math.sqrt(percentage) * 8));
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
      categories: acceptedData.map(d => d.date),
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
    colors: ['#3b82f6'],
    grid: {
      borderColor: '#e5e7eb',
      strokeDashArray: 4
    }
  };

  const chartSeries = [{
    name: 'Cumulative Acceptances',
    data: acceptedData.map(d => d.cumulative)
  }];

  const perMinuteChartOptions: ApexOptions = {
    chart: {
      type: 'bar',
      height: 300,
      toolbar: {
        show: true
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
      categories: acceptedData.map(d => d.date),
      labels: {
        format: 'MMM dd HH:mm',
        datetimeUTC: false
      }
    },
    yaxis: {
      title: {
        text: 'Acceptances per Minute'
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
    colors: ['#10b981'],
    grid: {
      borderColor: '#e5e7eb',
      strokeDashArray: 4
    }
  };

  const perMinuteChartSeries = [{
    name: 'Acceptances per Minute',
    data: acceptedData.map(d => d.count)
  }];

  // Job title bar chart options
  const jobTitleChartOptions: ApexOptions = {
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
      categories: jobTitleData.slice(0, 10).map(d => d.title.length > 30 ? d.title.substring(0, 30) + '...' : d.title),
      labels: { style: { fontSize: '11px' } }
    },
    yaxis: { labels: { style: { fontSize: '11px' } } },
    tooltip: {
      y: { formatter: (val: number) => `${val} people` }
    }
  };

  const jobTitleChartSeries = [{
    name: 'Count',
    data: jobTitleData.slice(0, 10).map(d => d.count)
  }];

  // Company bar chart options
  const companyChartOptions: ApexOptions = {
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
    colors: ['#3B82F6', '#2563EB', '#1D4ED8', '#1E40AF', '#1E3A8A', '#60A5FA', '#93C5FD', '#BFDBFE', '#DBEAFE', '#EFF6FF'],
    dataLabels: {
      enabled: true,
      formatter: (val: any) => val.toString(),
      style: { colors: ['#fff'], fontSize: '11px' }
    },
    xaxis: {
      categories: companyData.slice(0, 10).map(d => d.company.length > 30 ? d.company.substring(0, 30) + '...' : d.company),
      labels: { style: { fontSize: '11px' } }
    },
    yaxis: { labels: { style: { fontSize: '11px' } } },
    tooltip: {
      y: { formatter: (val: number) => `${val} people` }
    }
  };

  const companyChartSeries = [{
    name: 'Count',
    data: companyData.slice(0, 10).map(d => d.count)
  }];

  // Country treemap options
  const countryTreemapOptions: ApexOptions = {
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
        const data = countryData.find(d => d.country === text);
        return [text, `${data?.count || 0} people`];
      }
    }
  };

  const countryTreemapSeries = [{
    data: countryData.map(d => ({ x: d.country, y: d.count }))
  }];

  if (loading) {
    return (
      <Page title="Offer Details">
        <div className="p-6 flex items-center justify-center h-64">
          <div className="text-neutral-500">Loading offer details...</div>
        </div>
      </Page>
    );
  }

  if (!offer) {
    return (
      <Page title="Offer Not Found">
        <div className="p-6">
          <div className="text-center py-12">
            <h3 className="text-lg font-medium text-gray-900 dark:text-white">Offer not found</h3>
            <Button onClick={() => navigate('/offers')} className="mt-4">
              Back to Offers
            </Button>
          </div>
        </div>
      </Page>
    );
  }

  const uniqueCountries = new Set(geographicData.map(d => d.country)).size;
  const uniqueCities = geographicData.length;
  const topLocation = geographicData[0];

  return (
    <Page title={`Offer Details - ${offer.offer_id}`}>
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
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <h1 className="text-2xl font-semibold text-[var(--gray-12)] font-mono">
              {offer.offer_id}
            </h1>
            <div className="flex items-center gap-4 mt-2 text-sm text-gray-600 dark:text-gray-400">
              <span>First seen: {formatDate(offer.first_interaction)}</span>
              <span>Last activity: {formatDate(offer.last_interaction)}</span>
            </div>
          </div>
          <Button
            onClick={loadOfferDetails}
            variant="outline"

          >
            <ArrowPathIcon className="size-4" />
            Refresh
          </Button>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card variant="surface" className="p-4">
            <div className="text-xs font-medium text-neutral-500 uppercase">Total Accepted</div>
            <div className="text-2xl font-bold mt-1 text-blue-600">{offer.accepted_count.toLocaleString()}</div>
          </Card>
          <Card variant="surface" className="p-4">
            <div className="text-xs font-medium text-neutral-500 uppercase">Countries</div>
            <div className="text-2xl font-bold mt-1">{countryData.length}</div>
          </Card>
          <Card variant="surface" className="p-4">
            <div className="text-xs font-medium text-neutral-500 uppercase">Companies</div>
            <div className="text-2xl font-bold mt-1">{companyData.filter(c => c.company !== 'Unknown').length}</div>
          </Card>
          <Card variant="surface" className="p-4">
            <div className="text-xs font-medium text-neutral-500 uppercase">Job Titles</div>
            <div className="text-2xl font-bold mt-1">{jobTitleData.filter(j => j.title !== 'Unknown').length}</div>
          </Card>
        </div>

        {/* Downloadable Resources Section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <DocumentIcon className="size-5" />
              Downloadable Resources
              <span className="text-sm font-normal text-gray-500">
                ({resources.length})
              </span>
            </h3>
            <Button
              onClick={() => setShowAddResource(!showAddResource)}
              variant="outline"
              size="sm"
  
            >
              <PlusIcon className="size-4" />
              Add Resource
            </Button>
          </div>

          {/* Add Resource Form */}
          {showAddResource && (
            <Card variant="surface" className="p-4">
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">Add New Resource</h4>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Resource Name *
                  </label>
                  <input
                    type="text"
                    value={newResourceName}
                    onChange={(e) => setNewResourceName(e.target.value)}
                    placeholder="e.g., Data Contracts eBook"
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 dark:bg-gray-800 dark:border-gray-600 dark:text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Description (optional)
                  </label>
                  <input
                    type="text"
                    value={newResourceDescription}
                    onChange={(e) => setNewResourceDescription(e.target.value)}
                    placeholder="Brief description of the resource"
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 dark:bg-gray-800 dark:border-gray-600 dark:text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    File *
                  </label>
                  <div className="flex items-center gap-4">
                    <input
                      type="file"
                      accept=".pdf,.zip,.epub"
                      onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                      className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100 dark:file:bg-gray-700 dark:file:text-gray-200"
                    />
                  </div>
                  {selectedFile && (
                    <p className="mt-1 text-xs text-gray-500">
                      Selected: {selectedFile.name} ({OfferResourceService.formatFileSize(selectedFile.size)})
                    </p>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    onClick={() => {
                      setShowAddResource(false);
                      setNewResourceName('');
                      setNewResourceDescription('');
                      setSelectedFile(null);
                    }}
                    variant="outline"
                    size="sm"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleUploadResource}
                    disabled={!selectedFile || !newResourceName || uploadingResource}
                    size="sm"
        
                  >
                    <CloudArrowUpIcon className="size-4" />
                    {uploadingResource ? 'Uploading...' : 'Upload Resource'}
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {/* Resources List */}
          <Card variant="surface" className="overflow-hidden">
            {resourcesLoading ? (
              <div className="p-8 text-center text-neutral-500">Loading resources...</div>
            ) : resources.length === 0 ? (
              <div className="p-8 text-center">
                <DocumentIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                  No resources yet
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  Add downloadable files like PDFs or eBooks for this offer.
                </p>
              </div>
            ) : (
              <ScrollableTable>
              <Table>
                <THead>
                  <Tr>
                    <Th data-sticky-left style={{ position: 'sticky', left: 0, zIndex: 20, background: 'var(--color-panel-solid)' }}>Resource</Th>
                    <Th>File ID</Th>
                    <Th>Size</Th>
                    <Th>Downloads</Th>
                    <Th>Status</Th>
                    <Th data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 2 }} />
                  </Tr>
                </THead>
                <TBody>
                  {resources.map((resource) => (
                    <Tr key={resource.id}>
                      <Td data-sticky-left style={{ position: 'sticky', left: 0, zIndex: 10, background: 'var(--color-panel-solid)' }}>
                        <div>
                          <div className="text-sm font-medium">
                            {resource.name}
                          </div>
                          {resource.description && (
                            <div className="text-xs text-[var(--gray-a11)]">
                              {resource.description}
                            </div>
                          )}
                          <div className="text-xs text-[var(--gray-a11)] font-mono">
                            {resource.download_filename}
                          </div>
                        </div>
                      </Td>
                      <Td>
                        <code className="text-xs bg-[var(--gray-a3)] px-2 py-1 rounded">
                          {resource.file_id}
                        </code>
                      </Td>
                      <Td>
                        {OfferResourceService.formatFileSize(resource.file_size_bytes)}
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <ArrowDownTrayIcon className="size-4 text-gray-400" />
                          <span className="text-sm font-semibold">
                            {resource.download_count.toLocaleString()}
                          </span>
                        </div>
                      </Td>
                      <Td>
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          resource.is_active
                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                            : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                        }`}>
                          {resource.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </Td>
                      <Td data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 1 }}>
                        <RowActions actions={[
                          {
                            label: resource.is_active ? 'Disable' : 'Enable',
                            icon: resource.is_active ? <EyeSlashIcon className="size-4" /> : <EyeIcon className="size-4" />,
                            onClick: () => handleToggleResourceActive(resource.id),
                          },
                          {
                            label: 'Delete',
                            icon: <TrashIcon className="size-4" />,
                            onClick: () => handleDeleteResource(resource.id, true),
                            color: 'red',
                          },
                        ]} />
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
              </ScrollableTable>
            )}
          </Card>
        </div>

        {/* Timeline Charts */}
        {acceptedData.length > 0 && (
          <div className="space-y-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Acceptance Timeline</h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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
                  options={chartOptions}
                  series={chartSeries}
                  type="area"
                  height={300}
                />
              </Card>

              <Card variant="surface" className="p-6">
                <div className="mb-4">
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                    Acceptances per Minute
                  </h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    Number of offer acceptances per minute
                  </p>
                </div>
                <ReactApexChart
                  options={perMinuteChartOptions}
                  series={perMinuteChartSeries}
                  type="bar"
                  height={300}
                />
              </Card>
            </div>
          </div>
        )}

        {/* Geographic Distribution */}
        <div className="space-y-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <MapIcon className="size-5" />
            Geographic Distribution
          </h3>

          {/* Map */}
          <Card variant="surface" className="p-6">
            {geographicData.length > 0 ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Location Map</h4>
                  <span className="text-xs text-gray-500">{totalGeoCount} people with location data</span>
                </div>
                <div className="w-full h-96 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                  <MapContainer
                    center={mapConfig.center}
                    zoom={mapConfig.zoom}
                    style={{ height: '100%', width: '100%' }}
                    scrollWheelZoom={false}
                  >
                    <TileLayer
                      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    />
                    {geographicData.map((location, index) => (
                      <CircleMarker
                        key={index}
                        center={[location.lat, location.lng]}
                        radius={getMarkerRadius(location.count)}
                        fillColor="#3B82F6"
                        fillOpacity={0.6}
                        color="#3B82F6"
                        weight={2}
                      >
                        <Tooltip>
                          <div>
                            <strong>{location.city || 'Unknown City'}</strong>
                            <br />
                            {location.country || 'Unknown Country'}
                            <br />
                            Count: {location.count}
                            <br />
                            Percentage: {((location.count / totalGeoCount) * 100).toFixed(1)}%
                          </div>
                        </Tooltip>
                      </CircleMarker>
                    ))}
                  </MapContainer>
                </div>

                {/* Geographic Summary Stats */}
                <div className="grid grid-cols-3 gap-4 mt-4">
                  <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
                    <div className="text-xs font-medium text-gray-600 dark:text-gray-400 uppercase">Countries</div>
                    <div className="text-2xl font-bold mt-1">{uniqueCountries}</div>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
                    <div className="text-xs font-medium text-gray-600 dark:text-gray-400 uppercase">Locations</div>
                    <div className="text-2xl font-bold mt-1">{uniqueCities}</div>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
                    <div className="text-xs font-medium text-gray-600 dark:text-gray-400 uppercase">Top Location</div>
                    <div className="text-lg font-bold mt-1">
                      {topLocation ? (topLocation.city || 'Unknown') : 'N/A'}
                    </div>
                    {topLocation && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {topLocation.count} people ({((topLocation.count / totalGeoCount) * 100).toFixed(1)}%)
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-12">
                <MapIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                  No Geographic Data Available
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  Geographic distribution will appear once accepters have location data.
                </p>
              </div>
            )}
          </Card>

          {/* Country Treemap */}
          {countryData.length > 0 && (
            <Card variant="surface" className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <GlobeAltIcon className="size-5 text-gray-500" />
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Distribution by Country</h4>
              </div>
              <ReactApexChart
                options={countryTreemapOptions}
                series={countryTreemapSeries}
                type="treemap"
                height={350}
              />
            </Card>
          )}
        </div>

        {/* Demographics Section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Job Titles */}
          {jobTitleData.length > 0 && (
            <Card variant="surface" className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <BriefcaseIcon className="size-5 text-gray-500" />
                <h4 className="text-lg font-semibold text-gray-900 dark:text-white">Top Job Titles</h4>
              </div>
              <ReactApexChart
                options={jobTitleChartOptions}
                series={jobTitleChartSeries}
                type="bar"
                height={350}
              />
              {jobTitleData.length > 10 && (
                <p className="text-xs text-gray-500 mt-2 text-center">
                  Showing top 10 of {jobTitleData.length} job titles
                </p>
              )}
            </Card>
          )}

          {/* Companies */}
          {companyData.length > 0 && (
            <Card variant="surface" className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <BuildingOfficeIcon className="size-5 text-gray-500" />
                <h4 className="text-lg font-semibold text-gray-900 dark:text-white">Top Companies</h4>
              </div>
              <ReactApexChart
                options={companyChartOptions}
                series={companyChartSeries}
                type="bar"
                height={350}
              />
              {companyData.length > 10 && (
                <p className="text-xs text-gray-500 mt-2 text-center">
                  Showing top 10 of {companyData.length} companies
                </p>
              )}
            </Card>
          )}
        </div>

        {/* Accepted Members Table */}
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <UsersIcon className="size-5" />
              Accepted Members
              <span className="text-sm font-normal text-gray-500">
                ({filteredMembers.length.toLocaleString()} {hasActiveFilters ? 'filtered' : 'total'})
              </span>
            </h3>
          </div>

          {/* Filter Controls */}
          <Card variant="surface" className="p-4">
            <div className="space-y-4">
              {/* Date Filter Row */}
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <FunnelIcon className="size-4 text-gray-500" />
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Date:</span>
                </div>

                <select
                  value={dateFilterMode}
                  onChange={(e) => {
                    setDateFilterMode(e.target.value as DateFilterMode);
                    setMembersPage(0);
                  }}
                  className="block rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 dark:bg-gray-800 dark:border-gray-600 dark:text-white text-sm"
                >
                  <option value="all">All Time</option>
                  <option value="after">After Date</option>
                  <option value="between">Between Dates</option>
                </select>

                {dateFilterMode === 'after' && (
                  <div className="flex items-center gap-2">
                    <label className="text-sm text-gray-600 dark:text-gray-400">After:</label>
                    <input
                      type="date"
                      value={filterStartDate}
                      onChange={(e) => {
                        setFilterStartDate(e.target.value);
                        setMembersPage(0);
                      }}
                      className="block rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 dark:bg-gray-800 dark:border-gray-600 dark:text-white text-sm"
                    />
                  </div>
                )}

                {dateFilterMode === 'between' && (
                  <>
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-gray-600 dark:text-gray-400">From:</label>
                      <input
                        type="date"
                        value={filterStartDate}
                        onChange={(e) => {
                          setFilterStartDate(e.target.value);
                          setMembersPage(0);
                        }}
                        className="block rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 dark:bg-gray-800 dark:border-gray-600 dark:text-white text-sm"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-gray-600 dark:text-gray-400">To:</label>
                      <input
                        type="date"
                        value={filterEndDate}
                        onChange={(e) => {
                          setFilterEndDate(e.target.value);
                          setMembersPage(0);
                        }}
                        className="block rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 dark:bg-gray-800 dark:border-gray-600 dark:text-white text-sm"
                      />
                    </div>
                  </>
                )}
              </div>

              {/* Job Title and Country Multi-Select Row */}
              <div className="flex flex-wrap items-start gap-4">
                {/* Job Title Multi-Select */}
                <div className="flex-1 min-w-[200px]">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Job Titles {selectedJobTitles.length > 0 && `(${selectedJobTitles.length})`}
                  </label>
                  <div className="relative">
                    <select
                      multiple
                      value={selectedJobTitles}
                      onChange={(e) => {
                        const selected = Array.from(e.target.selectedOptions, option => option.value);
                        setSelectedJobTitles(selected);
                        setMembersPage(0);
                      }}
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 dark:bg-gray-800 dark:border-gray-600 dark:text-white text-sm"
                      style={{ minHeight: '80px', maxHeight: '120px' }}
                    >
                      {jobTitleData.map((item) => (
                        <option key={item.title} value={item.title}>
                          {item.title} ({item.count})
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">Hold Ctrl/Cmd to select multiple</p>
                </div>

                {/* Country Multi-Select */}
                <div className="flex-1 min-w-[200px]">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Countries {selectedCountries.length > 0 && `(${selectedCountries.length})`}
                  </label>
                  <div className="relative">
                    <select
                      multiple
                      value={selectedCountries}
                      onChange={(e) => {
                        const selected = Array.from(e.target.selectedOptions, option => option.value);
                        setSelectedCountries(selected);
                        setMembersPage(0);
                      }}
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 dark:bg-gray-800 dark:border-gray-600 dark:text-white text-sm"
                      style={{ minHeight: '80px', maxHeight: '120px' }}
                    >
                      {countryData.map((item) => (
                        <option key={item.country} value={item.country}>
                          {item.country} ({item.count})
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">Hold Ctrl/Cmd to select multiple</p>
                </div>
              </div>

              {/* Clear and Export Row */}
              <div className="flex items-center justify-between pt-2 border-t border-gray-200 dark:border-gray-700">
                <div>
                  {hasActiveFilters && (
                    <Button
                      variant="ghost"
                      onClick={clearFilters}
                    >
                      <XMarkIcon className="size-4" />
                      Clear All Filters
                    </Button>
                  )}
                </div>

                {/* Export CSV Button */}
                <Button
                  onClick={handleDownloadCSV}
                  disabled={isDownloading || filteredMembers.length === 0}
                  variant="outline"
                  size="sm"
      
                >
                  <ArrowDownTrayIcon className="size-4" />
                  {isDownloading ? 'Exporting...' : `Export CSV (${filteredMembers.length.toLocaleString()})`}
                </Button>
              </div>
            </div>
          </Card>

          {/* Members Table */}
          <Card variant="surface" className="overflow-hidden">
            {membersLoading ? (
              <div className="p-12 text-center">
                <div className="text-neutral-500">Loading members...</div>
              </div>
            ) : paginatedMembers.length > 0 ? (
              <>
                <div className="overflow-x-auto">
                  <Table>
                    <THead>
                      <Tr>
                        <Th>Name</Th>
                        <Th>Job Title</Th>
                        <Th>Company</Th>
                        <Th>Accepted At</Th>
                      </Tr>
                    </THead>
                    <TBody>
                      {paginatedMembers.map((member, index) => (
                        <Tr key={`${member.email}-${index}`}>
                          <Td>
                            <div>
                              <div className="text-sm font-medium">
                                {member.first_name || member.last_name
                                  ? `${member.first_name || ''} ${member.last_name || ''}`.trim()
                                  : <span className="text-[var(--gray-a11)] italic">Unknown</span>
                                }
                              </div>
                              <div className="text-xs text-[var(--gray-a11)]">
                                {member.email}
                              </div>
                            </div>
                          </Td>
                          <Td>
                            {member.job_title || <span className="text-[var(--gray-a11)] italic">-</span>}
                          </Td>
                          <Td>
                            {member.company || <span className="text-[var(--gray-a11)] italic">-</span>}
                          </Td>
                          <Td>
                            {formatMemberDate(member.accepted_at)}
                          </Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
                    <div className="text-sm text-gray-500">
                      Showing {membersPage * MEMBERS_PER_PAGE + 1} to{' '}
                      {Math.min((membersPage + 1) * MEMBERS_PER_PAGE, filteredMembers.length)} of{' '}
                      {filteredMembers.length.toLocaleString()} members
                    </div>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => setMembersPage(p => Math.max(0, p - 1))}
                        disabled={membersPage === 0}
                        variant="outline"
                        size="sm"
                      >
                        Previous
                      </Button>
                      <Button
                        onClick={() => setMembersPage(p => Math.min(totalPages - 1, p + 1))}
                        disabled={membersPage >= totalPages - 1}
                        variant="outline"
                        size="sm"
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-12">
                <UsersIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                  {acceptedMembers.length === 0 ? 'No accepted members' : 'No members match the filter'}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {acceptedMembers.length === 0
                    ? 'People will appear here once they accept the offer.'
                    : 'Try adjusting the filters to see more results.'}
                </p>
              </div>
            )}
          </Card>
        </div>

        {/* No Data Message */}
        {acceptedData.length === 0 && offer.accepted_count === 0 && (
          <Card variant="surface" className="p-12">
            <div className="text-center">
              <GiftIcon className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                No acceptances yet
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                This offer hasn't been accepted yet. Check back later.
              </p>
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}
