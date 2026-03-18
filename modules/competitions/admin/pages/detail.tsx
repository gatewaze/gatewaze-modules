import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import ReactApexChart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  UserGroupIcon,
  CalendarIcon,
  ClockIcon,
  TrophyIcon,
} from '@heroicons/react/24/outline';
import { Card, Button } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { EventService, Event } from '@/utils/eventService';
import { ActiveCompetitionService } from '@/utils/serviceSwitcher';
import { supabase } from '@/lib/supabase';

interface EntryData {
  date: string;
  count: number;
  cumulative: number;
}

export default function CompetitionDetailPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();

  const [competition, setCompetition] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [entryData, setEntryData] = useState<EntryData[]>([]);
  const [totalEntries, setTotalEntries] = useState(0);
  const [winnerCount, setWinnerCount] = useState(0);

  useEffect(() => {
    if (eventId) {
      loadCompetitionDetails();
    }
  }, [eventId]);

  const loadCompetitionDetails = async () => {
    setLoading(true);
    try {
      // Load competition event
      const eventResult = await EventService.getEventById(eventId!);
      if (eventResult.success && eventResult.data) {
        setCompetition(eventResult.data);

        // Load entry timeline data
        if (eventResult.data.offerSlug) {
          await loadEntryTimeline(eventResult.data.offerSlug);
        }

        // Load winner count
        await loadWinnerCount(eventResult.data.eventId);
      }
    } catch (error) {
      console.error('Error loading competition details:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadEntryTimeline = async (offerSlug: string) => {
    try {
      console.log('Loading entries for competition:', offerSlug);

      // Use the unified competition service which handles both tracking modes
      const timeline = await ActiveCompetitionService.getEntryTimeline(offerSlug);

      if (timeline.length === 0) {
        console.log('No entries found for competition:', offerSlug);
        setEntryData([]);
        setTotalEntries(0);
        return;
      }

      // Get the total count from the last timeline entry (cumulative)
      const totalCount = timeline[timeline.length - 1]?.cumulative || 0;

      console.log(`Found ${totalCount} unique entries`);

      setEntryData(timeline);
      setTotalEntries(totalCount);
    } catch (error) {
      console.error('Error loading entry timeline:', error);
    }
  };

  const loadWinnerCount = async (eventId: string) => {
    try {
      const { count, error } = await supabase
        .from('events_competition_winners')
        .select('*', { count: 'exact', head: true })
        .eq('event_id', eventId);

      if (error) {
        console.error('Error loading winner count:', error);
        return;
      }

      setWinnerCount(count || 0);
    } catch (error) {
      console.error('Error loading winner count:', error);
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

  // Chart configuration for cumulative entries
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
      categories: entryData.map(d => d.date),
      labels: {
        format: 'MMM dd HH:mm',
        datetimeUTC: false
      }
    },
    yaxis: {
      title: {
        text: 'Cumulative Entries'
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
        formatter: (value) => `${Math.floor(value)} entries`
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
    name: 'Cumulative Entries',
    data: entryData.map(d => d.cumulative)
  }];

  const hourlyChartOptions: ApexOptions = {
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
      categories: entryData.map(d => d.date),
      labels: {
        format: 'MMM dd HH:mm',
        datetimeUTC: false
      }
    },
    yaxis: {
      title: {
        text: 'Entries per Hour'
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
        formatter: (value) => `${Math.floor(value)} entries`
      }
    },
    colors: ['#10b981'],
    grid: {
      borderColor: '#e5e7eb',
      strokeDashArray: 4
    }
  };

  const hourlyChartSeries = [{
    name: 'Entries per Hour',
    data: entryData.map(d => d.count)
  }];

  if (loading) {
    return (
      <Page title="Competition Details">
        <div className="p-6 flex items-center justify-center h-64">
          <LoadingSpinner size="medium" />
        </div>
      </Page>
    );
  }

  if (!competition) {
    return (
      <Page title="Competition Not Found">
        <div className="p-6">
          <div className="text-center py-12">
            <h3 className="text-lg font-medium text-gray-900 dark:text-white">Competition not found</h3>
            <Button onClick={() => navigate('/competitions')} className="mt-4">
              Back to Competitions
            </Button>
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title={`Competition Details - ${competition.eventTitle}`}>
      <div className="p-6 space-y-6">
        {/* Back Button */}
        <div>
          <Button
            onClick={() => navigate('/competitions')}
            variant="outlined"
            className="gap-2"
          >
            <ArrowLeftIcon className="size-4" />
            Back to Competitions
          </Button>
        </div>

        {/* Header */}
        <div className="flex items-start gap-4">
          {competition.eventLogo && (
            <div className="flex-shrink-0 w-24 h-16 bg-black rounded p-2">
              <img
                src={competition.eventLogo.startsWith('http') ? competition.eventLogo : `https://www.tech.tickets${competition.eventLogo}`}
                alt={competition.eventTitle}
                className="w-full h-full object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
          )}
          <div className="flex-1">
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              {competition.eventTitle}
            </h1>
            <div className="flex items-center gap-4 mt-2 text-sm text-gray-600 dark:text-gray-400">
              <span className="flex items-center gap-1">
                <CalendarIcon className="size-4" />
                {formatEventDate(competition.eventStart, competition.eventEnd)}
              </span>
              <span>{competition.eventCity}, {competition.eventCountryCode}</span>
            </div>
            {competition.offerCloseDate && (
              <div className="flex items-center gap-1 mt-1 text-sm text-gray-500">
                <ClockIcon className="size-4" />
                Closes: {formatDate(competition.offerCloseDate)}
              </div>
            )}
          </div>
          <Button
            onClick={loadCompetitionDetails}
            variant="outlined"
            className="gap-2"
          >
            <ArrowPathIcon className="size-4" />
            Refresh
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card variant="surface" className="p-6">
            <div className="text-sm font-medium text-neutral-500">Total Entries</div>
            <div className="text-3xl font-bold mt-2">{totalEntries}</div>
          </Card>
          <Card variant="surface" className="p-6">
            <div className="text-sm font-medium text-neutral-500">Winners Selected</div>
            <div className="text-3xl font-bold mt-2 text-amber-600">{winnerCount}</div>
          </Card>
          <Card variant="surface" className="p-6">
            <div className="text-sm font-medium text-neutral-500">Event Date</div>
            <div className="text-2xl font-bold mt-2">{formatEventDate(competition.eventStart, competition.eventEnd)}</div>
          </Card>
        </div>

        {/* Charts */}
        {entryData.length > 0 ? (
          <>
            {/* Cumulative Entries Chart */}
            <Card variant="surface" className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Cumulative Entries Over Time
                </h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  Total number of competition entries over time (1-hour intervals)
                </p>
              </div>
              <ReactApexChart
                options={chartOptions}
                series={chartSeries}
                type="area"
                height={350}
              />
            </Card>

            {/* Entries per Hour Chart */}
            <Card variant="surface" className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Entries per Hour
                </h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  Number of competition entries per hour
                </p>
              </div>
              <ReactApexChart
                options={hourlyChartOptions}
                series={hourlyChartSeries}
                type="bar"
                height={300}
              />
            </Card>
          </>
        ) : (
          <Card variant="surface" className="p-12">
            <div className="text-center">
              <TrophyIcon className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                No entries yet
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                Competition entries haven't been submitted yet. Check back later.
              </p>
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}
