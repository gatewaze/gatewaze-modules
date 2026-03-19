import { useState, useEffect } from 'react';
import ReactApexChart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';

import {
  Button,
  Card,
  Badge,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
} from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { EventQrService, EventRegistration, EventAttendance } from '@/utils/eventQrService';

interface CheckInData {
  date: string;
  count: number;
  cumulative: number;
}

interface BadgeScanStats {
  totalScans: number;
  uniqueScanners: number;
  uniqueScanned: number;
  avgScansPerScanner: number;
  topScanners: Array<{
    scanner_people_profile_id: string;
    scanner_name: string;
    scanner_email: string;
    scanner_company: string | null;
    scan_count: number;
    unique_scanned: number;
  }>;
  timeline: Array<{
    date: string;
    count: number;
    cumulative: number;
  }>;
}

export function EventReportsTab({ eventId }: { eventId: string }) {
  const [registrations, setRegistrations] = useState<EventRegistration[]>([]);
  const [attendance, setAttendance] = useState<EventAttendance[]>([]);
  const [checkInData, setCheckInData] = useState<CheckInData[]>([]);
  const [badgeScanStats, setBadgeScanStats] = useState<BadgeScanStats | null>(null);
  const [calendarStats, setCalendarStats] = useState<any>(null);
  const [calendarWithAttendance, setCalendarWithAttendance] = useState<any[]>([]);
  const [lumaPaymentStats, setLumaPaymentStats] = useState<any>(null);
  const [registrationClassifications, setRegistrationClassifications] = useState<{ byFunction: Array<{ function: string; count: number; jobTitles: string[] }>; bySeniority: Array<{ seniority: string; count: number; jobTitles: string[] }> } | null>(null);
  const [attendanceClassifications, setAttendanceClassifications] = useState<{ byFunction: Array<{ function: string; count: number; jobTitles: string[] }>; bySeniority: Array<{ seniority: string; count: number; jobTitles: string[] }> } | null>(null);
  const [expandedFunctions, setExpandedFunctions] = useState<Set<string>>(new Set());
  const [expandedSeniorities, setExpandedSeniorities] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [eventId]);

  const loadData = async () => {
    setLoading(true);
    try {
      // Load all data in parallel for better performance
      const [regData, attData, stats, calStats, calWithAtt, lumaStats, regClassifications, attClassifications] = await Promise.all([
        EventQrService.getEventRegistrations(eventId),
        EventQrService.getAttendanceWithScanCounts(eventId),
        EventQrService.getBadgeScanStats(eventId),
        EventQrService.getCalendarStats(eventId),
        EventQrService.getCalendarInteractionsWithAttendance(eventId),
        EventQrService.getLumaPaymentStats(eventId),
        EventQrService.getRegistrationJobClassifications(eventId),
        EventQrService.getAttendanceJobClassifications(eventId),
      ]);

      setRegistrations(regData);
      setAttendance(attData);
      processCheckInTimeline(attData);
      setBadgeScanStats(stats);
      setCalendarStats(calStats);
      setCalendarWithAttendance(calWithAtt);
      setLumaPaymentStats(lumaStats);
      setRegistrationClassifications(regClassifications);
      setAttendanceClassifications(attClassifications);
    } catch (error) {
      console.error('Error loading reports data:', error);
      toast.error('Failed to load reports data');
    } finally {
      setLoading(false);
    }
  };

  const processCheckInTimeline = (attendanceData: EventAttendance[]) => {
    if (!attendanceData || attendanceData.length === 0) {
      setCheckInData([]);
      return;
    }

    // Group by 1-minute intervals
    const groupedByInterval = attendanceData.reduce((acc: { [key: string]: number }, record) => {
      if (record.checked_in_at) {
        const timestamp = new Date(record.checked_in_at);
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

    setCheckInData(timeline);
  };

  const handleDownloadRegistrationSponsorCSV = () => {
    try {
      const permittedRegistrations = registrations.filter((r: any) => r.sponsor_permission === true);

      if (permittedRegistrations.length === 0) {
        toast.error('No registrations with sponsor permission to export');
        return;
      }

      const headers = ['First Name', 'Last Name', 'Email', 'Company', 'Job Title', 'Registration Type', 'Ticket Type', 'Status', 'Registered At'];
      const rows = permittedRegistrations.map((reg: any) => [
        reg.first_name || '',
        reg.last_name || '',
        reg.email || '',
        reg.company || '',
        reg.job_title || '',
        reg.registration_type || '',
        reg.ticket_type || '',
        reg.status || '',
        reg.created_at ? new Date(reg.created_at).toISOString() : ''
      ]);

      const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      ].join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${eventId}_sponsor_permission_registrations.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      toast.success('CSV downloaded successfully');
    } catch (error) {
      console.error('Error downloading CSV:', error);
      toast.error('Failed to download CSV');
    }
  };

  const handleDownloadAttendanceSponsorCSV = () => {
    try {
      const permittedAttendees = attendance.filter((a: any) => a.sponsor_permission === true);

      if (permittedAttendees.length === 0) {
        toast.error('No attendees with sponsor permission to export');
        return;
      }

      const headers = ['First Name', 'Last Name', 'Email', 'Company', 'Job Title', 'Checked In At'];
      const rows = permittedAttendees.map((att: any) => [
        att.first_name || '',
        att.last_name || '',
        att.email || '',
        att.company || '',
        att.job_title || '',
        att.checked_in_at ? new Date(att.checked_in_at).toLocaleString() : ''
      ]);

      const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      ].join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${eventId}_sponsor_permission_attendance.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      toast.success('CSV downloaded successfully');
    } catch (error) {
      console.error('Error downloading CSV:', error);
      toast.error('Failed to download CSV');
    }
  };

  // Calculate stats
  const registrationStats = {
    total: registrations.length,
    confirmed: registrations.filter((r) => r.status === 'confirmed').length,
    cancelled: registrations.filter((r) => r.status === 'cancelled').length,
    waitlist: registrations.filter((r) => r.status === 'waitlist').length,
  };

  const attendanceStats = {
    total: attendance.length,
    qrScan: attendance.filter((a) => a.check_in_method === 'qr_scan').length,
    manual: attendance.filter((a) => a.check_in_method === 'manual_entry').length,
    badgePrinted: attendance.filter((a) => a.badge_printed_on_site).length,
  };

  const registrationSponsorPermissionCount = registrations.filter((r: any) => r.sponsor_permission === true).length;
  const attendanceSponsorPermissionCount = attendance.filter((a: any) => a.sponsor_permission === true).length;

  // Calculate source analytics
  const sourceStats = registrations.reduce((acc: Record<string, number>, reg) => {
    const source = (reg as any).source || 'unknown';
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});

  const sortedSources = Object.entries(sourceStats).sort(([, a], [, b]) => b - a);

  // Calculate job title analytics for registrations
  const registrationJobTitleStats = registrations.reduce((acc: Record<string, number>, reg) => {
    const jobTitle = (reg as any).job_title || 'Not specified';
    acc[jobTitle] = (acc[jobTitle] || 0) + 1;
    return acc;
  }, {});

  const sortedRegistrationJobTitles = Object.entries(registrationJobTitleStats).sort(([, a], [, b]) => b - a);

  // Calculate job title analytics for attendance
  const attendanceJobTitleStats = attendance.reduce((acc: Record<string, number>, att) => {
    const jobTitle = (att as any).job_title || 'Not specified';
    acc[jobTitle] = (acc[jobTitle] || 0) + 1;
    return acc;
  }, {});

  // Chart configurations
  const cumulativeChartOptions: ApexOptions = {
    chart: { type: 'area', toolbar: { show: false }, zoom: { enabled: false } },
    dataLabels: { enabled: false },
    stroke: { curve: 'smooth', width: 2 },
    xaxis: { type: 'datetime', labels: { format: 'HH:mm' } },
    yaxis: { title: { text: 'Cumulative Check-ins' } },
    tooltip: { x: { format: 'MMM dd, HH:mm' } },
    colors: ['#3B82F6'],
    fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.7, opacityTo: 0.3 } }
  };

  const cumulativeChartSeries = [{
    name: 'Cumulative Check-ins',
    data: checkInData.map(d => ({ x: new Date(d.date).getTime(), y: d.cumulative }))
  }];

  const perMinuteChartOptions: ApexOptions = {
    chart: { type: 'bar', toolbar: { show: false } },
    plotOptions: { bar: { borderRadius: 4, columnWidth: '60%' } },
    dataLabels: { enabled: false },
    xaxis: { type: 'datetime', labels: { format: 'HH:mm' } },
    yaxis: { title: { text: 'Check-ins per Minute' } },
    tooltip: { x: { format: 'MMM dd, HH:mm' } },
    colors: ['#8B5CF6']
  };

  const perMinuteChartSeries = [{
    name: 'Check-ins',
    data: checkInData.map(d => ({ x: new Date(d.date).getTime(), y: d.count }))
  }];

  // Badge scan chart configurations
  const badgeScanCumulativeOptions: ApexOptions = badgeScanStats?.timeline ? {
    chart: { type: 'area', toolbar: { show: false }, zoom: { enabled: false } },
    dataLabels: { enabled: false },
    stroke: { curve: 'smooth', width: 2 },
    xaxis: { type: 'datetime', labels: { format: 'HH:mm' } },
    yaxis: { title: { text: 'Cumulative Scans' } },
    tooltip: { x: { format: 'MMM dd, HH:mm' } },
    colors: ['#10B981'],
    fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.7, opacityTo: 0.3 } }
  } : {};

  const badgeScanCumulativeSeries = badgeScanStats?.timeline ? [{
    name: 'Cumulative Scans',
    data: badgeScanStats.timeline.map(d => ({ x: new Date(d.date).getTime(), y: d.cumulative }))
  }] : [];

  const badgeScanPerMinuteOptions: ApexOptions = badgeScanStats?.timeline ? {
    chart: { type: 'bar', toolbar: { show: false } },
    plotOptions: { bar: { borderRadius: 4, columnWidth: '60%' } },
    dataLabels: { enabled: false },
    xaxis: { type: 'datetime', labels: { format: 'HH:mm' } },
    yaxis: { title: { text: 'Scans per Minute' } },
    tooltip: { x: { format: 'MMM dd, HH:mm' } },
    colors: ['#F59E0B']
  } : {};

  const badgeScanPerMinuteSeries = badgeScanStats?.timeline ? [{
    name: 'Scans',
    data: badgeScanStats.timeline.map(d => ({ x: new Date(d.date).getTime(), y: d.count }))
  }] : [];

  if (loading) {
    return (
      <Card>
        <div className="p-6 flex justify-center">
          <LoadingSpinner size="medium" />
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      {/* Registration Reports */}
      <Card>
        <div className="p-6">
          <h2 className="text-xl font-bold text-[var(--gray-12)] mb-6">Registration Analytics</h2>

          {/* Registration Stats */}
          {registrations.length > 0 && (
            <>
              <div className="grid grid-cols-4 gap-4 mb-6">
                <div className="p-4 bg-[var(--gray-a3)] rounded-lg">
                  <div className="text-2xl font-bold text-[var(--gray-12)]">{registrationStats.total}</div>
                  <div className="text-sm text-[var(--gray-a11)]">Total</div>
                </div>
                <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg">
                  <div className="text-2xl font-bold text-[var(--green-11)]">{registrationStats.confirmed}</div>
                  <div className="text-sm text-[var(--gray-a11)]">Confirmed</div>
                </div>
                <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-lg">
                  <div className="text-2xl font-bold text-[var(--red-11)]">{registrationStats.cancelled}</div>
                  <div className="text-sm text-[var(--gray-a11)]">Cancelled</div>
                </div>
                <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg">
                  <div className="text-2xl font-bold text-[var(--yellow-11)]">{registrationStats.waitlist}</div>
                  <div className="text-sm text-[var(--gray-a11)]">Waitlist</div>
                </div>
              </div>

              {/* Source Analytics & Sponsor Permission */}
              <div className="grid grid-cols-2 gap-4 mb-4">
                {/* Registration Sources */}
                <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                  <h4 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-3">Registration Sources</h4>
                  {sortedSources.length > 0 ? (
                    <div className="space-y-2">
                      {sortedSources.map(([source, count]) => {
                        const percentage = registrationStats.total > 0
                          ? Math.round((count / registrationStats.total) * 100)
                          : 0;
                        return (
                          <div key={source} className="flex items-center justify-between">
                            <span className="text-sm text-blue-800 dark:text-blue-200 flex-1 min-w-0 truncate">
                              {source === 'unknown' ? 'Not specified' : source}
                            </span>
                            <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                              <div className="w-24 h-2 bg-blue-200 dark:bg-blue-800 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-blue-600 dark:bg-blue-400 rounded-full"
                                  style={{ width: `${percentage}%` }}
                                />
                              </div>
                              <span className="text-sm font-semibold text-blue-900 dark:text-blue-100 w-10 text-right tabular-nums">
                                {count}
                              </span>
                              <span className="text-sm text-blue-700 dark:text-blue-300 w-12 text-right tabular-nums">
                                {percentage}%
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-blue-700 dark:text-blue-300">No source data available</p>
                  )}
                </div>

                {/* Sponsor Permission (Registrations) */}
                <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold text-purple-900 dark:text-purple-100">Sponsor Data Sharing</h4>
                    <Button isIcon variant="ghost" onClick={handleDownloadRegistrationSponsorCSV} disabled={registrationSponsorPermissionCount === 0} title="Download CSV of registrations with sponsor permission">
                      <ArrowDownTrayIcon className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-purple-800 dark:text-purple-200">Granted Permission</span>
                      <span className="text-2xl font-bold text-purple-600 dark:text-purple-400">{registrationSponsorPermissionCount}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-purple-800 dark:text-purple-200">No Permission</span>
                      <span className="text-2xl font-bold text-[var(--gray-a11)]">{registrationStats.total - registrationSponsorPermissionCount}</span>
                    </div>
                    <div className="pt-2 border-t border-purple-200 dark:border-purple-700">
                      <div className="text-xs text-purple-700 dark:text-purple-300">
                        {registrationStats.total > 0 ? `${Math.round((registrationSponsorPermissionCount / registrationStats.total) * 100)}%` : '0%'} of registrants granted permission
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Job Title Breakdown (Registrations) */}
              {sortedRegistrationJobTitles.length > 0 && sortedRegistrationJobTitles.some(([title]) => title !== 'Not specified') && (
                <div className="p-4 bg-teal-50 dark:bg-teal-900/20 rounded-lg border border-teal-200 dark:border-teal-800 mb-4">
                  <h4 className="text-sm font-semibold text-teal-900 dark:text-teal-100 mb-3">Registrations by Job Title (Top 15)</h4>
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {sortedRegistrationJobTitles.slice(0, 15).map(([title, count]) => {
                      const percentage = registrationStats.total > 0
                        ? Math.round((count / registrationStats.total) * 100)
                        : 0;
                      return (
                        <div key={title} className="flex items-center justify-between">
                          <span className="text-sm text-teal-800 dark:text-teal-200 flex-1 min-w-0 truncate" title={title}>
                            {title}
                          </span>
                          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                            <div className="w-24 h-2 bg-teal-200 dark:bg-teal-800 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-teal-600 dark:bg-teal-400 rounded-full"
                                style={{ width: `${percentage}%` }}
                              />
                            </div>
                            <span className="text-sm font-semibold text-teal-900 dark:text-teal-100 w-10 text-right tabular-nums">
                              {count}
                            </span>
                            <span className="text-sm text-teal-700 dark:text-teal-300 w-12 text-right tabular-nums">
                              {percentage}%
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Job Function & Seniority Classification (Registrations) */}
              {registrationClassifications && (registrationClassifications.byFunction.length > 0 || registrationClassifications.bySeniority.length > 0) && (
                <div className="grid grid-cols-2 gap-4">
                  {/* By Job Function */}
                  {registrationClassifications.byFunction.length > 0 && registrationClassifications.byFunction.some(f => f.function !== 'Not classified') && (
                    <div className="p-4 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg border border-indigo-200 dark:border-indigo-800">
                      <h4 className="text-sm font-semibold text-indigo-900 dark:text-indigo-100 mb-3">Registrations by Job Function</h4>
                      <div className="space-y-1">
                        {registrationClassifications.byFunction.map(({ function: fn, count, jobTitles }) => {
                          const percentage = registrationStats.total > 0
                            ? Math.round((count / registrationStats.total) * 100)
                            : 0;
                          const isExpanded = expandedFunctions.has(`reg-${fn}`);
                          const hasJobTitles = jobTitles && jobTitles.length > 0;
                          return (
                            <div key={fn}>
                              <div
                                className={`flex items-center justify-between ${hasJobTitles ? 'cursor-pointer hover:bg-indigo-100 dark:hover:bg-indigo-800/30 rounded px-1 -mx-1' : ''}`}
                                onClick={() => {
                                  if (hasJobTitles) {
                                    setExpandedFunctions(prev => {
                                      const next = new Set(prev);
                                      if (next.has(`reg-${fn}`)) {
                                        next.delete(`reg-${fn}`);
                                      } else {
                                        next.add(`reg-${fn}`);
                                      }
                                      return next;
                                    });
                                  }
                                }}
                              >
                                <span className="text-sm text-indigo-800 dark:text-indigo-200 flex items-center gap-1 flex-1 min-w-0">
                                  {hasJobTitles && (
                                    <span className="text-indigo-500 dark:text-indigo-400 w-4 flex-shrink-0">
                                      {isExpanded ? '\u25BC' : '\u25B6'}
                                    </span>
                                  )}
                                  <span className="truncate">{fn}</span>
                                </span>
                                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                                  <div className="w-20 h-2 bg-indigo-200 dark:bg-indigo-800 rounded-full overflow-hidden">
                                    <div
                                      className="h-full bg-indigo-600 dark:bg-indigo-400 rounded-full"
                                      style={{ width: `${percentage}%` }}
                                    />
                                  </div>
                                  <span className="text-sm font-semibold text-indigo-900 dark:text-indigo-100 w-10 text-right tabular-nums">
                                    {count}
                                  </span>
                                  <span className="text-sm text-indigo-700 dark:text-indigo-300 w-12 text-right tabular-nums">
                                    {percentage}%
                                  </span>
                                </div>
                              </div>
                              {isExpanded && hasJobTitles && (
                                <div className="ml-5 mt-1 mb-2 pl-2 border-l-2 border-indigo-300 dark:border-indigo-700">
                                  {jobTitles.map((title, idx) => (
                                    <div key={idx} className="text-xs text-indigo-600 dark:text-indigo-400 py-0.5">
                                      {title}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* By Job Seniority */}
                  {registrationClassifications.bySeniority.length > 0 && registrationClassifications.bySeniority.some(s => s.seniority !== 'Not classified') && (
                    <div className="p-4 bg-pink-50 dark:bg-pink-900/20 rounded-lg border border-pink-200 dark:border-pink-800">
                      <h4 className="text-sm font-semibold text-pink-900 dark:text-pink-100 mb-3">Registrations by Seniority</h4>
                      <div className="space-y-1">
                        {registrationClassifications.bySeniority.map(({ seniority, count, jobTitles }) => {
                          const percentage = registrationStats.total > 0
                            ? Math.round((count / registrationStats.total) * 100)
                            : 0;
                          const isExpanded = expandedSeniorities.has(`reg-${seniority}`);
                          const hasJobTitles = jobTitles && jobTitles.length > 0;
                          return (
                            <div key={seniority}>
                              <div
                                className={`flex items-center justify-between ${hasJobTitles ? 'cursor-pointer hover:bg-pink-100 dark:hover:bg-pink-800/30 rounded px-1 -mx-1' : ''}`}
                                onClick={() => {
                                  if (hasJobTitles) {
                                    setExpandedSeniorities(prev => {
                                      const next = new Set(prev);
                                      if (next.has(`reg-${seniority}`)) {
                                        next.delete(`reg-${seniority}`);
                                      } else {
                                        next.add(`reg-${seniority}`);
                                      }
                                      return next;
                                    });
                                  }
                                }}
                              >
                                <span className="text-sm text-pink-800 dark:text-pink-200 flex items-center gap-1 flex-1 min-w-0">
                                  {hasJobTitles && (
                                    <span className="text-pink-500 dark:text-pink-400 w-4 flex-shrink-0">
                                      {isExpanded ? '\u25BC' : '\u25B6'}
                                    </span>
                                  )}
                                  <span className="truncate">{seniority}</span>
                                </span>
                                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                                  <div className="w-20 h-2 bg-pink-200 dark:bg-pink-800 rounded-full overflow-hidden">
                                    <div
                                      className="h-full bg-pink-600 dark:bg-pink-400 rounded-full"
                                      style={{ width: `${percentage}%` }}
                                    />
                                  </div>
                                  <span className="text-sm font-semibold text-pink-900 dark:text-pink-100 w-10 text-right tabular-nums">
                                    {count}
                                  </span>
                                  <span className="text-sm text-pink-700 dark:text-pink-300 w-12 text-right tabular-nums">
                                    {percentage}%
                                  </span>
                                </div>
                              </div>
                              {isExpanded && hasJobTitles && (
                                <div className="ml-5 mt-1 mb-2 pl-2 border-l-2 border-pink-300 dark:border-pink-700">
                                  {jobTitles.map((title, idx) => (
                                    <div key={idx} className="text-xs text-pink-600 dark:text-pink-400 py-0.5">
                                      {title}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {registrations.length === 0 && (
            <div className="text-center py-12 text-[var(--gray-a11)]">
              <p>No registration data available</p>
            </div>
          )}
        </div>
      </Card>

      {/* Attendance Reports */}
      <Card>
        <div className="p-6">
          <h2 className="text-xl font-bold text-[var(--gray-12)] mb-6">Attendance Analytics</h2>

          {/* Attendance Stats */}
          {attendance.length > 0 && (
            <>
              <div className="grid grid-cols-4 gap-4 mb-6">
                <div className="p-4 bg-[var(--gray-a3)] rounded-lg">
                  <div className="text-2xl font-bold text-[var(--gray-12)]">{attendanceStats.total}</div>
                  <div className="text-sm text-[var(--gray-a11)]">Total Checked In</div>
                </div>
                <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                  <div className="text-2xl font-bold text-[var(--blue-11)]">{attendanceStats.qrScan}</div>
                  <div className="text-sm text-[var(--gray-a11)]">QR Scan</div>
                </div>
                <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                  <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">{attendanceStats.manual}</div>
                  <div className="text-sm text-[var(--gray-a11)]">Manual</div>
                </div>
                <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg">
                  <div className="text-2xl font-bold text-[var(--green-11)]">{attendanceStats.badgePrinted}</div>
                  <div className="text-sm text-[var(--gray-a11)]">Badge Printed</div>
                </div>
              </div>

              {/* Attendee Source Analytics & Sponsor Permission */}
              <div className="grid grid-cols-2 gap-4 mb-6">
                {/* Attendee Registration Sources */}
                <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                  <h4 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-3">Attendee Registration Sources (Attendance Rate)</h4>
                  {(() => {
                    // Calculate source stats for attendees only by cross-referencing with registrations
                    const attendeeSourceStats = attendance.reduce((acc: Record<string, number>, att) => {
                      // Find the matching registration by email
                      const registration = registrations.find((reg) => reg.email === att.email);
                      const source = (registration as any)?.source || 'unknown';
                      acc[source] = (acc[source] || 0) + 1;
                      return acc;
                    }, {});

                    // Sort by attendance rate percentage (highest first)
                    const sortedAttendeeSources = Object.entries(attendeeSourceStats).sort(([sourceA, countA], [sourceB, countB]) => {
                      const totalA = sourceStats[sourceA] || countA;
                      const totalB = sourceStats[sourceB] || countB;
                      const rateA = totalA > 0 ? (countA / totalA) : 0;
                      const rateB = totalB > 0 ? (countB / totalB) : 0;
                      return rateB - rateA; // Sort descending by percentage
                    });

                    return sortedAttendeeSources.length > 0 ? (
                      <div className="space-y-2">
                        {sortedAttendeeSources.map(([source, attendeeCount]) => {
                          // Get total registrations for this source
                          const totalRegistrations = sourceStats[source] || attendeeCount;
                          // Calculate attendance rate as percentage
                          const attendanceRate = totalRegistrations > 0
                            ? Math.round((attendeeCount / totalRegistrations) * 100)
                            : 0;

                          return (
                            <div key={source} className="flex items-center justify-between">
                              <span className="text-sm text-blue-800 dark:text-blue-200 flex-1 min-w-0 truncate">
                                {source === 'unknown' ? 'Not specified' : source}
                              </span>
                              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                                <div className="w-24 h-2 bg-blue-200 dark:bg-blue-800 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-blue-600 dark:bg-blue-400 rounded-full"
                                    style={{ width: `${attendanceRate}%` }}
                                  />
                                </div>
                                <span className="text-sm font-semibold text-blue-900 dark:text-blue-100 w-8 text-right tabular-nums">
                                  {attendeeCount}
                                </span>
                                <span className="text-sm text-blue-700 dark:text-blue-300">/</span>
                                <span className="text-sm font-semibold text-blue-900 dark:text-blue-100 w-8 text-left tabular-nums">
                                  {totalRegistrations}
                                </span>
                                <span className="text-sm text-blue-700 dark:text-blue-300 w-12 text-right tabular-nums">
                                  {attendanceRate}%
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-blue-700 dark:text-blue-300">No source data available</p>
                    );
                  })()}
                </div>

                {/* Sponsor Data Sharing (Attendance) */}
                <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold text-purple-900 dark:text-purple-100">Sponsor Data Sharing</h4>
                    <Button isIcon variant="ghost" onClick={handleDownloadAttendanceSponsorCSV} disabled={attendanceSponsorPermissionCount === 0} title="Download CSV of attendees with sponsor permission">
                      <ArrowDownTrayIcon className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-purple-800 dark:text-purple-200">Granted Permission</span>
                      <span className="text-2xl font-bold text-purple-600 dark:text-purple-400">{attendanceSponsorPermissionCount}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-purple-800 dark:text-purple-200">No Permission</span>
                      <span className="text-2xl font-bold text-[var(--gray-a11)]">{attendanceStats.total - attendanceSponsorPermissionCount}</span>
                    </div>
                    <div className="pt-2 border-t border-purple-200 dark:border-purple-700">
                      <div className="text-xs text-purple-700 dark:text-purple-300">
                        {attendanceStats.total > 0 ? `${Math.round((attendanceSponsorPermissionCount / attendanceStats.total) * 100)}%` : '0%'} of attendees granted permission
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Job Title Breakdown (Attendance) */}
              {Object.keys(attendanceJobTitleStats).length > 0 && Object.keys(attendanceJobTitleStats).some(title => title !== 'Not specified') && (
                <div className="p-4 bg-teal-50 dark:bg-teal-900/20 rounded-lg border border-teal-200 dark:border-teal-800 mb-6">
                  <h4 className="text-sm font-semibold text-teal-900 dark:text-teal-100 mb-3">Attendees by Job Title (Top 15)</h4>
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {Object.entries(attendanceJobTitleStats).sort(([, a], [, b]) => b - a).slice(0, 15).map(([title, count]) => {
                      const percentage = attendanceStats.total > 0
                        ? Math.round((count / attendanceStats.total) * 100)
                        : 0;
                      // Calculate attendance rate for this job title
                      const registrationCount = registrationJobTitleStats[title] || count;
                      const attendanceRate = registrationCount > 0
                        ? Math.round((count / registrationCount) * 100)
                        : 0;
                      return (
                        <div key={title} className="flex items-center justify-between">
                          <span className="text-sm text-teal-800 dark:text-teal-200 flex-1 min-w-0 truncate" title={title}>
                            {title}
                          </span>
                          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                            <div className="w-20 h-2 bg-teal-200 dark:bg-teal-800 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-teal-600 dark:bg-teal-400 rounded-full"
                                style={{ width: `${percentage}%` }}
                              />
                            </div>
                            <span className="text-sm font-semibold text-teal-900 dark:text-teal-100 w-8 text-right tabular-nums">
                              {count}
                            </span>
                            <span className="text-xs text-teal-700 dark:text-teal-300 w-16 text-right">
                              ({attendanceRate}% rate)
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Job Function & Seniority Classification (Attendance) */}
              {attendanceClassifications && (attendanceClassifications.byFunction.length > 0 || attendanceClassifications.bySeniority.length > 0) && (
                <div className="grid grid-cols-2 gap-4 mb-6">
                  {/* By Job Function */}
                  {attendanceClassifications.byFunction.length > 0 && attendanceClassifications.byFunction.some(f => f.function !== 'Not classified') && (
                    <div className="p-4 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg border border-indigo-200 dark:border-indigo-800">
                      <h4 className="text-sm font-semibold text-indigo-900 dark:text-indigo-100 mb-3">Attendees by Job Function</h4>
                      <div className="space-y-1">
                        {attendanceClassifications.byFunction.map(({ function: fn, count, jobTitles }) => {
                          const percentage = attendanceStats.total > 0
                            ? Math.round((count / attendanceStats.total) * 100)
                            : 0;
                          const isExpanded = expandedFunctions.has(`att-${fn}`);
                          const hasJobTitles = jobTitles && jobTitles.length > 0;
                          return (
                            <div key={fn}>
                              <div
                                className={`flex items-center justify-between ${hasJobTitles ? 'cursor-pointer hover:bg-indigo-100 dark:hover:bg-indigo-800/30 rounded px-1 -mx-1' : ''}`}
                                onClick={() => {
                                  if (hasJobTitles) {
                                    setExpandedFunctions(prev => {
                                      const next = new Set(prev);
                                      if (next.has(`att-${fn}`)) {
                                        next.delete(`att-${fn}`);
                                      } else {
                                        next.add(`att-${fn}`);
                                      }
                                      return next;
                                    });
                                  }
                                }}
                              >
                                <span className="text-sm text-indigo-800 dark:text-indigo-200 flex items-center gap-1 flex-1 min-w-0">
                                  {hasJobTitles && (
                                    <span className="text-indigo-500 dark:text-indigo-400 w-4 flex-shrink-0">
                                      {isExpanded ? '\u25BC' : '\u25B6'}
                                    </span>
                                  )}
                                  <span className="truncate">{fn}</span>
                                </span>
                                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                                  <div className="w-20 h-2 bg-indigo-200 dark:bg-indigo-800 rounded-full overflow-hidden">
                                    <div
                                      className="h-full bg-indigo-600 dark:bg-indigo-400 rounded-full"
                                      style={{ width: `${percentage}%` }}
                                    />
                                  </div>
                                  <span className="text-sm font-semibold text-indigo-900 dark:text-indigo-100 w-10 text-right tabular-nums">
                                    {count}
                                  </span>
                                  <span className="text-sm text-indigo-700 dark:text-indigo-300 w-12 text-right tabular-nums">
                                    {percentage}%
                                  </span>
                                </div>
                              </div>
                              {isExpanded && hasJobTitles && (
                                <div className="ml-5 mt-1 mb-2 pl-2 border-l-2 border-indigo-300 dark:border-indigo-700">
                                  {jobTitles.map((title, idx) => (
                                    <div key={idx} className="text-xs text-indigo-600 dark:text-indigo-400 py-0.5">
                                      {title}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* By Job Seniority */}
                  {attendanceClassifications.bySeniority.length > 0 && attendanceClassifications.bySeniority.some(s => s.seniority !== 'Not classified') && (
                    <div className="p-4 bg-pink-50 dark:bg-pink-900/20 rounded-lg border border-pink-200 dark:border-pink-800">
                      <h4 className="text-sm font-semibold text-pink-900 dark:text-pink-100 mb-3">Attendees by Seniority</h4>
                      <div className="space-y-1">
                        {attendanceClassifications.bySeniority.map(({ seniority, count, jobTitles }) => {
                          const percentage = attendanceStats.total > 0
                            ? Math.round((count / attendanceStats.total) * 100)
                            : 0;
                          const isExpanded = expandedSeniorities.has(`att-${seniority}`);
                          const hasJobTitles = jobTitles && jobTitles.length > 0;
                          return (
                            <div key={seniority}>
                              <div
                                className={`flex items-center justify-between ${hasJobTitles ? 'cursor-pointer hover:bg-pink-100 dark:hover:bg-pink-800/30 rounded px-1 -mx-1' : ''}`}
                                onClick={() => {
                                  if (hasJobTitles) {
                                    setExpandedSeniorities(prev => {
                                      const next = new Set(prev);
                                      if (next.has(`att-${seniority}`)) {
                                        next.delete(`att-${seniority}`);
                                      } else {
                                        next.add(`att-${seniority}`);
                                      }
                                      return next;
                                    });
                                  }
                                }}
                              >
                                <span className="text-sm text-pink-800 dark:text-pink-200 flex items-center gap-1 flex-1 min-w-0">
                                  {hasJobTitles && (
                                    <span className="text-pink-500 dark:text-pink-400 w-4 flex-shrink-0">
                                      {isExpanded ? '\u25BC' : '\u25B6'}
                                    </span>
                                  )}
                                  <span className="truncate">{seniority}</span>
                                </span>
                                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                                  <div className="w-20 h-2 bg-pink-200 dark:bg-pink-800 rounded-full overflow-hidden">
                                    <div
                                      className="h-full bg-pink-600 dark:bg-pink-400 rounded-full"
                                      style={{ width: `${percentage}%` }}
                                    />
                                  </div>
                                  <span className="text-sm font-semibold text-pink-900 dark:text-pink-100 w-10 text-right tabular-nums">
                                    {count}
                                  </span>
                                  <span className="text-sm text-pink-700 dark:text-pink-300 w-12 text-right tabular-nums">
                                    {percentage}%
                                  </span>
                                </div>
                              </div>
                              {isExpanded && hasJobTitles && (
                                <div className="ml-5 mt-1 mb-2 pl-2 border-l-2 border-pink-300 dark:border-pink-700">
                                  {jobTitles.map((title, idx) => (
                                    <div key={idx} className="text-xs text-pink-600 dark:text-pink-400 py-0.5">
                                      {title}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Check-in Timeline Charts */}
              {checkInData.length > 0 && (
                <div className="space-y-6 mb-6">
                  <h3 className="text-lg font-semibold text-[var(--gray-12)]">Check-in Timeline</h3>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Cumulative Check-ins Chart */}
                    <Card variant="surface" className="p-6">
                      <div className="mb-4">
                        <h4 className="text-base font-semibold text-[var(--gray-12)]">
                          Cumulative Check-ins Over Time
                        </h4>
                        <p className="text-sm text-[var(--gray-a11)] mt-1">
                          Total number of attendees checked in over time
                        </p>
                      </div>
                      <ReactApexChart
                        options={cumulativeChartOptions}
                        series={cumulativeChartSeries}
                        type="area"
                        height={300}
                      />
                    </Card>

                    {/* Check-ins per Minute Chart */}
                    <Card variant="surface" className="p-6">
                      <div className="mb-4">
                        <h4 className="text-base font-semibold text-[var(--gray-12)]">
                          Check-ins per Minute
                        </h4>
                        <p className="text-sm text-[var(--gray-a11)] mt-1">
                          Number of attendees checked in per minute
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

              {/* Badge Scanning Statistics */}
              {badgeScanStats && badgeScanStats.totalScans > 0 && (
                <div className="space-y-6">
                  <h3 className="text-lg font-semibold text-[var(--gray-12)]">Badge Scanning Activity</h3>

                  {/* Badge Scan Stats */}
                  <div className="grid grid-cols-4 gap-4">
                    <div className="p-4 bg-[var(--gray-a3)] rounded-lg">
                      <div className="text-2xl font-bold text-[var(--gray-12)]">{badgeScanStats.totalScans}</div>
                      <div className="text-sm text-[var(--gray-a11)]">Total Scans</div>
                    </div>
                    <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                      <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">{badgeScanStats.uniqueScanners}</div>
                      <div className="text-sm text-[var(--gray-a11)]">Active Scanners</div>
                    </div>
                    <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                      <div className="text-2xl font-bold text-[var(--blue-11)]">{badgeScanStats.uniqueScanned}</div>
                      <div className="text-sm text-[var(--gray-a11)]">Unique People Scanned</div>
                    </div>
                    <div className="p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg">
                      <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{badgeScanStats.avgScansPerScanner}</div>
                      <div className="text-sm text-[var(--gray-a11)]">Avg Scans per Scanner</div>
                    </div>
                  </div>

                  {/* Badge Scan Timeline Charts */}
                  {badgeScanStats.timeline.length > 0 && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      {/* Cumulative Badge Scans Chart */}
                      <Card variant="surface" className="p-6">
                        <div className="mb-4">
                          <h4 className="text-base font-semibold text-[var(--gray-12)]">
                            Cumulative Badge Scans Over Time
                          </h4>
                          <p className="text-sm text-[var(--gray-a11)] mt-1">
                            Total number of badge scans over time
                          </p>
                        </div>
                        <ReactApexChart
                          options={badgeScanCumulativeOptions}
                          series={badgeScanCumulativeSeries}
                          type="area"
                          height={300}
                        />
                      </Card>

                      {/* Badge Scans per Minute Chart */}
                      <Card variant="surface" className="p-6">
                        <div className="mb-4">
                          <h4 className="text-base font-semibold text-[var(--gray-12)]">
                            Badge Scans per Minute
                          </h4>
                          <p className="text-sm text-[var(--gray-a11)] mt-1">
                            Number of badge scans per minute
                          </p>
                        </div>
                        <ReactApexChart
                          options={badgeScanPerMinuteOptions}
                          series={badgeScanPerMinuteSeries}
                          type="bar"
                          height={300}
                        />
                      </Card>
                    </div>
                  )}

                  {/* Top Scanners Table */}
                  {badgeScanStats.topScanners.length > 0 && (
                    <Card variant="surface" className="p-6">
                      <h4 className="text-base font-semibold text-[var(--gray-12)] mb-4">
                        Top Scanners
                      </h4>
                      <div className="overflow-x-auto">
                        <Table>
                          <THead>
                            <Tr>
                              <Th>Rank</Th>
                              <Th>Scanner</Th>
                              <Th>Company</Th>
                              <Th className="text-right">Total Scans</Th>
                              <Th className="text-right">Unique Scanned</Th>
                            </Tr>
                          </THead>
                          <TBody>
                            {badgeScanStats.topScanners.map((scanner, index) => (
                              <Tr key={scanner.scanner_people_profile_id}>
                                <Td>
                                  #{index + 1}
                                </Td>
                                <Td>
                                  <div className="text-sm font-medium">
                                    {scanner.scanner_name}
                                  </div>
                                  <div className="text-xs text-[var(--gray-a11)]">{scanner.scanner_email}</div>
                                </Td>
                                <Td className="text-[var(--gray-a11)]">
                                  {scanner.scanner_company || '-'}
                                </Td>
                                <Td className="text-right font-semibold">
                                  {scanner.scan_count}
                                </Td>
                                <Td className="text-right text-[var(--gray-a11)]">
                                  {scanner.unique_scanned}
                                </Td>
                              </Tr>
                            ))}
                          </TBody>
                        </Table>
                      </div>
                    </Card>
                  )}
                </div>
              )}
            </>
          )}

          {attendance.length === 0 && (
            <div className="text-center py-12 text-[var(--gray-a11)]">
              <p>No attendance data available</p>
            </div>
          )}
        </div>
      </Card>

      {/* Calendar Interaction Reports */}
      <Card>
        <div className="p-6">
          <h2 className="text-xl font-bold text-[var(--gray-12)] mb-6">Calendar Integration Analytics</h2>

          {calendarStats && (
            <>
              {/* Calendar Stats Overview */}
              <div className="grid grid-cols-4 gap-4 mb-6">
                <div className="p-4 bg-[var(--gray-a3)] rounded-lg">
                  <div className="text-2xl font-bold text-[var(--gray-12)]">
                    {calendarStats.totalInteractions}
                  </div>
                  <div className="text-sm text-[var(--gray-a11)]">Total Clicks</div>
                </div>
                <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                  <div className="text-2xl font-bold text-[var(--blue-11)]">
                    {calendarStats.uniqueUsers}
                  </div>
                  <div className="text-sm text-[var(--gray-a11)]">Unique Users</div>
                </div>
                <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg">
                  <div className="text-2xl font-bold text-[var(--green-11)]">
                    {calendarStats.byType?.google || 0}
                  </div>
                  <div className="text-sm text-[var(--gray-a11)]">Google Calendar</div>
                </div>
                <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                  <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                    {calendarStats.byType?.outlook || 0}
                  </div>
                  <div className="text-sm text-[var(--gray-a11)]">Outlook Calendar</div>
                </div>
              </div>

              {/* Calendar Type Distribution & Engagement by Attendance */}
              <div className="grid grid-cols-2 gap-4 mb-6">
                {/* Calendar Type Distribution */}
                <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                  <h4 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-3">Calendar Type Distribution</h4>
                  {Object.entries(calendarStats.byType || {}).length > 0 ? (
                    <div className="space-y-2">
                      {Object.entries(calendarStats.byType).map(([type, count]) => (
                        <div key={type} className="flex items-center justify-between">
                          <span className="text-sm text-blue-800 dark:text-blue-200 capitalize">
                            {type === 'ics' ? 'ICS Download' :
                             type === 'apple' ? 'Apple Calendar' :
                             type === 'google' ? 'Google Calendar' :
                             type === 'outlook' ? 'Outlook Calendar' : type}
                          </span>
                          <div className="flex items-center gap-2">
                            <div className="w-24 h-2 bg-blue-200 dark:bg-blue-800 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-600 dark:bg-blue-400 rounded-full"
                                style={{ width: `${((count as number) / calendarStats.totalInteractions) * 100}%` }}
                              />
                            </div>
                            <span className="text-sm font-semibold text-blue-900 dark:text-blue-100 w-8 text-right">
                              {count as number}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-blue-700 dark:text-blue-300">No calendar interaction data available</p>
                  )}
                </div>

                {/* Calendar Engagement by Attendance Status */}
                <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                  <h4 className="text-sm font-semibold text-green-900 dark:text-green-100 mb-3">Calendar Engagement by Attendance</h4>
                  {(() => {
                    const withCalendar = calendarWithAttendance || [];
                    const attendedWithCalendar = withCalendar.filter(u => u.hasAttended).length;
                    const notAttendedWithCalendar = withCalendar.filter(u => !u.hasAttended && u.hasRegistration).length;
                    const noRegistrationWithCalendar = withCalendar.filter(u => !u.hasRegistration).length;

                    return (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-green-800 dark:text-green-200">Attended Event</span>
                          <div className="flex items-center gap-2">
                            <span className="text-lg font-bold text-[var(--green-11)]">
                              {attendedWithCalendar}
                            </span>
                            <span className="text-sm text-green-700 dark:text-green-300">
                              ({withCalendar.length > 0 ? Math.round((attendedWithCalendar / withCalendar.length) * 100) : 0}%)
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-yellow-800 dark:text-yellow-200">Registered, Not Attended</span>
                          <div className="flex items-center gap-2">
                            <span className="text-lg font-bold text-[var(--yellow-11)]">
                              {notAttendedWithCalendar}
                            </span>
                            <span className="text-sm text-yellow-700 dark:text-yellow-300">
                              ({withCalendar.length > 0 ? Math.round((notAttendedWithCalendar / withCalendar.length) * 100) : 0}%)
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-[var(--gray-12)]">No Registration</span>
                          <div className="flex items-center gap-2">
                            <span className="text-lg font-bold text-[var(--gray-a11)]">
                              {noRegistrationWithCalendar}
                            </span>
                            <span className="text-sm text-[var(--gray-11)]">
                              ({withCalendar.length > 0 ? Math.round((noRegistrationWithCalendar / withCalendar.length) * 100) : 0}%)
                            </span>
                          </div>
                        </div>
                        <div className="pt-2 border-t border-green-200 dark:border-green-700">
                          <div className="text-xs text-green-700 dark:text-green-300">
                            {attendedWithCalendar > 0 && withCalendar.length > 0
                              ? `${Math.round((attendedWithCalendar / withCalendar.length) * 100)}% of users who added to calendar attended`
                              : 'No attendance data for calendar users'}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Top Calendar Users */}
              {calendarStats.byEmail && calendarStats.byEmail.length > 0 && (
                <Card variant="surface" className="p-6">
                  <h4 className="text-base font-semibold text-[var(--gray-12)] mb-4">
                    Most Active Calendar Users (Top 10)
                  </h4>
                  <div className="overflow-x-auto">
                    <Table>
                      <THead>
                        <Tr>
                          <Th>Email</Th>
                          <Th>Total Clicks</Th>
                          <Th>Calendar Types Used</Th>
                          <Th>Status</Th>
                        </Tr>
                      </THead>
                      <TBody>
                        {calendarStats.byEmail.slice(0, 10).map((user: any, index: number) => {
                          const userData = calendarWithAttendance.find(u => u.email === user.email);
                          return (
                            <Tr key={index}>
                              <Td>
                                {user.email}
                              </Td>
                              <Td className="text-[var(--gray-a11)]">
                                {user.count}
                              </Td>
                              <Td>
                                <div className="flex gap-1">
                                  {user.types.map((type: string) => (
                                    <Badge key={type} variant="soft" className="text-xs">
                                      {type === 'ics' ? 'ICS' :
                                       type === 'apple' ? 'Apple' :
                                       type === 'google' ? 'Google' :
                                       type === 'outlook' ? 'Outlook' : type}
                                    </Badge>
                                  ))}
                                </div>
                              </Td>
                              <Td>
                                {userData?.hasAttended ? (
                                  <Badge variant="soft" color="green">
                                    Attended
                                  </Badge>
                                ) : userData?.hasRegistration ? (
                                  <Badge variant="soft" color="yellow">
                                    Registered
                                  </Badge>
                                ) : (
                                  <Badge variant="soft" color="gray">
                                    Not Registered
                                  </Badge>
                                )}
                              </Td>
                            </Tr>
                          );
                        })}
                      </TBody>
                    </Table>
                  </div>
                </Card>
              )}
            </>
          )}

          {!calendarStats || calendarStats.totalInteractions === 0 && (
            <div className="text-center py-12 text-[var(--gray-a11)]">
              <p>No calendar interaction data available</p>
              <p className="text-sm mt-2">Calendar links will be tracked when users click them in registration emails</p>
            </div>
          )}
        </div>
      </Card>

      {/* Luma Payment Analytics */}
      {lumaPaymentStats && (
        <Card>
          <div className="p-6">
            <h2 className="text-xl font-bold text-[var(--gray-12)] mb-6">Luma Payment Analytics</h2>

            {/* Revenue Overview */}
            <div className="grid grid-cols-4 gap-4 mb-6">
              <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg">
                <div className="text-2xl font-bold text-[var(--green-11)]">
                  {lumaPaymentStats.currency?.toUpperCase() === 'GBP' ? '\u00A3' : lumaPaymentStats.currency?.toUpperCase() === 'USD' ? '$' : lumaPaymentStats.currency?.toUpperCase() === 'EUR' ? '\u20AC' : ''}{lumaPaymentStats.totalRevenue.toFixed(2)}
                </div>
                <div className="text-sm text-[var(--gray-a11)]">Total Revenue</div>
              </div>
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                <div className="text-2xl font-bold text-[var(--blue-11)]">
                  {lumaPaymentStats.paidRegistrations}
                </div>
                <div className="text-sm text-[var(--gray-a11)]">Paid Registrations</div>
              </div>
              <div className="p-4 bg-[var(--gray-a3)] rounded-lg">
                <div className="text-2xl font-bold text-[var(--gray-12)]">
                  {lumaPaymentStats.freeRegistrations}
                </div>
                <div className="text-sm text-[var(--gray-a11)]">Free Registrations</div>
              </div>
              <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                  {lumaPaymentStats.currency?.toUpperCase() === 'GBP' ? '\u00A3' : lumaPaymentStats.currency?.toUpperCase() === 'USD' ? '$' : lumaPaymentStats.currency?.toUpperCase() === 'EUR' ? '\u20AC' : ''}{(lumaPaymentStats.totalRevenue / lumaPaymentStats.paidRegistrations).toFixed(2)}
                </div>
                <div className="text-sm text-[var(--gray-a11)]">Avg. Ticket Price</div>
              </div>
            </div>

            {/* Ticket Types & Coupon Codes */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              {/* Ticket Types */}
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                <h4 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-3">Revenue by Ticket Type</h4>
                {lumaPaymentStats.ticketTypes.length > 0 ? (
                  <div className="space-y-2">
                    {lumaPaymentStats.ticketTypes.map((ticket: any) => {
                      const percentage = lumaPaymentStats.totalRevenue > 0
                        ? Math.round((ticket.revenue / lumaPaymentStats.totalRevenue) * 100)
                        : 0;
                      return (
                        <div key={ticket.name} className="flex items-center justify-between">
                          <span className="text-sm text-blue-800 dark:text-blue-200 flex-1 min-w-0 truncate">
                            {ticket.name}
                          </span>
                          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                            <div className="w-20 h-2 bg-blue-200 dark:bg-blue-800 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-600 dark:bg-blue-400 rounded-full"
                                style={{ width: `${percentage}%` }}
                              />
                            </div>
                            <span className="text-sm font-semibold text-blue-900 dark:text-blue-100 w-16 text-right tabular-nums">
                              {lumaPaymentStats.currency?.toUpperCase() === 'GBP' ? '\u00A3' : lumaPaymentStats.currency?.toUpperCase() === 'USD' ? '$' : ''}{ticket.revenue.toFixed(0)}
                            </span>
                            <span className="text-xs text-blue-700 dark:text-blue-300 w-10 text-right">
                              ({ticket.count})
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-blue-700 dark:text-blue-300">No ticket type data available</p>
                )}
              </div>

              {/* Coupon Codes */}
              <div className="p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
                <h4 className="text-sm font-semibold text-amber-900 dark:text-amber-100 mb-3">Coupon Code Usage</h4>
                {lumaPaymentStats.couponCodes.length > 0 ? (
                  <div className="space-y-2">
                    {lumaPaymentStats.couponCodes.map((coupon: any) => {
                      const percentage = lumaPaymentStats.paidRegistrations > 0
                        ? Math.round((coupon.count / lumaPaymentStats.paidRegistrations) * 100)
                        : 0;
                      return (
                        <div key={coupon.code} className="flex items-center justify-between">
                          <span className="text-sm text-amber-800 dark:text-amber-200 font-mono">
                            {coupon.code}
                          </span>
                          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                            <div className="w-20 h-2 bg-amber-200 dark:bg-amber-800 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-amber-600 dark:bg-amber-400 rounded-full"
                                style={{ width: `${percentage}%` }}
                              />
                            </div>
                            <span className="text-sm font-semibold text-amber-900 dark:text-amber-100 w-8 text-right tabular-nums">
                              {coupon.count}
                            </span>
                            <span className="text-xs text-amber-700 dark:text-amber-300 w-12 text-right">
                              {percentage}%
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-amber-700 dark:text-amber-300">No coupon codes used</p>
                )}
              </div>
            </div>

            {/* Revenue by Job Title */}
            {lumaPaymentStats.jobTitles && lumaPaymentStats.jobTitles.length > 0 && lumaPaymentStats.jobTitles.some((j: any) => j.title !== 'Not specified') && (
              <div className="p-4 bg-teal-50 dark:bg-teal-900/20 rounded-lg border border-teal-200 dark:border-teal-800 mb-6">
                <h4 className="text-sm font-semibold text-teal-900 dark:text-teal-100 mb-3">Revenue by Job Title (Top 15)</h4>
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {lumaPaymentStats.jobTitles.slice(0, 15).map((job: any) => {
                    const percentage = lumaPaymentStats.totalRevenue > 0
                      ? Math.round((job.revenue / lumaPaymentStats.totalRevenue) * 100)
                      : 0;
                    const currencySymbol = lumaPaymentStats.currency?.toUpperCase() === 'GBP' ? '\u00A3' : lumaPaymentStats.currency?.toUpperCase() === 'USD' ? '$' : lumaPaymentStats.currency?.toUpperCase() === 'EUR' ? '\u20AC' : '';
                    return (
                      <div key={job.title} className="flex items-center justify-between">
                        <span className="text-sm text-teal-800 dark:text-teal-200 flex-1 min-w-0 truncate" title={job.title}>
                          {job.title}
                        </span>
                        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                          <div className="w-16 h-2 bg-teal-200 dark:bg-teal-800 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-teal-600 dark:bg-teal-400 rounded-full"
                              style={{ width: `${percentage}%` }}
                            />
                          </div>
                          <span className="text-sm font-semibold text-teal-900 dark:text-teal-100 w-16 text-right tabular-nums">
                            {currencySymbol}{job.revenue.toFixed(0)}
                          </span>
                          <span className="text-xs text-teal-700 dark:text-teal-300 w-8 text-right">
                            ({job.count})
                          </span>
                          <span className="text-xs text-teal-600 dark:text-teal-400 w-16 text-right">
                            avg {currencySymbol}{job.avgTicketPrice.toFixed(0)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Revenue by Job Function & Seniority */}
            {((lumaPaymentStats.byFunction && lumaPaymentStats.byFunction.length > 0) || (lumaPaymentStats.bySeniority && lumaPaymentStats.bySeniority.length > 0)) && (
              <div className="grid grid-cols-2 gap-4 mb-6">
                {/* By Job Function */}
                {lumaPaymentStats.byFunction && lumaPaymentStats.byFunction.length > 0 && lumaPaymentStats.byFunction.some((f: any) => f.function !== 'Not classified') && (
                  <div className="p-4 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg border border-indigo-200 dark:border-indigo-800">
                    <h4 className="text-sm font-semibold text-indigo-900 dark:text-indigo-100 mb-3">Revenue by Job Function</h4>
                    <div className="space-y-1">
                      {lumaPaymentStats.byFunction.map((item: any) => {
                        const percentage = lumaPaymentStats.totalRevenue > 0
                          ? Math.round((item.revenue / lumaPaymentStats.totalRevenue) * 100)
                          : 0;
                        const currencySymbol = lumaPaymentStats.currency?.toUpperCase() === 'GBP' ? '\u00A3' : lumaPaymentStats.currency?.toUpperCase() === 'USD' ? '$' : lumaPaymentStats.currency?.toUpperCase() === 'EUR' ? '\u20AC' : '';
                        const isExpanded = expandedFunctions.has(`rev-${item.function}`);
                        const hasJobTitles = item.jobTitles && item.jobTitles.length > 0;
                        return (
                          <div key={item.function}>
                            <div
                              className={`flex items-center justify-between ${hasJobTitles ? 'cursor-pointer hover:bg-indigo-100 dark:hover:bg-indigo-800/30 rounded px-1 -mx-1' : ''}`}
                              onClick={() => {
                                if (hasJobTitles) {
                                  setExpandedFunctions(prev => {
                                    const next = new Set(prev);
                                    if (next.has(`rev-${item.function}`)) {
                                      next.delete(`rev-${item.function}`);
                                    } else {
                                      next.add(`rev-${item.function}`);
                                    }
                                    return next;
                                  });
                                }
                              }}
                            >
                              <span className="text-sm text-indigo-800 dark:text-indigo-200 flex items-center gap-1 flex-1 min-w-0">
                                {hasJobTitles && (
                                  <span className="text-indigo-500 dark:text-indigo-400 w-4 flex-shrink-0">
                                    {isExpanded ? '\u25BC' : '\u25B6'}
                                  </span>
                                )}
                                <span className="truncate">{item.function}</span>
                              </span>
                              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                                <div className="w-16 h-2 bg-indigo-200 dark:bg-indigo-800 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-indigo-600 dark:bg-indigo-400 rounded-full"
                                    style={{ width: `${percentage}%` }}
                                  />
                                </div>
                                <span className="text-sm font-semibold text-indigo-900 dark:text-indigo-100 w-14 text-right tabular-nums">
                                  {currencySymbol}{item.revenue.toFixed(0)}
                                </span>
                                <span className="text-xs text-indigo-700 dark:text-indigo-300 w-6 text-right">
                                  ({item.count})
                                </span>
                                <span className="text-xs text-indigo-600 dark:text-indigo-400 w-14 text-right">
                                  avg {currencySymbol}{item.avgTicketPrice.toFixed(0)}
                                </span>
                              </div>
                            </div>
                            {isExpanded && hasJobTitles && (
                              <div className="ml-5 mt-1 mb-2 pl-2 border-l-2 border-indigo-300 dark:border-indigo-700">
                                {item.jobTitles.map((title: string, idx: number) => (
                                  <div key={idx} className="text-xs text-indigo-600 dark:text-indigo-400 py-0.5">
                                    {title}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* By Job Seniority */}
                {lumaPaymentStats.bySeniority && lumaPaymentStats.bySeniority.length > 0 && lumaPaymentStats.bySeniority.some((s: any) => s.seniority !== 'Not classified') && (
                  <div className="p-4 bg-pink-50 dark:bg-pink-900/20 rounded-lg border border-pink-200 dark:border-pink-800">
                    <h4 className="text-sm font-semibold text-pink-900 dark:text-pink-100 mb-3">Revenue by Seniority</h4>
                    <div className="space-y-1">
                      {lumaPaymentStats.bySeniority.map((item: any) => {
                        const percentage = lumaPaymentStats.totalRevenue > 0
                          ? Math.round((item.revenue / lumaPaymentStats.totalRevenue) * 100)
                          : 0;
                        const currencySymbol = lumaPaymentStats.currency?.toUpperCase() === 'GBP' ? '\u00A3' : lumaPaymentStats.currency?.toUpperCase() === 'USD' ? '$' : lumaPaymentStats.currency?.toUpperCase() === 'EUR' ? '\u20AC' : '';
                        const isExpanded = expandedSeniorities.has(`rev-${item.seniority}`);
                        const hasJobTitles = item.jobTitles && item.jobTitles.length > 0;
                        return (
                          <div key={item.seniority}>
                            <div
                              className={`flex items-center justify-between ${hasJobTitles ? 'cursor-pointer hover:bg-pink-100 dark:hover:bg-pink-800/30 rounded px-1 -mx-1' : ''}`}
                              onClick={() => {
                                if (hasJobTitles) {
                                  setExpandedSeniorities(prev => {
                                    const next = new Set(prev);
                                    if (next.has(`rev-${item.seniority}`)) {
                                      next.delete(`rev-${item.seniority}`);
                                    } else {
                                      next.add(`rev-${item.seniority}`);
                                    }
                                    return next;
                                  });
                                }
                              }}
                            >
                              <span className="text-sm text-pink-800 dark:text-pink-200 flex items-center gap-1 flex-1 min-w-0">
                                {hasJobTitles && (
                                  <span className="text-pink-500 dark:text-pink-400 w-4 flex-shrink-0">
                                    {isExpanded ? '\u25BC' : '\u25B6'}
                                  </span>
                                )}
                                <span className="truncate">{item.seniority}</span>
                              </span>
                              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                                <div className="w-16 h-2 bg-pink-200 dark:bg-pink-800 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-pink-600 dark:bg-pink-400 rounded-full"
                                    style={{ width: `${percentage}%` }}
                                  />
                                </div>
                                <span className="text-sm font-semibold text-pink-900 dark:text-pink-100 w-14 text-right tabular-nums">
                                  {currencySymbol}{item.revenue.toFixed(0)}
                                </span>
                                <span className="text-xs text-pink-700 dark:text-pink-300 w-6 text-right">
                                  ({item.count})
                                </span>
                                <span className="text-xs text-pink-600 dark:text-pink-400 w-14 text-right">
                                  avg {currencySymbol}{item.avgTicketPrice.toFixed(0)}
                                </span>
                              </div>
                            </div>
                            {isExpanded && hasJobTitles && (
                              <div className="ml-5 mt-1 mb-2 pl-2 border-l-2 border-pink-300 dark:border-pink-700">
                                {item.jobTitles.map((title: string, idx: number) => (
                                  <div key={idx} className="text-xs text-pink-600 dark:text-pink-400 py-0.5">
                                    {title}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Paid Attendees Table */}
            {lumaPaymentStats.paidAttendees.length > 0 && (
              <Card variant="surface" className="p-6">
                <h4 className="text-base font-semibold text-[var(--gray-12)] mb-4">
                  Paid Registrations ({lumaPaymentStats.paidAttendees.length})
                </h4>
                <div className="overflow-x-auto">
                  <Table>
                    <THead>
                      <Tr>
                        <Th>Name</Th>
                        <Th>Job Title</Th>
                        <Th>Ticket Type</Th>
                        <Th>Coupon</Th>
                        <Th className="text-right">Amount</Th>
                      </Tr>
                    </THead>
                    <TBody>
                      {lumaPaymentStats.paidAttendees.map((attendee: any, index: number) => (
                        <Tr key={index}>
                          <Td>
                            <div className="text-sm font-medium">{attendee.name}</div>
                            <div className="text-xs text-[var(--gray-a11)]">{attendee.email}</div>
                          </Td>
                          <Td className="text-[var(--gray-a11)] max-w-48 truncate" title={attendee.jobTitle || 'Not specified'}>
                            {attendee.jobTitle || <span className="text-[var(--gray-a9)]">-</span>}
                          </Td>
                          <Td className="text-[var(--gray-a11)]">
                            {attendee.ticketType}
                          </Td>
                          <Td>
                            {attendee.couponCode ? (
                              <Badge variant="soft" className="bg-amber-100 text-amber-800 dark:bg-amber-900/20 dark:text-amber-400 font-mono text-xs">
                                {attendee.couponCode}
                              </Badge>
                            ) : (
                              <span className="text-[var(--gray-a9)]">-</span>
                            )}
                          </Td>
                          <Td className="text-right font-semibold text-[var(--green-11)]">
                            {lumaPaymentStats.currency?.toUpperCase() === 'GBP' ? '\u00A3' : lumaPaymentStats.currency?.toUpperCase() === 'USD' ? '$' : lumaPaymentStats.currency?.toUpperCase() === 'EUR' ? '\u20AC' : ''}{attendee.amount.toFixed(2)}
                          </Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </div>
              </Card>
            )}
          </div>
        </Card>
      )}

    </div>
  );
}

export default EventReportsTab;
