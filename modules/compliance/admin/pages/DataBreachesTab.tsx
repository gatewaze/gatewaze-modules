import { useState, useEffect } from 'react';
import {
  ExclamationTriangleIcon,
  ClockIcon,
  CheckCircleIcon,
  XCircleIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  EyeIcon,
  UserGroupIcon,
  BellAlertIcon,
} from '@heroicons/react/24/outline';
import { supabase } from '@/lib/supabase';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Card, Input, Button, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';

interface DataBreach {
  id: string;
  breach_name: string;
  breach_description?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'detected' | 'investigating' | 'contained' | 'resolved' | 'reported';
  detected_at: string;
  contained_at?: string;
  resolved_at?: string;
  reported_to_authority_at?: string;
  authority_reference?: string;
  data_types_affected?: string[];
  estimated_records_affected?: number;
  root_cause?: string;
  remediation_steps?: string;
  lessons_learned?: string;
  created_at: string;
  affected_customers_count?: number;
}

interface AffectedCustomer {
  id: string;
  breach_id: string;
  person_id: number;
  notified_at?: string;
  notification_method?: string;
  customer?: {
    email: string;
    attributes: Record<string, any>;
  };
}

type StatusFilter = 'all' | 'detected' | 'investigating' | 'contained' | 'resolved' | 'reported';
type SeverityFilter = 'all' | 'low' | 'medium' | 'high' | 'critical';

const SEVERITY_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

const STATUS_LABELS: Record<string, string> = {
  detected: 'Detected',
  investigating: 'Investigating',
  contained: 'Contained',
  resolved: 'Resolved',
  reported: 'Reported to Authority',
};

