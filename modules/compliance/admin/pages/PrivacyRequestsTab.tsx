import { useState, useEffect } from 'react';
import {
  ShieldCheckIcon,
  ClockIcon,
  CheckCircleIcon,
  XCircleIcon,
  ArrowPathIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  EyeIcon,
  TrashIcon,
  DocumentArrowDownIcon,
  UserIcon,
} from '@heroicons/react/24/outline';
import { supabase } from '@/lib/supabase';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Card, Input, Button, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';

interface PrivacyRequest {
  id: string;
  subject_person_id: number | null;
  subject_email: string;
  request_type: 'data_export' | 'data_deletion' | 'data_correction' | 'data_portability' | 'consent_withdrawal' | 'processing_restriction';
  status: 'pending' | 'in_progress' | 'completed' | 'rejected';
  requested_at: string;
  processing_completed_at?: string;
  requester_email: string;
  notes?: string;
  processed_by?: string;
  error_message?: string;
  result_summary?: Record<string, any>;
}

type StatusFilter = 'all' | 'pending' | 'in_progress' | 'completed' | 'rejected';
type RequestTypeFilter = 'all' | 'data_export' | 'data_deletion' | 'data_correction' | 'data_portability' | 'consent_withdrawal' | 'processing_restriction';

const REQUEST_TYPE_LABELS: Record<string, string> = {
  data_export: 'Data Export (DSAR)',
  data_deletion: 'Right to Erasure',
  data_correction: 'Data Correction',
  data_portability: 'Data Portability',
  consent_withdrawal: 'Consent Withdrawal',
  processing_restriction: 'Processing Restriction',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
  rejected: 'Rejected',
};

