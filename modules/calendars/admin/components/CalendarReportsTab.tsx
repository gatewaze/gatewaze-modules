/**
 * Calendar Reports tab — attendance trends for a single calendar.
 *
 * Two charts:
 *   1. Timeline scatter/line of guest_count per event over time. Outliers
 *      (guest_count > Q3 + 1.5*IQR) are highlighted so you can see which
 *      events skew the mean.
 *   2. Comparison bars of four attendance metrics across All-time vs Last 6mo:
 *        - Mean (sensitive to outliers)
 *        - Median (robust)
 *        - Trimmed mean (middle 80% — best signal of "typical" event size)
 *        - Total guests (not averaged — raw volume)
 *
 * When a calendar has few events with data (< 3) the charts show an empty
 * state instead of rendering a chart that would be misleading.
 */

import { useEffect, useMemo, useState } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { Card } from '@/components/ui';
import {
  Calendar,
  CalendarService,
  CalendarStats,
  CalendarGuestTimelinePoint,
} from '../services/calendarService';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

interface CalendarReportsTabProps {
  calendar: Calendar;
  stats: CalendarStats | null;
}

export function CalendarReportsTab({ calendar, stats }: CalendarReportsTabProps) {
  const [timeline, setTimeline] = useState<CalendarGuestTimelinePoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await CalendarService.getCalendarGuestTimeline(calendar.id);
      if (res.success && res.data) setTimeline(res.data);
      setLoading(false);
    })();
  }, [calendar.id]);

  // Rolling average (3-event window) — smooths the scatter so the trend
  // line is readable without being pulled around by individual outliers.
  const rollingAvg = useMemo(() => {
    const windowSize = 3;
    const result: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < timeline.length; i++) {
      const windowStart = Math.max(0, i - windowSize + 1);
      const window = timeline.slice(windowStart, i + 1);
      const avg = window.reduce((s, p) => s + p.luma_guest_count, 0) / window.length;
      result.push({ x: new Date(timeline[i].event_start).getTime(), y: Math.round(avg) });
    }
    return result;
  }, [timeline]);

  const scatterSeries = useMemo(() => {
    const normal: Array<{ x: number; y: number }> = [];
    const outliers: Array<{ x: number; y: number }> = [];
    for (const p of timeline) {
      const point = { x: new Date(p.event_start).getTime(), y: p.luma_guest_count };
      if (p.is_outlier) outliers.push(point);
      else normal.push(point);
    }
    return { normal, outliers };
  }, [timeline]);

  const timelineOptions: ApexOptions = {
    chart: { type: 'line', zoom: { enabled: true }, toolbar: { show: true } },
    stroke: { curve: 'smooth', width: [0, 0, 3] },
    markers: { size: [6, 8, 0] },
    xaxis: { type: 'datetime', title: { text: 'Event date' } },
    yaxis: { title: { text: 'Guests' }, min: 0 },
    colors: ['#6366f1', '#ef4444', '#10b981'], // indigo / red / green
    tooltip: {
      shared: false,
      x: { format: 'dd MMM yyyy' },
    },
    legend: { position: 'top' },
  };

  const compareSeries = useMemo(() => ([
    {
      name: 'All time',
      data: [
        stats?.avg_luma_guests_all_time ?? 0,
        stats?.median_luma_guests_all_time ?? 0,
        stats?.trimmed_mean_luma_guests_all_time ?? 0,
      ],
    },
    {
      name: 'Last 6 months',
      data: [
        stats?.avg_luma_guests_6mo ?? 0,
        stats?.median_luma_guests_6mo ?? 0,
        stats?.trimmed_mean_luma_guests_6mo ?? 0,
      ],
    },
  ]), [stats]);

  const compareOptions: ApexOptions = {
    chart: { type: 'bar', toolbar: { show: false } },
    plotOptions: { bar: { horizontal: false, dataLabels: { position: 'top' } } },
    dataLabels: { enabled: true, offsetY: -20, style: { colors: ['#404040'] } },
    xaxis: {
      categories: ['Mean', 'Median', 'Trimmed mean (80%)'],
      title: { text: 'Metric' },
    },
    yaxis: { title: { text: 'Guests per event' } },
    colors: ['#6366f1', '#22d3ee'],
    legend: { position: 'top' },
    tooltip: {
      y: { formatter: (v: number) => `${v.toLocaleString()} guests` },
    },
  };

  const hasData = timeline.length >= 3;
  const outlierCount = timeline.filter((p) => p.is_outlier).length;

  return (
    <div className="space-y-6">
      {/* Explainer card */}
      <Card skin="shadow" className="p-4">
        <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100 mb-1">
          How we compute these metrics
        </h3>
        <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
          <strong>Mean</strong> is the raw average — one giant event will pull it up.{' '}
          <strong>Median</strong> is the middle value, inherently resistant to outliers.{' '}
          <strong>Trimmed mean</strong> drops the top 10% and bottom 10% of events, then averages the remaining 80% — the best signal of what a "typical" event looks like for this chapter.
          Events with zero guests (usually future events whose registration hasn't opened) are excluded throughout.
        </p>
      </Card>

      {loading ? (
        <div className="flex justify-center py-12"><LoadingSpinner size="large" /></div>
      ) : !hasData ? (
        <Card skin="shadow" className="p-12 text-center">
          <div className="text-neutral-500 text-sm">
            Need at least 3 events with guest counts to show trends.
            This calendar has {timeline.length} — run the scraper to pick up more.
          </div>
        </Card>
      ) : (
        <>
          <Card skin="shadow" className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Attendance over time</h3>
                <p className="text-xs text-neutral-500">
                  {timeline.length} event{timeline.length === 1 ? '' : 's'} · {outlierCount} outlier{outlierCount === 1 ? '' : 's'}
                  {stats?.iqr_upper_luma_guests ? ` (above ${stats.iqr_upper_luma_guests.toLocaleString()} guests)` : ''}
                </p>
              </div>
            </div>
            <ReactApexChart
              type="line"
              height={380}
              options={timelineOptions}
              series={[
                { name: 'Events', type: 'scatter', data: scatterSeries.normal },
                { name: 'Outliers', type: 'scatter', data: scatterSeries.outliers },
                { name: '3-event rolling avg', type: 'line', data: rollingAvg },
              ]}
            />
          </Card>

          <Card skin="shadow" className="p-4">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Attendance metrics — all time vs last 6 months</h3>
              <p className="text-xs text-neutral-500">
                Use the trimmed mean as your primary signal. If median and trimmed mean both drop between periods the chapter is cooling; if they rise it's heating up.
              </p>
            </div>
            <ReactApexChart
              type="bar"
              height={340}
              options={compareOptions}
              series={compareSeries}
            />
          </Card>
        </>
      )}
    </div>
  );
}

export default CalendarReportsTab;