export function DataBreachesTab() {
  const [breaches, setBreaches] = useState<DataBreach[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [selectedBreach, setSelectedBreach] = useState<DataBreach | null>(null);
  const [affectedCustomers, setAffectedCustomers] = useState<AffectedCustomer[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showNewBreachForm, setShowNewBreachForm] = useState(false);
  const [processing, setProcessing] = useState(false);

  const [stats, setStats] = useState({
    total: 0,
    active: 0,
    resolved: 0,
    critical: 0,
    totalAffected: 0,
  });

  const [newBreach, setNewBreach] = useState({
    breach_name: '',
    breach_description: '',
    severity: 'medium' as const,
    data_types_affected: [] as string[],
    estimated_records_affected: 0,
  });

  useEffect(() => {
    fetchBreaches();
  }, [statusFilter, severityFilter]);

  const fetchBreaches = async () => {
    setLoading(true);
    try {
      let query = supabase
        .from('compliance_data_breaches')
        .select('*')
        .order('detected_at', { ascending: false });

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
      }

      if (severityFilter !== 'all') {
        query = query.eq('severity', severityFilter);
      }

      if (searchQuery) {
        query = query.or(`breach_name.ilike.%${searchQuery}%,breach_description.ilike.%${searchQuery}%`);
      }

      const { data, error } = await query;

      if (error) throw error;

      // Fetch affected customer counts for each breach
      const breachesWithCounts = await Promise.all(
        (data || []).map(async (breach) => {
          const { count } = await supabase
            .from('compliance_data_breach_affected_people')
            .select('*', { count: 'exact', head: true })
            .eq('breach_id', breach.id);

          return {
            ...breach,
            affected_customers_count: count || 0,
          };
        })
      );

      setBreaches(breachesWithCounts);

      // Calculate stats
      const allData = breachesWithCounts;
      const activeStatuses = ['detected', 'investigating', 'contained'];
      setStats({
        total: allData.length,
        active: allData.filter(b => activeStatuses.includes(b.status)).length,
        resolved: allData.filter(b => b.status === 'resolved' || b.status === 'reported').length,
        critical: allData.filter(b => b.severity === 'critical').length,
        totalAffected: allData.reduce((sum, b) => sum + (b.affected_customers_count || 0), 0),
      });
    } catch (error) {
      console.error('Error fetching breaches:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchAffectedCustomers = async (breachId: string) => {
    try {
      const { data, error } = await supabase
        .from('compliance_data_breach_affected_people')
        .select(`
          *,
          customer:people!person_id(email, attributes)
        `)
        .eq('breach_id', breachId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      setAffectedCustomers(data || []);
    } catch (error) {
      console.error('Error fetching affected customers:', error);
    }
  };

  const handleCreateBreach = async () => {
    if (!newBreach.breach_name) return;

    setProcessing(true);
    try {
      const { error } = await supabase
        .from('compliance_data_breaches')
        .insert({
          breach_name: newBreach.breach_name,
          breach_description: newBreach.breach_description,
          severity: newBreach.severity,
          status: 'detected',
          detected_at: new Date().toISOString(),
          data_types_affected: newBreach.data_types_affected,
          estimated_records_affected: newBreach.estimated_records_affected,
        });

      if (error) throw error;

      setShowNewBreachForm(false);
      setNewBreach({
        breach_name: '',
        breach_description: '',
        severity: 'medium',
        data_types_affected: [],
        estimated_records_affected: 0,
      });
      await fetchBreaches();
    } catch (error) {
      console.error('Error creating breach:', error);
    } finally {
      setProcessing(false);
    }
  };

  const handleStatusChange = async (breachId: string, newStatus: string) => {
    setProcessing(true);
    try {
      const updates: any = {
        status: newStatus,
      };

      if (newStatus === 'contained') {
        updates.contained_at = new Date().toISOString();
      } else if (newStatus === 'resolved') {
        updates.resolved_at = new Date().toISOString();
      } else if (newStatus === 'reported') {
        updates.reported_to_authority_at = new Date().toISOString();
      }

      const { error } = await supabase
        .from('compliance_data_breaches')
        .update(updates)
        .eq('id', breachId);

      if (error) throw error;

      await fetchBreaches();
      if (selectedBreach?.id === breachId) {
        setSelectedBreach({ ...selectedBreach, ...updates });
      }
    } catch (error) {
      console.error('Error updating breach status:', error);
    } finally {
      setProcessing(false);
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
  };

  const getSeverityBadge = (severity: string) => {
    const colors: Record<string, string> = {
      low: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200',
      medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200',
      high: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200',
      critical: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200',
    };

    return (
      <span className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded-full ${colors[severity] || colors.medium}`}>
        {SEVERITY_LABELS[severity] || severity}
      </span>
    );
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      detected: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200',
      investigating: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200',
      contained: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200',
      resolved: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200',
      reported: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-200',
    };

    return (
      <span className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded-full ${colors[status] || colors.detected}`}>
        {STATUS_LABELS[status] || status}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.total}</div>
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Incidents</div>
        </div>
        <div className="bg-yellow-50 dark:bg-yellow-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-yellow-900 dark:text-yellow-200">{stats.active}</div>
          <div className="text-sm text-yellow-600 dark:text-yellow-400">Active</div>
        </div>
        <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-green-900 dark:text-green-200">{stats.resolved}</div>
          <div className="text-sm text-green-600 dark:text-green-400">Resolved</div>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-red-900 dark:text-red-200">{stats.critical}</div>
          <div className="text-sm text-red-600 dark:text-red-400">Critical</div>
        </div>
        <div className="bg-purple-50 dark:bg-purple-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-purple-900 dark:text-purple-200">{stats.totalAffected}</div>
          <div className="text-sm text-purple-600 dark:text-purple-400">Users Affected</div>
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
                placeholder="Search breaches..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && fetchBreaches()}
                className="flex-1"
              />
              <Button onClick={fetchBreaches} variant="outline" className="gap-1">
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
              <option value="detected">Detected</option>
              <option value="investigating">Investigating</option>
              <option value="contained">Contained</option>
              <option value="resolved">Resolved</option>
              <option value="reported">Reported</option>
            </select>
          </div>

          {/* Severity Filter */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Severity
            </label>
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value as SeverityFilter)}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            >
              <option value="all">All Severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>

          {/* New Breach Button */}
          <Button
            onClick={() => setShowNewBreachForm(true)}
            className="gap-1"
          >
            <PlusIcon className="size-4" />
            Log Incident
          </Button>
        </div>
      </Card>

      {/* Breach List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner size="medium" />
        </div>
      ) : breaches.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <ExclamationTriangleIcon className="size-12 mx-auto mb-4 opacity-50" />
          <p>No data breach incidents found.</p>
          <p className="text-sm mt-2">Use the "Log Incident" button to record a new breach.</p>
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>Incident</Th>
                  <Th>Severity</Th>
                  <Th>Status</Th>
                  <Th>Affected</Th>
                  <Th>Detected</Th>
                  <Th />
                </Tr>
              </THead>
              <TBody>
                {breaches.map((breach) => (
                  <Tr key={breach.id}>
                    <Td>
                      <div className="text-sm font-medium">
                        {breach.breach_name}
                      </div>
                      {breach.breach_description && (
                        <div className="text-xs truncate max-w-[300px]">
                          {breach.breach_description}
                        </div>
                      )}
                    </Td>
                    <Td>
                      {getSeverityBadge(breach.severity)}
                    </Td>
                    <Td>
                      {getStatusBadge(breach.status)}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1 text-sm">
                        <UserGroupIcon className="size-4" />
                        {breach.affected_customers_count || breach.estimated_records_affected || 0}
                      </div>
                    </Td>
                    <Td>
                      {formatDate(breach.detected_at)}
                    </Td>
                    <Td>
                      <RowActions
                        actions={[
                          {
                            label: 'View Details',
                            icon: <EyeIcon className="size-4" />,
                            onClick: async () => {
                              setSelectedBreach(breach);
                              await fetchAffectedCustomers(breach.id);
                              setShowModal(true);
                            },
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

      {/* New Breach Modal */}
      {showNewBreachForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full">
            <div className="p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Log New Data Breach Incident
              </h3>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Incident Name *
                </label>
                <Input
                  value={newBreach.breach_name}
                  onChange={(e) => setNewBreach({ ...newBreach, breach_name: e.target.value })}
                  placeholder="e.g., Email List Exposure"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Description
                </label>
                <textarea
                  value={newBreach.breach_description}
                  onChange={(e) => setNewBreach({ ...newBreach, breach_description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  rows={3}
                  placeholder="Describe what happened..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Severity
                </label>
                <select
                  value={newBreach.severity}
                  onChange={(e) => setNewBreach({ ...newBreach, severity: e.target.value as any })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Estimated Records Affected
                </label>
                <Input
                  type="number"
                  value={newBreach.estimated_records_affected}
                  onChange={(e) => setNewBreach({ ...newBreach, estimated_records_affected: parseInt(e.target.value) || 0 })}
                  placeholder="0"
                />
              </div>
            </div>

            <div className="p-6 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <div className="flex justify-end gap-2">
                <Button
                  onClick={() => setShowNewBreachForm(false)}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleCreateBreach}
                  disabled={processing || !newBreach.breach_name}
                >
                  Log Incident
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Breach Detail Modal */}
      {showModal && selectedBreach && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200 dark:border-gray-700">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    {selectedBreach.breach_name}
                  </h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    Incident ID: {selectedBreach.id}
                  </p>
                </div>
                <Button
                  isIcon
                  variant="ghost"
                  onClick={() => { setShowModal(false); setSelectedBreach(null); }}
                >
                  <XCircleIcon className="size-6" />
                </Button>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Severity
                  </label>
                  <div className="mt-1">{getSeverityBadge(selectedBreach.severity)}</div>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Status
                  </label>
                  <div className="mt-1">{getStatusBadge(selectedBreach.status)}</div>
                </div>
              </div>

              {selectedBreach.breach_description && (
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Description
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700 p-3 rounded">
                    {selectedBreach.breach_description}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Detected At
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white">
                    {formatDate(selectedBreach.detected_at)}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Estimated Records Affected
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white">
                    {selectedBreach.estimated_records_affected || 'Unknown'}
                  </div>
                </div>
              </div>

              {selectedBreach.contained_at && (
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Contained At
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white">
                    {formatDate(selectedBreach.contained_at)}
                  </div>
                </div>
              )}

              {selectedBreach.reported_to_authority_at && (
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Reported to Authority
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white">
                    {formatDate(selectedBreach.reported_to_authority_at)}
                    {selectedBreach.authority_reference && ` (Ref: ${selectedBreach.authority_reference})`}
                  </div>
                </div>
              )}

              {/* Affected Customers */}
              {affectedCustomers.length > 0 && (
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Affected Customers ({affectedCustomers.length})
                  </label>
                  <div className="mt-2 max-h-40 overflow-y-auto bg-gray-50 dark:bg-gray-700 rounded">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 dark:border-gray-600">
                          <th className="px-3 py-2 text-left">Email</th>
                          <th className="px-3 py-2 text-left">Notified</th>
                        </tr>
                      </thead>
                      <tbody>
                        {affectedCustomers.map((ac) => (
                          <tr key={ac.id} className="border-b border-gray-200 dark:border-gray-600 last:border-0">
                            <td className="px-3 py-2 text-gray-900 dark:text-white">
                              {ac.customer?.email || `Customer #${ac.person_id}`}
                            </td>
                            <td className="px-3 py-2">
                              {ac.notified_at ? (
                                <span className="text-green-600 dark:text-green-400">
                                  {formatDate(ac.notified_at)}
                                </span>
                              ) : (
                                <span className="text-gray-400">Not notified</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Status Update Actions */}
              {selectedBreach.status !== 'resolved' && selectedBreach.status !== 'reported' && (
                <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Update Status
                  </label>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {selectedBreach.status === 'detected' && (
                      <Button
                        onClick={() => handleStatusChange(selectedBreach.id, 'investigating')}
                        disabled={processing}
                        variant="outline"
                        size="sm"
                      >
                        Start Investigation
                      </Button>
                    )}
                    {(selectedBreach.status === 'detected' || selectedBreach.status === 'investigating') && (
                      <Button
                        onClick={() => handleStatusChange(selectedBreach.id, 'contained')}
                        disabled={processing}
                        variant="outline"
                        size="sm"
                      >
                        Mark Contained
                      </Button>
                    )}
                    {selectedBreach.status === 'contained' && (
                      <>
                        <Button
                          onClick={() => handleStatusChange(selectedBreach.id, 'resolved')}
                          disabled={processing}
                          variant="solid"
                          color="green"
                          size="sm"
                        >
                          <CheckCircleIcon className="size-4" />
                          Mark Resolved
                        </Button>
                        <Button
                          onClick={() => handleStatusChange(selectedBreach.id, 'reported')}
                          disabled={processing}
                          variant="outline"
                          size="sm"
                          className="gap-1"
                        >
                          <BellAlertIcon className="size-4" />
                          Report to Authority
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <div className="flex justify-end gap-2">
                <Button
                  onClick={() => { setShowModal(false); setSelectedBreach(null); }}
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
