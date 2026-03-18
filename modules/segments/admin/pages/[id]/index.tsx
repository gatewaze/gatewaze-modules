import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  FunnelIcon,
  ArrowLeftIcon,
  UserGroupIcon,
  PencilIcon,
  ArrowPathIcon,
  ArrowDownTrayIcon,
  TrashIcon,
  ClockIcon,
  MagnifyingGlassIcon,
  ChartBarIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  useReactTable,
  getCoreRowModel,
  createColumnHelper,
} from '@tanstack/react-table';
import {
  Card,
  Button,
  Badge,
  Avatar,
  ConfirmModal,
  Tabs,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  Pagination,
  PaginationFirst,
  PaginationLast,
  PaginationNext,
  PaginationPrevious,
  PaginationItems,
} from '@/components/ui';
import { Input } from '@/components/ui/Form';
import { Spinner } from '@/components/ui/Spinner';
import { Page } from '@/components/shared/Page';
import { DataTable } from '@/components/shared/table/DataTable';
import { supabase } from '@/lib/supabase';
import { createSegmentService } from '@/lib/segments';
import type { Segment, SegmentMember, SegmentCalculationHistory } from '@/lib/segments';

const PAGE_SIZE = 25;

const memberColumnHelper = createColumnHelper<SegmentMember>();