export function PrivacyRequestsTab() {
  const [requests, setRequests] = useState<PrivacyRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<RequestTypeFilter>('all');
  const [selectedRequest, setSelectedRequest] = useState<PrivacyRequest | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [processing, setProcessing] = useState(false);

  const [stats, setStats] = useState({
    total: 0,
    pending: 0,
    inProgress: 0,
    completed: 0,
    rejected: 0,
  });

  useEffect(() => {
    fetchRequests();
  }, [statusFilter, typeFilter]);

  const fetchRequests = async () => {
    setLoading(true);
    try {
      let query = supabase
        .from('compliance_privacy_requests')
        .select('*')
        .order('requested_at', { ascending: false });

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
      }

      if (typeFilter !== 'all') {
        query = query.eq('request_type', typeFilter);
      }

      if (searchQuery) {
        query = query.or(`requester_email.ilike.%${searchQuery}%,subject_email.ilike.%${searchQuery}%`);
      }

      const { data, error } = await query;

      if (error) throw error;

      setRequests(data || []);

      // Calculate stats
      const allData = data || [];
      setStats({
        total: allData.length,
        pending: allData.filter(r => r.status === 'pending').length,
        inProgress: allData.filter(r => r.status === 'in_progress').length,
        completed: allData.filter(r => r.status === 'completed').length,
        rejected: allData.filter(r => r.status === 'rejected').length,
      });
    } catch (error) {
      console.error('Error fetching privacy requests:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleStatusChange = async (requestId: string, newStatus: string) => {
    setProcessing(true);
    try {
      const updates: any = {
        status: newStatus,
      };

      if (newStatus === 'completed') {
        updates.processing_completed_at = new Date().toISOString();
      }
      if (newStatus === 'in_progress') {
        updates.processing_started_at = new Date().toISOString();
      }

      const { error } = await supabase
        .from('compliance_privacy_requests')
        .update(updates)
        .eq('id', requestId);

      if (error) throw error;

      await fetchRequests();
      setShowModal(false);
      setSelectedRequest(null);
    } catch (error) {
      console.error('Error updating request status:', error);
    } finally {
      setProcessing(false);
    }
  };

  const handleExportData = async (customerId: number) => {
    setProcessing(true);
    try {
      const { data, error } = await supabase.rpc('compliance_export_user_data', {
        p_person_id: customerId,
      });

      if (error) throw error;

      // Download as JSON file
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `user-data-export-${customerId}-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error exporting data:', error);
    } finally {
      setProcessing(false);
    }
  };

  const handleDeleteUserData = async (customerId: number, requestId: string) => {
    if (!confirm('Are you sure you want to permanently delete all data for this user? This action cannot be undone.')) {
      return;
    }

    setProcessing(true);
    try {
      const { error } = await supabase.rpc('compliance_delete_user_data', {
        p_person_id: customerId,
      });

      if (error) throw error;

      // Mark request as completed
      await handleStatusChange(requestId, 'completed');
    } catch (error) {
      console.error('Error deleting user data:', error);
    } finally {
      setProcessing(false);
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200">
            <ClockIcon className="size-3" />
            Pending
          </span>
        );
      case 'in_progress':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
            <ArrowPathIcon className="size-3" />
            In Progress
          </span>
        );
      case 'completed':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200">
            <CheckCircleIcon className="size-3" />
            Completed
          </span>
        );
      case 'rejected':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200">
            <XCircleIcon className="size-3" />
            Rejected
          </span>
        );
      default:
        return null;
    }
  };

  const getRequestTypeBadge = (type: string) => {
    const colors: Record<string, string> = {
      access: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-200',
      deletion: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200',
      rectification: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200',
      portability: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-200',
      restriction: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200',
      objection: 'bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-200',
    };

    return (
      <span className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded-full ${colors[type] || colors.access}`}>
        {REQUEST_TYPE_LABELS[type] || type}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.total}</div>
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Requests</div>
        </div>
        <div className="bg-yellow-50 dark:bg-yellow-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-yellow-900 dark:text-yellow-200">{stats.pending}</div>
          <div className="text-sm text-yellow-600 dark:text-yellow-400">Pending</div>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-blue-900 dark:text-blue-200">{stats.inProgress}</div>
          <div className="text-sm text-blue-600 dark:text-blue-400">In Progress</div>
        </div>
        <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-green-900 dark:text-green-200">{stats.completed}</div>
          <div className="text-sm text-green-600 dark:text-green-400">Completed</div>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-red-900 dark:text-red-200">{stats.rejected}</div>
          <div className="text-sm text-red-600 dark:text-red-400">Rejected</div>
        </div>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-4 items-end">
          {/* Search */}
          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Search
            </label>
            <div className="flex gap-2">
              <Input
                placeholder="Search by email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && fetchRequests()}
                className="flex-1"
              />
              <Button onClick={fetchRequests} variant="outline" className="gap-1">
                <MagnifyingGlassIcon className="size-4" />
                Search
              </Button>
            </div>
          </div>

          {/* Status Filter */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Status
            </label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            >
              <option value="all">All Status</option>
              <option value="pending">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>

          {/* Request Type Filter */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Request Type
            </label>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as RequestTypeFilter)}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            >
              <option value="all">All Types</option>
              <option value="data_export">Data Export (DSAR)</option>
              <option value="data_deletion">Right to Erasure</option>
              <option value="data_correction">Data Correction</option>
              <option value="data_portability">Data Portability</option>
              <option value="consent_withdrawal">Consent Withdrawal</option>
              <option value="processing_restriction">Processing Restriction</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Request List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner size="medium" />
        </div>
      ) : requests.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <ShieldCheckIcon className="size-12 mx-auto mb-4 opacity-50" />
          <p>No privacy requests found.</p>
          <p className="text-sm mt-2">Requests submitted through the privacy portal will appear here.</p>
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>Request</Th>
                  <Th>Type</Th>
                  <Th>Status</Th>
                  <Th>Submitted</Th>
                  <Th />
                </Tr>
              </THead>
              <TBody>
                {requests.map((request) => (
                  <Tr key={request.id}>
                    <Td>
                      <div className="flex items-center gap-3">
                        <div className="flex-shrink-0">
                          <div className="size-10 rounded-full bg-[var(--gray-a3)] flex items-center justify-center">
                            <UserIcon className="size-5" />
                          </div>
                        </div>
                        <div>
                          <div className="text-sm font-medium">
                            {request.subject_email}
                          </div>
                          {request.subject_person_id && (
                            <div className="text-xs">
                              Customer ID: {request.subject_person_id}
                            </div>
                          )}
                        </div>
                      </div>
                    </Td>
                    <Td>
                      {getRequestTypeBadge(request.request_type)}
                    </Td>
                    <Td>
                      {getStatusBadge(request.status)}
                    </Td>
                    <Td>
                      <div>{formatDate(request.requested_at)}</div>
                      {request.processing_completed_at && (
                        <div className="text-xs text-[var(--green-11)]">
                          Completed: {formatDate(request.processing_completed_at)}
                        </div>
                      )}
                    </Td>
                    <Td>
                      <RowActions
                        actions={[
                          {
                            label: 'View Details',
                            icon: <EyeIcon className="size-4" />,
                            onClick: () => { setSelectedRequest(request); setShowModal(true); },
                          },
                          {
                            label: 'Export User Data',
                            icon: <DocumentArrowDownIcon className="size-4" />,
                            onClick: () => handleExportData(request.subject_person_id!),
                            disabled: processing,
                            hidden: !((request.request_type === 'data_export' || request.request_type === 'data_portability') && request.status !== 'completed' && request.subject_person_id),
                          },
                          {
                            label: 'Delete User Data',
                            icon: <TrashIcon className="size-4" />,
                            onClick: () => handleDeleteUserData(request.subject_person_id!, request.id),
                            disabled: processing,
                            color: 'red',
                            hidden: !(request.request_type === 'data_deletion' && request.status !== 'completed' && request.subject_person_id),
                          },
                        ]}
                      />
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        </Card>
      )}

      {/* Detail Modal */}
      {showModal && selectedRequest && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200 dark:border-gray-700">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    Privacy Request Details
                  </h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    Request ID: {selectedRequest.id}
                  </p>
                </div>
                <Button
                  isIcon
                  variant="ghost"
                  onClick={() => { setShowModal(false); setSelectedRequest(null); }}
                >
                  <XCircleIcon className="size-6" />
                </Button>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Request Type
                  </label>
                  <div className="mt-1">{getRequestTypeBadge(selectedRequest.request_type)}</div>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Status
                  </label>
                  <div className="mt-1">{getStatusBadge(selectedRequest.status)}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Subject Email
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white">
                    {selectedRequest.subject_email}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Requester Email
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white">
                    {selectedRequest.requester_email}
                  </div>
                </div>
              </div>

              {selectedRequest.subject_person_id && (
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Customer ID
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white">
                    {selectedRequest.subject_person_id}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Requested At
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white">
                    {formatDate(selectedRequest.requested_at)}
                  </div>
                </div>
                {selectedRequest.processing_completed_at && (
                  <div>
                    <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Completed At
                    </label>
                    <div className="mt-1 text-sm text-gray-900 dark:text-white">
                      {formatDate(selectedRequest.processing_completed_at)}
                    </div>
                  </div>
                )}
              </div>

              {selectedRequest.notes && (
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Notes
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700 p-3 rounded">
                    {selectedRequest.notes}
                  </div>
                </div>
              )}

              {selectedRequest.error_message && (
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Error / Rejection Reason
                  </label>
                  <div className="mt-1 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-3 rounded">
                    {selectedRequest.error_message}
                  </div>
                </div>
              )}

              {/* Status Update Actions */}
              {selectedRequest.status !== 'completed' && selectedRequest.status !== 'rejected' && (
                <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Update Status
                  </label>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {selectedRequest.status === 'pending' && (
                      <Button
                        onClick={() => handleStatusChange(selectedRequest.id, 'in_progress')}
                        disabled={processing}
                        variant="outline"
                        size="sm"
                        className="gap-1"
                      >
                        <ArrowPathIcon className="size-4" />
                        Start Processing
                      </Button>
                    )}
                    <Button
                      onClick={() => handleStatusChange(selectedRequest.id, 'completed')}
                      disabled={processing}
                      variant="solid"
                      color="green"
                      size="sm"
                    >
                      <CheckCircleIcon className="size-4" />
                      Mark Completed
                    </Button>
                    <Button
                      onClick={() => handleStatusChange(selectedRequest.id, 'rejected')}
                      disabled={processing}
                      variant="outline"
                      color="red"
                      size="sm"
                    >
                      <XCircleIcon className="size-4" />
                      Reject
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <div className="flex justify-end gap-2">
                <Button
                  onClick={() => { setShowModal(false); setSelectedRequest(null); }}
                  variant="outline"
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
