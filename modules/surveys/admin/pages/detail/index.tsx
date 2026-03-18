import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  ClipboardDocumentListIcon,
  ArrowLeftIcon,
  ArrowPathIcon,
  EyeIcon,
  ArrowDownTrayIcon,
  ChartBarIcon,
  TableCellsIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  createColumnHelper,
  SortingState,
} from '@tanstack/react-table';
import {
  Card,
  Button,
  Pagination,
  PaginationFirst,
  PaginationLast,
  PaginationNext,
  PaginationPrevious,
  PaginationItems,
  Badge,
  Modal,
} from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { DataTable } from '@/components/shared/table/DataTable';
import { RowActions } from '@/components/shared/table/RowActions';
import { supabase } from '@/lib/supabase';

const PAGE_SIZE = 25;

type ViewMode = 'table' | 'aggregate';

interface AggregatedField {
  fieldKey: string;
  question: string;
  type: string;
  options?: string[];
  responses: Map<string, number>;
  totalResponses: number;
  // For yesno surveys with dynamic labels
  labelMap?: Record<string, string>;
}

// Interface for grouped yesno poll results
interface YesNoPoll {
  questionKey: string;
  questionText: string;
  yesLabel: string;
  noLabel: string;
  responses: Map<string, number>;
  totalResponses: number;
  firstSubmission: string; // ISO timestamp of first submission for this poll
}

interface SurveySubmission {
  id: string;
  survey_id: string;
  user_id: string | null;
  user_email: string;
  responses: Record<string, any>;
  completion_time_seconds: number | null;
  user_agent: string | null;
  referrer: string | null;
  event_name: string | null;
  query_parameters: Record<string, any> | null;
  is_partial: boolean;
  created_at: string;
  updated_at: string;
}

interface SurveySchema {
  id: string;
  survey_id: string;
  name: string;
  description: string | null;
  version: string;
  schema: {
    steps?: Array<{
      id: string;
      title: string;
      fields: Record<string, {
        type: string;
        question: string;
        options?: string[];
      }>;
    }>;
  };
  is_active: boolean;
}

// Helper function to format time ago
function timeAgo(dateString: string | undefined): string {
  if (!dateString) return '-';

  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  const intervals = {
    year: 31536000,
    month: 2592000,
    week: 604800,
    day: 86400,
    hour: 3600,
    minute: 60,
  };

  for (const [unit, secondsInUnit] of Object.entries(intervals)) {
    const interval = Math.floor(seconds / secondsInUnit);
    if (interval >= 1) {
      return `${interval} ${unit}${interval === 1 ? '' : 's'} ago`;
    }
  }

  return 'just now';
}

