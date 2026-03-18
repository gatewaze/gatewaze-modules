import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  ClipboardDocumentListIcon,
  MagnifyingGlassIcon,
  ArrowPathIcon,
  EyeIcon,
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
} from '@/components/ui';
import { Input } from '@/components/ui/Form';
import { Page } from '@/components/shared/Page';
import { DataTable } from '@/components/shared/table/DataTable';
import { RowActions } from '@/components/shared/table/RowActions';
import { supabase } from '@/lib/supabase';

const PAGE_SIZE = 25;

interface SurveySchema {
  id: string;
  survey_id: string;
  name: string;
  description: string | null;
  version: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  submission_count?: number;
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

const columnHelper = createColumnHelper<SurveySchema>();

export default function SurveysPage() {
  const navigate = useNavigate();
  const [surveys, setSurveys] = useState<SurveySchema[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'updated_at', desc: true }
  ]);

  const loadSurveys = async () => {
    try {
      setLoading(true);

      // Fetch all survey schemas
      const { data: schemas, error: schemasError } = await supabase
        .from('surveys_schemas')
        .select('*')
        .order('updated_at', { ascending: false });

      if (schemasError) {
        console.error('Error fetching survey schemas:', schemasError);
        // Don't return - continue to fetch from submissions
      }

      // Fetch all unique survey_ids from submissions (to catch surveys without schemas)
      const { data: submissionSurveys, error: submissionError } = await supabase
        .from('surveys_submissions')
        .select('survey_id')
        .order('survey_id');

      if (submissionError) {
        console.error('Error fetching submission survey IDs:', submissionError);
      }

      // Get unique survey IDs from submissions
      const submissionSurveyIds = [...new Set((submissionSurveys || []).map(s => s.survey_id))];
      const schemaSurveyIds = new Set((schemas || []).map(s => s.survey_id));

      // Create placeholder entries for surveys that have submissions but no schema
      const missingSchemas: SurveySchema[] = submissionSurveyIds
        .filter(id => !schemaSurveyIds.has(id))
        .map(surveyId => ({
          id: surveyId,
          survey_id: surveyId,
          name: surveyId,
          description: 'Schema not synced',
          version: 'unknown',
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }));

      const allSchemas = [...(schemas || []), ...missingSchemas];

      // Fetch unique user counts for each survey (count distinct user_email)
      const surveysWithCounts = await Promise.all(
        allSchemas.map(async (schema) => {
          // Fetch all user_emails for this survey to count unique users
          const { data: submissions, error: submissionsError } = await supabase
            .from('surveys_submissions')
            .select('user_email')
            .eq('survey_id', schema.survey_id);

          // Count unique user_emails
          const uniqueUsers = submissionsError
            ? 0
            : new Set((submissions || []).map(s => s.user_email)).size;

          return {
            ...schema,
            submission_count: uniqueUsers,
          };
        })
      );

      setSurveys(surveysWithCounts);
    } catch (error) {
      console.error('Error loading surveys:', error);
      toast.error('Failed to load surveys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSurveys();
  }, []);

  const columns = useMemo(
    () => [
      columnHelper.accessor('survey_id', {
        header: 'Survey ID',
        cell: (info) => (
          <div className="text-sm font-mono text-[var(--gray-12)]">
            {info.getValue()}
          </div>
        ),
      }),
      columnHelper.accessor('name', {
        header: 'Name',
        cell: (info) => (
          <div className="text-sm font-medium text-[var(--gray-12)] max-w-xs truncate" title={info.getValue()}>
            {info.getValue()}
          </div>
        ),
      }),
      columnHelper.accessor('description', {
        header: 'Description',
        cell: (info) => (
          <div className="text-sm text-[var(--gray-11)] max-w-xs truncate" title={info.getValue() || ''}>
            {info.getValue() || '-'}
          </div>
        ),
      }),
      columnHelper.accessor('submission_count', {
        header: 'Respondents',
        cell: (info) => (
          <Badge color={info.getValue() && info.getValue()! > 0 ? 'success' : 'neutral'}>
            {info.getValue()?.toLocaleString() || 0}
          </Badge>
        ),
      }),
      columnHelper.accessor('is_active', {
        header: 'Status',
        cell: (info) => (
          <Badge color={info.getValue() ? 'success' : 'neutral'}>
            {info.getValue() ? 'Active' : 'Inactive'}
          </Badge>
        ),
      }),
      columnHelper.accessor('updated_at', {
        header: 'Last Updated',
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
          const survey = info.row.original;
          return (
            <RowActions
              actions={[
                { label: 'View Submissions', icon: <EyeIcon className="size-4" />, onClick: () => navigate(`/surveys/${survey.survey_id}`) },
              ]}
            />
          );
        },
      }),
    ],
    [navigate]
  );

  const table = useReactTable({
    data: surveys,
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

  const handleRefresh = () => {
    loadSurveys();
  };

  const totalRespondents = surveys.reduce((sum, s) => sum + (s.submission_count || 0), 0);

  return (
    <Page title="Surveys">
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Surveys Dashboard
            </h1>
            <p className="text-[var(--gray-11)] mt-1">
              View and manage survey submissions
            </p>
          </div>
          <div className="flex gap-3 items-center">
            <Button
              onClick={handleRefresh}
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card variant="surface" className="p-6">
            <div className="flex items-center gap-3">
              <ClipboardDocumentListIcon className="size-6 text-[var(--accent-9)]" />
              <div>
                <div className="text-sm font-medium text-[var(--gray-11)]">Total Surveys</div>
                <div className="text-2xl font-bold mt-1">{surveys.length}</div>
              </div>
            </div>
          </Card>
          <Card variant="surface" className="p-6">
            <div className="flex items-center gap-3">
              <ClipboardDocumentListIcon className="size-6 text-[var(--accent-9)]" />
              <div>
                <div className="text-sm font-medium text-[var(--gray-11)]">Total Respondents</div>
                <div className="text-2xl font-bold mt-1">{totalRespondents.toLocaleString()}</div>
              </div>
            </div>
          </Card>
        </div>

        {/* Search */}
        <Card variant="surface" className="p-4">
          <Input
            placeholder="Search surveys..."
            value={globalFilter ?? ''}
            onChange={(e) => setGlobalFilter(e.target.value)}
            prefix={<MagnifyingGlassIcon className="size-5 text-[var(--gray-a8)]" />}
          />
        </Card>

        {/* Surveys Table */}
        <Card className="overflow-hidden">
          <DataTable table={table} loading={loading} onRowDoubleClick={(survey) => navigate(`/surveys/${survey.survey_id}`)} />

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
      </div>
    </Page>
  );
}