function formatDate(dateString: string | undefined): string {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatDuration(ms: number | undefined): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export default function SegmentDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [segment, setSegment] = useState<Segment | null>(null);
  const [members, setMembers] = useState<SegmentMember[]>([]);
  const [totalMembers, setTotalMembers] = useState(0);
  const [history, setHistory] = useState<SegmentCalculationHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [membersLoading, setMembersLoading] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'people' | 'history'>('people');
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const segmentService = useMemo(
    () => (supabase ? createSegmentService(supabase) : null),
    []
  );

  const loadSegment = async () => {
    if (!segmentService || !id) return;

    try {
      setLoading(true);
      const data = await segmentService.getSegment(id);
      if (!data) {
        toast.error('Segment not found');
        navigate('/segments');
        return;
      }
      setSegment(data);

      // Load history
      const historyData = await segmentService.getCalculationHistory(id);
      setHistory(historyData as SegmentCalculationHistory[]);
    } catch (error) {
      console.error('Error loading segment:', error);
      toast.error('Failed to load segment');
    } finally {
      setLoading(false);
    }
  };

  const loadMembers = async () => {
    if (!segmentService || !id) return;

    try {
      setMembersLoading(true);
      const result = await segmentService.getSegmentMembers(id, {
        page: currentPage,
        page_size: PAGE_SIZE,
        search: searchQuery || undefined,
      });
      setMembers(result.members);
      setTotalMembers(result.total);
    } catch (error) {
      console.error('Error loading members:', error);
      toast.error('Failed to load segment members');
    } finally {
      setMembersLoading(false);
    }
  };

  useEffect(() => {
    loadSegment();
  }, [id, segmentService]);

  useEffect(() => {
    if (segment && activeTab === 'people') {
      loadMembers();
    }
  }, [segment, currentPage, searchQuery, activeTab]);

  const handleRecalculate = async () => {
    if (!segmentService || !id) return;

    setRecalculating(true);
    try {
      await segmentService.recalculateSegment(id);
      toast.success('Segment recalculated successfully');
      loadSegment();
      loadMembers();
    } catch (error) {
      console.error('Error recalculating segment:', error);
      toast.error('Failed to recalculate segment');
    } finally {
      setRecalculating(false);
    }
  };

  const handleExport = async () => {
    if (!segmentService || !id || !segment) return;

    try {
      toast.loading('Exporting segment...', { id: 'export' });
      const blob = await segmentService.exportSegmentBlob(id);

      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute(
        'download',
        `segment-${segment.name.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}.csv`
      );
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      toast.success('Segment exported successfully', { id: 'export' });
    } catch (error) {
      console.error('Error exporting segment:', error);
      toast.error('Failed to export segment', { id: 'export' });
    }
  };

  const handleDelete = () => {
    if (!segment) return;

    setConfirmModal({
      isOpen: true,
      title: 'Delete Segment',
      message: `Are you sure you want to delete "${segment.name}"? This action cannot be undone.`,
      onConfirm: async () => {
        if (!segmentService || !id) return;

        try {
          await segmentService.deleteSegment(id);
          toast.success(`Segment "${segment.name}" deleted`);
          navigate('/segments');
        } catch (error) {
          console.error('Error deleting segment:', error);
          toast.error('Failed to delete segment');
        }
      },
    });
  };

  const memberColumns = useMemo(
    () => [
      memberColumnHelper.accessor('email', {
        header: 'Person',
        cell: (info) => {
          const member = info.row.original;
          const name =
            member.attributes?.first_name && member.attributes?.last_name
              ? `${member.attributes.first_name} ${member.attributes.last_name}`
              : member.email;

          return (
            <div className="flex items-center gap-3">
              <Avatar name={name} size={9} initialColor="auto" />
              <div>
                <div className="font-medium text-[var(--gray-12)]">
                  {name}
                </div>
                <div className="text-sm text-[var(--gray-11)]">
                  {member.email}
                </div>
              </div>
            </div>
          );
        },
      }),
      memberColumnHelper.accessor((row) => row.attributes?.company, {
        id: 'company',
        header: 'Company',
        cell: (info) => (
          <span className="text-[var(--gray-11)]">
            {info.getValue() || '-'}
          </span>
        ),
      }),
      memberColumnHelper.accessor((row) => row.attributes?.job_title, {
        id: 'job_title',
        header: 'Job Title',
        cell: (info) => (
          <span className="text-[var(--gray-11)]">
            {info.getValue() || '-'}
          </span>
        ),
      }),
      memberColumnHelper.accessor((row) => row.attributes?.country, {
        id: 'country',
        header: 'Country',
        cell: (info) => (
          <span className="text-[var(--gray-11)]">
            {info.getValue() || '-'}
          </span>
        ),
      }),
    ],
    []
  );

  const table = useReactTable({
    data: members,
    columns: memberColumns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: Math.ceil(totalMembers / PAGE_SIZE),
  });

  if (loading) {
    return (
      <Page title="Loading Segment...">
        <div className="flex items-center justify-center h-96">
          <Spinner className="size-8" />
        </div>
      </Page>
    );
  }

  if (!segment) {
    return (
      <Page title="Segment Not Found">
        <div className="flex flex-col items-center justify-center h-96 gap-4">
          <FunnelIcon className="size-12 text-[var(--gray-a8)]" />
          <p className="text-[var(--gray-11)]">Segment not found</p>
          <Button onClick={() => navigate('/segments')}>Back to Segments</Button>
        </div>
      </Page>
    );
  }

  return (
    <Page title={segment.name}>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-4">
            <Button
              variant="flat"
              isIcon
              onClick={() => navigate('/segments')}
              className="size-10 mt-1"
            >
              <ArrowLeftIcon className="size-5" />
            </Button>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
                  {segment.name}
                </h1>
                <Badge
                  variant="soft"
                  color={segment.status === 'active' ? 'success' : 'warning'}
                >
                  {segment.status}
                </Badge>
                <Badge variant="outlined" color="info">
                  {segment.type}
                </Badge>
              </div>
              {segment.description && (
                <p className="text-[var(--gray-11)] mt-1">
                  {segment.description}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outlined"
              onClick={handleRecalculate}
              disabled={recalculating}
              className="gap-2"
            >
              <ArrowPathIcon
                className={`size-4 ${recalculating ? 'animate-spin' : ''}`}
              />
              Recalculate
            </Button>
            <Button variant="outlined" onClick={handleExport} className="gap-2">
              <ArrowDownTrayIcon className="size-4" />
              Export CSV
            </Button>
            <Button
              variant="outlined"
              onClick={() => navigate(`/segments/${id}/edit`)}
              className="gap-2"
            >
              <PencilIcon className="size-4" />
              Edit
            </Button>
            <Button variant="outlined" color="error" onClick={handleDelete}>
              <TrashIcon className="size-4" />
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card variant="surface" className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-[var(--accent-a3)] rounded-lg">
                <UserGroupIcon className="size-5 text-[var(--accent-9)]" />
              </div>
              <div>
                <div className="text-sm text-[var(--gray-11)]">Total Members</div>
                <div className="text-2xl font-bold">
                  {(segment.cached_count || 0).toLocaleString()}
                </div>
              </div>
            </div>
          </Card>
          <Card variant="surface" className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-[var(--green-a3)] rounded-lg">
                <ClockIcon className="size-5 text-[var(--green-9)]" />
              </div>
              <div>
                <div className="text-sm text-[var(--gray-11)]">Last Calculated</div>
                <div className="text-lg font-medium">
                  {segment.last_calculated_at
                    ? formatDate(segment.last_calculated_at)
                    : 'Never'}
                </div>
              </div>
            </div>
          </Card>
          <Card variant="surface" className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-[var(--purple-a3)] rounded-lg">
                <ChartBarIcon className="size-5 text-[var(--purple-9)]" />
              </div>
              <div>
                <div className="text-sm text-[var(--gray-11)]">Calculation Time</div>
                <div className="text-lg font-medium">
                  {formatDuration(segment.calculation_duration_ms)}
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onChange={(tab) => setActiveTab(tab as 'people' | 'history')}
          tabs={[
            { id: 'people', label: 'People', count: totalMembers },
            { id: 'history', label: 'Calculation History' },
          ]}
        />

        {/* Tab Content */}
        {activeTab === 'people' ? (
          <div className="space-y-4">
            {/* Search */}
            <Input
              placeholder="Search members by name or email..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(0);
              }}
              prefix={<MagnifyingGlassIcon className="size-5 text-[var(--gray-a8)]" />}
            />

            {/* Members Table */}
            <Card className="overflow-hidden">
              <DataTable table={table} loading={membersLoading} />

              {/* Pagination */}
              {!membersLoading && members.length > 0 && (
                <div className="px-6 py-4 bg-[var(--gray-a3)] border-t border-[var(--gray-a6)]">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-[var(--gray-11)]">
                      Showing{' '}
                      <span className="font-medium">
                        {currentPage * PAGE_SIZE + 1}
                      </span>{' '}
                      to{' '}
                      <span className="font-medium">
                        {Math.min((currentPage + 1) * PAGE_SIZE, totalMembers)}
                      </span>{' '}
                      of <span className="font-medium">{totalMembers}</span> members
                    </div>
                    <Pagination
                      total={Math.ceil(totalMembers / PAGE_SIZE)}
                      value={currentPage + 1}
                      onChange={(page) => setCurrentPage(page - 1)}
                    >
                      <PaginationFirst
                        onClick={() => setCurrentPage(0)}
                        disabled={currentPage === 0}
                      />
                      <PaginationPrevious
                        onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                        disabled={currentPage === 0}
                      />
                      <PaginationItems />
                      <PaginationNext
                        onClick={() =>
                          setCurrentPage((p) =>
                            Math.min(Math.ceil(totalMembers / PAGE_SIZE) - 1, p + 1)
                          )
                        }
                        disabled={
                          currentPage >= Math.ceil(totalMembers / PAGE_SIZE) - 1
                        }
                      />
                      <PaginationLast
                        onClick={() =>
                          setCurrentPage(Math.ceil(totalMembers / PAGE_SIZE) - 1)
                        }
                        disabled={
                          currentPage >= Math.ceil(totalMembers / PAGE_SIZE) - 1
                        }
                      />
                    </Pagination>
                  </div>
                </div>
              )}
            </Card>
          </div>
        ) : (
          /* History Tab */
          <Card className="overflow-hidden">
            <Table>
              <THead>
                <Tr>
                  <Th>Date</Th>
                  <Th>People Count</Th>
                  <Th>Duration</Th>
                  <Th>Triggered By</Th>
                </Tr>
              </THead>
              <TBody>
                {history.length === 0 ? (
                  <Tr>
                    <Td colSpan={4} className="text-center py-12">
                      <ClockIcon className="mx-auto h-12 w-12 text-[var(--gray-a8)]" />
                      <p className="mt-2 text-[var(--gray-11)]">No calculation history</p>
                    </Td>
                  </Tr>
                ) : (
                  history.map((entry) => (
                    <Tr key={entry.id}>
                      <Td>
                        {new Date(entry.calculated_at).toLocaleString()}
                      </Td>
                      <Td>
                        <span className="font-medium tabular-nums">
                          {entry.member_count.toLocaleString()}
                        </span>
                      </Td>
                      <Td>{formatDuration(entry.calculation_duration_ms)}</Td>
                      <Td>
                        <Badge variant="soft" color="neutral">
                          {entry.triggered_by || 'manual'}
                        </Badge>
                      </Td>
                    </Tr>
                  ))
                )}
              </TBody>
            </Table>
          </Card>
        )}

        {/* Delete Confirmation Modal */}
        <ConfirmModal
          isOpen={confirmModal.isOpen}
          onClose={() => setConfirmModal({ ...confirmModal, isOpen: false })}
          onConfirm={() => {
            confirmModal.onConfirm();
            setConfirmModal({ ...confirmModal, isOpen: false });
          }}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText="Delete"
          confirmColor="red"
        />
      </div>
    </Page>
  );
}