function formatTimestamp(dateString: string | undefined): string {
  if (!dateString) return 'No timestamp';

  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '-';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

const columnHelper = createColumnHelper<SurveySubmission>();

export default function SurveyDetailPage() {
  const { surveyId } = useParams<{ surveyId: string }>();
  const navigate = useNavigate();
  const [submissions, setSubmissions] = useState<SurveySubmission[]>([]);
  const [schema, setSchema] = useState<SurveySchema | null>(null);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'created_at', desc: true }
  ]);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedSubmission, setSelectedSubmission] = useState<SurveySubmission | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('aggregate');

  const loadData = async () => {
    if (!surveyId) return;

    try {
      setLoading(true);

      // Fetch survey schema
      const { data: schemaData, error: schemaError } = await supabase
        .from('surveys_schemas')
        .select('*')
        .eq('survey_id', surveyId)
        .single();

      if (schemaError && schemaError.code !== 'PGRST116') {
        console.error('Error fetching survey schema:', schemaError);
      }
      setSchema(schemaData);

      // Fetch submissions
      const { data: submissionData, error: submissionError } = await supabase
        .from('surveys_submissions')
        .select('*')
        .eq('survey_id', surveyId)
        .order('created_at', { ascending: false });

      if (submissionError) {
        console.error('Error fetching submissions:', submissionError);
        toast.error('Failed to load submissions');
        return;
      }

      // Group by user_email and keep only the latest submission per user
      const latestByUser = new Map<string, SurveySubmission>();
      for (const submission of (submissionData || [])) {
        const key = submission.user_email;
        const existing = latestByUser.get(key);

        // Keep the submission if:
        // 1. No existing submission for this user, OR
        // 2. This one is complete and existing is partial, OR
        // 3. Both have same status but this one is newer
        if (!existing) {
          latestByUser.set(key, submission);
        } else if (!submission.is_partial && existing.is_partial) {
          // Prefer complete over partial
          latestByUser.set(key, submission);
        } else if (submission.is_partial === existing.is_partial) {
          // Same status - keep the newer one (already sorted desc by created_at, so first one wins)
          // Do nothing, keep existing
        }
      }

      setSubmissions(Array.from(latestByUser.values()));
    } catch (error) {
      console.error('Error loading survey data:', error);
      toast.error('Failed to load survey data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [surveyId]);

  // Get field labels from schema
  const getFieldLabel = (fieldKey: string): string => {
    if (!schema?.schema?.steps) return fieldKey;

    for (const step of schema.schema.steps) {
      if (step.fields && step.fields[fieldKey]) {
        return step.fields[fieldKey].question || fieldKey;
      }
    }
    return fieldKey;
  };

  // Get field info from schema
  const getFieldInfo = (fieldKey: string): { type: string; options?: string[] } | null => {
    if (!schema?.schema?.steps) return null;

    for (const step of schema.schema.steps) {
      if (step.fields && step.fields[fieldKey]) {
        return {
          type: step.fields[fieldKey].type,
          options: step.fields[fieldKey].options,
        };
      }
    }
    return null;
  };

  // Meta fields to exclude from aggregated results
  const EXCLUDED_META_FIELDS = new Set([
    'total_steps',
    'completed_step',
    'is_final_submission',
    'current_step',
    'is_partial_submission',
  ]);

  // Check if this is a yesno survey with dynamic questions
  const isYesNoSurvey = surveyId === 'yesno';

  // Aggregate yesno poll results grouped by question
  const yesNoPolls = useMemo((): YesNoPoll[] => {
    if (!isYesNoSurvey || submissions.length === 0) return [];

    // Group submissions by question text
    const pollsByQuestion = new Map<string, YesNoPoll>();

    for (const submission of submissions) {
      const queryParams = submission.query_parameters || {};
      // Check both lowercase and uppercase field names
      const questionText = queryParams.question || queryParams.Question || 'Unknown Question';
      const yesLabel = queryParams.y || queryParams.Y || 'Yes';
      const noLabel = queryParams.n || queryParams.N || 'No';
      const rawAnswer = submission.responses?.answer;

      if (!rawAnswer) continue;

      // Map the answer to the display label
      // The answer might be stored as "yes"/"no" or as the actual label value
      let displayAnswer: string;
      const lowerAnswer = rawAnswer.toLowerCase();
      if (lowerAnswer === 'yes' || rawAnswer === yesLabel) {
        displayAnswer = yesLabel;
      } else if (lowerAnswer === 'no' || rawAnswer === noLabel) {
        displayAnswer = noLabel;
      } else {
        // Use the raw answer if it doesn't match expected values
        displayAnswer = rawAnswer;
      }

      // Use question text as the key
      const questionKey = questionText;

      let poll = pollsByQuestion.get(questionKey);
      if (!poll) {
        poll = {
          questionKey,
          questionText,
          yesLabel,
          noLabel,
          responses: new Map(),
          totalResponses: 0,
          firstSubmission: submission.created_at,
        };
        pollsByQuestion.set(questionKey, poll);
      }

      poll.totalResponses++;
      poll.responses.set(displayAnswer, (poll.responses.get(displayAnswer) || 0) + 1);

      // Track earliest (first) submission for this poll
      if (submission.created_at < poll.firstSubmission) {
        poll.firstSubmission = submission.created_at;
      }
    }

    // Sort by first submission date (most recent first submission at top)
    return Array.from(pollsByQuestion.values())
      .sort((a, b) => new Date(b.firstSubmission).getTime() - new Date(a.firstSubmission).getTime());
  }, [submissions, isYesNoSurvey]);

  // Aggregate responses across all submissions (for non-yesno surveys)
  const aggregatedData = useMemo((): AggregatedField[] => {
    if (submissions.length === 0 || isYesNoSurvey) return [];

    // Build ordered list of field keys from schema
    const schemaFieldOrder: string[] = [];
    const allFields = new Map<string, AggregatedField>();

    // First, initialize fields from schema if available (preserves order)
    if (schema?.schema?.steps) {
      for (const step of schema.schema.steps) {
        for (const [fieldKey, fieldDef] of Object.entries(step.fields || {})) {
          // Skip excluded meta fields
          if (EXCLUDED_META_FIELDS.has(fieldKey)) continue;

          schemaFieldOrder.push(fieldKey);
          allFields.set(fieldKey, {
            fieldKey,
            question: fieldDef.question || fieldKey,
            type: fieldDef.type,
            options: fieldDef.options,
            responses: new Map(),
            totalResponses: 0,
          });
        }
      }
    }

    // Aggregate responses
    for (const submission of submissions) {
      for (const [fieldKey, value] of Object.entries(submission.responses || {})) {
        // Skip excluded meta fields
        if (EXCLUDED_META_FIELDS.has(fieldKey)) continue;

        // Get or create field entry
        let field = allFields.get(fieldKey);
        if (!field) {
          const info = getFieldInfo(fieldKey);
          field = {
            fieldKey,
            question: getFieldLabel(fieldKey),
            type: info?.type || 'unknown',
            options: info?.options,
            responses: new Map(),
            totalResponses: 0,
          };
          allFields.set(fieldKey, field);
        }

        // Count responses
        if (value !== null && value !== undefined && value !== '') {
          field.totalResponses++;

          if (Array.isArray(value)) {
            // Multiple choice - count each selection
            for (const item of value) {
              const strItem = String(item);
              field.responses.set(strItem, (field.responses.get(strItem) || 0) + 1);
            }
          } else {
            // Single value
            const strValue = String(value);
            field.responses.set(strValue, (field.responses.get(strValue) || 0) + 1);
          }
        }
      }
    }

    // Return fields in schema order first, then any extra fields
    const result: AggregatedField[] = [];
    const addedKeys = new Set<string>();

    // Add schema fields first (in order)
    for (const fieldKey of schemaFieldOrder) {
      const field = allFields.get(fieldKey);
      if (field && field.totalResponses > 0) {
        result.push(field);
        addedKeys.add(fieldKey);
      }
    }

    // Add any remaining fields not in schema
    for (const [fieldKey, field] of allFields) {
      if (!addedKeys.has(fieldKey) && field.totalResponses > 0) {
        result.push(field);
      }
    }

    return result;
  }, [submissions, schema, isYesNoSurvey]);

  const handleViewSubmission = (submission: SurveySubmission) => {
    setSelectedSubmission(submission);
    setViewModalOpen(true);
  };

  const handleExportCSV = () => {
    if (submissions.length === 0) {
      toast.error('No submissions to export');
      return;
    }

    try {
      // Get all unique response keys
      const allKeys = new Set<string>();
      submissions.forEach(s => {
        Object.keys(s.responses || {}).forEach(key => allKeys.add(key));
      });
      const responseKeys = Array.from(allKeys);

      // Build CSV header
      const headers = [
        'submission_id',
        'user_email',
        'user_id',
        'is_partial',
        'completion_time_seconds',
        'event_name',
        'created_at',
        ...responseKeys.map(key => getFieldLabel(key)),
      ];

      // Build CSV rows
      const rows = submissions.map(s => {
        const baseData = [
          s.id,
          s.user_email,
          s.user_id || '',
          s.is_partial ? 'Yes' : 'No',
          s.completion_time_seconds?.toString() || '',
          s.event_name || '',
          s.created_at,
        ];

        const responseData = responseKeys.map(key => {
          const value = s.responses?.[key];
          if (Array.isArray(value)) return value.join('; ');
          if (typeof value === 'object') return JSON.stringify(value);
          return value?.toString() || '';
        });

        return [...baseData, ...responseData];
      });

      // Escape CSV fields
      const escapeField = (field: string) => {
        if (field.includes(',') || field.includes('"') || field.includes('\n')) {
          return `"${field.replace(/"/g, '""')}"`;
        }
        return field;
      };

      const csvContent = [
        headers.map(escapeField).join(','),
        ...rows.map(row => row.map(escapeField).join(',')),
      ].join('\n');

      // Download
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `survey-${surveyId}-submissions-${new Date().toISOString().split('T')[0]}.csv`;
      link.click();

      toast.success(`Exported ${submissions.length} submissions to CSV`);
    } catch (error) {
      console.error('Error exporting CSV:', error);
      toast.error('Failed to export CSV');
    }
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('user_email', {
        header: 'Email',
        cell: (info) => (
          <div className="text-sm text-[var(--gray-12)] max-w-xs truncate" title={info.getValue()}>
            {info.getValue()}
          </div>
        ),
      }),
      columnHelper.accessor('is_partial', {
        header: 'Status',
        cell: (info) => (
          <Badge color={info.getValue() ? 'warning' : 'success'}>
            {info.getValue() ? 'Partial' : 'Complete'}
          </Badge>
        ),
      }),
      columnHelper.accessor('completion_time_seconds', {
        header: 'Duration',
        cell: (info) => (
          <div className="text-sm text-[var(--gray-11)]">
            {formatDuration(info.getValue())}
          </div>
        ),
      }),
      columnHelper.accessor('event_name', {
        header: 'Event',
        cell: (info) => (
          <div className="text-sm text-[var(--gray-11)] max-w-xs truncate" title={info.getValue() || ''}>
            {info.getValue() || '-'}
          </div>
        ),
      }),
      columnHelper.accessor('created_at', {
        header: 'Submitted',
        cell: (info) => (
          <div
            className="text-sm text-[var(--gray-11)] cursor-help whitespace-nowrap"
            title={formatTimestamp(info.getValue())}
          >
            {timeAgo(info.getValue())}
          </div>
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: (info) => {
          const submission = info.row.original;
          return (
            <RowActions
              actions={[
                { label: 'View Responses', icon: <EyeIcon className="size-4" />, onClick: () => handleViewSubmission(submission) },
              ]}
            />
          );
        },
      }),
    ],
    []
  );

  const table = useReactTable({
    data: submissions,
    columns,
    state: {
      sorting,
      globalFilter,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: {
        pageSize: PAGE_SIZE,
      },
    },
  });

  const completeSubmissions = submissions.filter(s => !s.is_partial).length;
  const partialSubmissions = submissions.filter(s => s.is_partial).length;

  return (
    <Page title={schema?.name || surveyId || 'Survey'}>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-4">
            <Button
              variant="outlined"
              onClick={() => navigate('/surveys')}
              className="gap-2"
            >
              <ArrowLeftIcon className="size-4" />
              Back
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
                {schema?.name || surveyId}
              </h1>
              <p className="text-[var(--gray-11)] mt-1">
                {schema?.description || `Survey ID: ${surveyId}`}
              </p>
            </div>
          </div>
          <div className="flex gap-3 items-center">
            <Button
              onClick={handleExportCSV}
              variant="outlined"
              className="gap-2"
              disabled={loading || submissions.length === 0}
            >
              <ArrowDownTrayIcon className="size-4" />
              Export CSV
            </Button>
            <Button
              onClick={loadData}
              variant="outlined"
              className="gap-2"
              disabled={loading}
            >
              <ArrowPathIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className={`grid grid-cols-1 gap-6 ${isYesNoSurvey ? 'md:grid-cols-2' : 'md:grid-cols-3'}`}>
          <Card variant="surface" className="p-6">
            <div className="flex items-center gap-3">
              <ClipboardDocumentListIcon className="size-6 text-[var(--accent-9)]" />
              <div>
                <div className="text-sm font-medium text-[var(--gray-11)]">Total Respondents</div>
                <div className="text-2xl font-bold mt-1">{submissions.length}</div>
              </div>
            </div>
          </Card>
          {isYesNoSurvey ? (
            <Card variant="surface" className="p-6">
              <div className="flex items-center gap-3">
                <ChartBarIcon className="size-6 text-[var(--accent-9)]" />
                <div>
                  <div className="text-sm font-medium text-[var(--gray-11)]">Unique Polls</div>
                  <div className="text-2xl font-bold mt-1">{yesNoPolls.length}</div>
                </div>
              </div>
            </Card>
          ) : (
            <>
              <Card variant="surface" className="p-6">
                <div className="flex items-center gap-3">
                  <ClipboardDocumentListIcon className="size-6 text-[var(--accent-9)]" />
                  <div>
                    <div className="text-sm font-medium text-[var(--gray-11)]">Complete</div>
                    <div className="text-2xl font-bold mt-1">{completeSubmissions}</div>
                  </div>
                </div>
              </Card>
              <Card variant="surface" className="p-6">
                <div className="flex items-center gap-3">
                  <ClipboardDocumentListIcon className="size-6 text-[var(--accent-9)]" />
                  <div>
                    <div className="text-sm font-medium text-[var(--gray-11)]">Partial</div>
                    <div className="text-2xl font-bold mt-1">{partialSubmissions}</div>
                  </div>
                </div>
              </Card>
            </>
          )}
        </div>

        {/* View Mode Toggle */}
        <div className="flex gap-2">
          <Button
            variant={viewMode === 'aggregate' ? 'filled' : 'outlined'}
            onClick={() => setViewMode('aggregate')}
            className="gap-2"
          >
            <ChartBarIcon className="size-4" />
            Results
          </Button>
          <Button
            variant={viewMode === 'table' ? 'filled' : 'outlined'}
            onClick={() => setViewMode('table')}
            className="gap-2"
          >
            <TableCellsIcon className="size-4" />
            Submissions
          </Button>
        </div>

        {/* Aggregated View */}
        {viewMode === 'aggregate' && (
          <div className="space-y-6">
            {loading ? (
              <Card variant="surface" className="p-12 text-center">
                <LoadingSpinner size="medium" />
              </Card>
            ) : isYesNoSurvey ? (
              // YesNo survey with dynamic questions - show grouped polls
              yesNoPolls.length === 0 ? (
                <Card variant="surface" className="p-12 text-center">
                  <ClipboardDocumentListIcon className="mx-auto h-12 w-12 text-[var(--gray-a8)]" />
                  <h3 className="mt-2 text-sm font-medium text-[var(--gray-12)]">
                    No poll responses yet
                  </h3>
                  <p className="mt-1 text-sm text-[var(--gray-11)]">
                    No one has responded to any polls yet.
                  </p>
                </Card>
              ) : (
                yesNoPolls.map((poll, pollIndex) => {
                  // Sort responses by count (descending)
                  const sortedResponses = Array.from(poll.responses.entries())
                    .sort((a, b) => b[1] - a[1]);
                  const maxCount = sortedResponses.length > 0 ? sortedResponses[0][1] : 0;

                  // Color palette for different responses
                  const colors = [
                    'bg-[var(--accent-9)]',
                    'bg-[var(--accent-7)]',
                    'bg-[var(--accent-5)]',
                    'bg-[var(--accent-4)]',
                  ];

                  return (
                    <Card key={poll.questionKey} variant="surface" className="p-6">
                      <div className="mb-4">
                        <h3 className="text-lg font-medium text-[var(--gray-12)]">
                          {poll.questionText}
                        </h3>
                        <p className="text-sm text-[var(--gray-11)] mt-1">
                          {poll.totalResponses} response{poll.totalResponses !== 1 ? 's' : ''}
                          <span className="ml-2 text-[var(--gray-a8)]">• poll</span>
                        </p>
                      </div>
                      <div className="space-y-3">
                        {sortedResponses.map(([response, count], index) => {
                          const percentage = poll.totalResponses > 0
                            ? Math.round((count / poll.totalResponses) * 100)
                            : 0;
                          const barWidth = maxCount > 0
                            ? Math.round((count / maxCount) * 100)
                            : 0;

                          return (
                            <div key={response} className="relative">
                              <div className="flex justify-between items-center mb-1">
                                <span className="text-sm font-medium text-[var(--gray-11)] truncate max-w-[70%]" title={response}>
                                  {response}
                                </span>
                                <span className="text-sm text-[var(--gray-11)]">
                                  {count} ({percentage}%)
                                </span>
                              </div>
                              <div className="h-6 bg-[var(--gray-a3)] rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all duration-300 ${colors[index % colors.length]}`}
                                  style={{ width: `${barWidth}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </Card>
                  );
                })
              )
            ) : aggregatedData.length === 0 ? (
              <Card variant="surface" className="p-12 text-center">
                <ClipboardDocumentListIcon className="mx-auto h-12 w-12 text-[var(--gray-a8)]" />
                <h3 className="mt-2 text-sm font-medium text-[var(--gray-12)]">
                  No responses yet
                </h3>
                <p className="mt-1 text-sm text-[var(--gray-11)]">
                  No one has submitted this survey yet.
                </p>
              </Card>
            ) : (
              aggregatedData.map((field) => {
                // Sort responses by count (descending)
                const sortedResponses = Array.from(field.responses.entries())
                  .sort((a, b) => b[1] - a[1]);
                const maxCount = sortedResponses.length > 0 ? sortedResponses[0][1] : 0;

                return (
                  <Card key={field.fieldKey} variant="surface" className="p-6">
                    <div className="mb-4">
                      <h3 className="text-lg font-medium text-[var(--gray-12)]">
                        {field.question}
                      </h3>
                      <p className="text-sm text-[var(--gray-11)] mt-1">
                        {field.totalResponses} response{field.totalResponses !== 1 ? 's' : ''}
                        {field.type && field.type !== 'unknown' && (
                          <span className="ml-2 text-[var(--gray-a8)]">• {field.type}</span>
                        )}
                      </p>
                    </div>
                    <div className="space-y-3">
                      {sortedResponses.map(([response, count]) => {
                        const percentage = field.totalResponses > 0
                          ? Math.round((count / field.totalResponses) * 100)
                          : 0;
                        const barWidth = maxCount > 0
                          ? Math.round((count / maxCount) * 100)
                          : 0;

                        return (
                          <div key={response} className="relative">
                            <div className="flex justify-between items-center mb-1">
                              <span className="text-sm text-[var(--gray-11)] truncate max-w-[70%]" title={response}>
                                {response}
                              </span>
                              <span className="text-sm text-[var(--gray-11)]">
                                {count} ({percentage}%)
                              </span>
                            </div>
                            <div className="h-6 bg-[var(--gray-a3)] rounded-full overflow-hidden">
                              <div
                                className="h-full bg-[var(--accent-9)] rounded-full transition-all duration-300"
                                style={{ width: `${barWidth}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </Card>
                );
              })
            )}
          </div>
        )}

        {/* Submissions Table */}
        {viewMode === 'table' && (
        <Card className="overflow-hidden">
          <DataTable table={table} loading={loading} onRowDoubleClick={(submission) => handleViewSubmission(submission)} />

          {/* Pagination */}
          {!loading && table.getRowModel().rows.length > 0 && (
            <div className="px-6 py-4 bg-[var(--gray-a3)] border-t border-[var(--gray-a6)]">
              <div className="flex items-center justify-between">
                <div className="text-sm text-[var(--gray-11)]">
                  Showing{' '}
                  <span className="font-medium">
                    {table.getState().pagination.pageIndex * PAGE_SIZE + 1}
                  </span>{' '}
                  to{' '}
                  <span className="font-medium">
                    {Math.min(
                      (table.getState().pagination.pageIndex + 1) * PAGE_SIZE,
                      table.getFilteredRowModel().rows.length
                    )}
                  </span>{' '}
                  of{' '}
                  <span className="font-medium">
                    {table.getFilteredRowModel().rows.length}
                  </span>{' '}
                  results
                </div>
                <Pagination
                  total={table.getPageCount()}
                  value={table.getState().pagination.pageIndex + 1}
                  onChange={(page) => table.setPageIndex(page - 1)}
                >
                  <PaginationFirst
                    onClick={() => table.setPageIndex(0)}
                    disabled={!table.getCanPreviousPage()}
                  />
                  <PaginationPrevious
                    onClick={() => table.previousPage()}
                    disabled={!table.getCanPreviousPage()}
                  />
                  <PaginationItems />
                  <PaginationNext
                    onClick={() => table.nextPage()}
                    disabled={!table.getCanNextPage()}
                  />
                  <PaginationLast
                    onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                    disabled={!table.getCanNextPage()}
                  />
                </Pagination>
              </div>
            </div>
          )}
        </Card>
        )}

        {/* View Submission Modal */}
        <Modal
          isOpen={viewModalOpen}
          onClose={() => setViewModalOpen(false)}
          title="Survey Response"
        >
          {selectedSubmission && (
            <div className="space-y-6 max-h-[70vh] overflow-y-auto">
              {/* Metadata */}
              <div className="space-y-2 p-4 bg-[var(--gray-a3)] rounded-lg">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="font-medium text-[var(--gray-11)]">Email:</span>
                    <p className="text-[var(--gray-12)]">{selectedSubmission.user_email}</p>
                  </div>
                  <div>
                    <span className="font-medium text-[var(--gray-11)]">Status:</span>
                    <div className="mt-1">
                      <Badge color={selectedSubmission.is_partial ? 'warning' : 'success'}>
                        {selectedSubmission.is_partial ? 'Partial' : 'Complete'}
                      </Badge>
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-[var(--gray-11)]">Submitted:</span>
                    <p className="text-[var(--gray-12)]">{formatTimestamp(selectedSubmission.created_at)}</p>
                  </div>
                  <div>
                    <span className="font-medium text-[var(--gray-11)]">Duration:</span>
                    <p className="text-[var(--gray-12)]">{formatDuration(selectedSubmission.completion_time_seconds)}</p>
                  </div>
                  {selectedSubmission.event_name && (
                    <div>
                      <span className="font-medium text-[var(--gray-11)]">Event:</span>
                      <p className="text-[var(--gray-12)]">{selectedSubmission.event_name}</p>
                    </div>
                  )}
                  {selectedSubmission.user_id && (
                    <div>
                      <span className="font-medium text-[var(--gray-11)]">User ID:</span>
                      <p className="text-[var(--gray-12)] font-mono text-xs">{selectedSubmission.user_id}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Query Parameters */}
              {selectedSubmission.query_parameters && Object.keys(selectedSubmission.query_parameters).length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-[var(--gray-11)] mb-2">Query Parameters</h4>
                  <div className="p-4 bg-[var(--gray-a3)] rounded-lg">
                    <pre className="text-sm text-[var(--gray-12)] whitespace-pre-wrap">
                      {JSON.stringify(selectedSubmission.query_parameters, null, 2)}
                    </pre>
                  </div>
                </div>
              )}

              {/* Responses */}
              <div>
                <h4 className="text-sm font-medium text-[var(--gray-11)] mb-2">Responses</h4>
                <div className="space-y-3">
                  {Object.entries(selectedSubmission.responses || {}).map(([key, value]) => (
                    <div key={key} className="p-3 border border-[var(--gray-a6)] rounded-lg">
                      <div className="text-sm font-medium text-[var(--gray-11)] mb-1">
                        {getFieldLabel(key)}
                      </div>
                      <div className="text-[var(--gray-12)]">
                        {Array.isArray(value) ? (
                          <ul className="list-disc list-inside">
                            {value.map((item, idx) => (
                              <li key={idx}>{item}</li>
                            ))}
                          </ul>
                        ) : typeof value === 'object' ? (
                          <pre className="text-sm whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre>
                        ) : (
                          value?.toString() || '-'
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Modal>
      </div>
    </Page>
  );
}
