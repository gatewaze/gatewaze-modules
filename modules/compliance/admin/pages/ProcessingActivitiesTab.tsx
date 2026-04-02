import { useState, useEffect } from 'react';
import {
  ClipboardDocumentListIcon,
  PlusIcon,
  PencilSquareIcon,
  TrashIcon,
  EyeIcon,
  XCircleIcon,
  DocumentArrowDownIcon,
} from '@heroicons/react/24/outline';
import { supabase } from '@/lib/supabase';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Card, Input, Button, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';

interface ProcessingActivity {
  id: string;
  activity_name: string;
  purpose: string;
  legal_basis: string;
  data_categories: string[];
  data_subjects: string[];
  recipients?: string[];
  retention_period?: string;
  security_measures?: string;
  dpia_required?: boolean;
  dpia_conducted?: boolean;
  dpia_reference?: string;
  third_country_transfers?: boolean;
  transfer_safeguards?: string;
  joint_controller?: boolean;
  joint_controller_details?: string;
  status: 'active' | 'archived' | 'draft';
  created_at: string;
  updated_at: string;
}

const LEGAL_BASIS_OPTIONS = [
  { value: 'consent', label: 'Consent (Art. 6(1)(a))' },
  { value: 'contract', label: 'Contract Performance (Art. 6(1)(b))' },
  { value: 'legal_obligation', label: 'Legal Obligation (Art. 6(1)(c))' },
  { value: 'vital_interests', label: 'Vital Interests (Art. 6(1)(d))' },
  { value: 'public_task', label: 'Public Task (Art. 6(1)(e))' },
  { value: 'legitimate_interests', label: 'Legitimate Interests (Art. 6(1)(f))' },
];

const DATA_CATEGORIES_OPTIONS = [
  'Personal identifiers (name, email)',
  'Contact information',
  'Employment data',
  'Financial data',
  'Location data',
  'Online identifiers (IP, cookies)',
  'Behavioral data',
  'Preferences and interests',
  'Communication data',
  'Health data (special category)',
  'Biometric data (special category)',
];

const DATA_SUBJECTS_OPTIONS = [
  'Customers',
  'Prospective customers',
  'Newsletter subscribers',
  'Event attendees',
  'Website visitors',
  'Employees',
  'Business partners',
  'Suppliers',
];

export function ProcessingActivitiesTab() {
  const [activities, setActivities] = useState<ProcessingActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedActivity, setSelectedActivity] = useState<ProcessingActivity | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [processing, setProcessing] = useState(false);

  const [editForm, setEditForm] = useState<Partial<ProcessingActivity>>({
    activity_name: '',
    purpose: '',
    legal_basis: 'consent',
    data_categories: [],
    data_subjects: [],
    recipients: [],
    retention_period: '',
    security_measures: '',
    dpia_required: false,
    third_country_transfers: false,
    status: 'draft',
  });

  const [stats, setStats] = useState({
    total: 0,
    active: 0,
    requireDpia: 0,
    withTransfers: 0,
  });

  useEffect(() => {
    fetchActivities();
  }, []);

  const fetchActivities = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('compliance_processing_activities')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      setActivities(data || []);

      // Calculate stats
      const allData = data || [];
      setStats({
        total: allData.length,
        active: allData.filter(a => a.status === 'active').length,
        requireDpia: allData.filter(a => a.dpia_required).length,
        withTransfers: allData.filter(a => a.third_country_transfers).length,
      });
    } catch (error) {
      console.error('Error fetching processing activities:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!editForm.activity_name || !editForm.purpose) return;

    setProcessing(true);
    try {
      if (selectedActivity) {
        // Update existing
        const { error } = await supabase
          .from('compliance_processing_activities')
          .update(editForm)
          .eq('id', selectedActivity.id);

        if (error) throw error;
      } else {
        // Create new
        const { error } = await supabase
          .from('compliance_processing_activities')
          .insert(editForm);

        if (error) throw error;
      }

      setShowEditModal(false);
      setSelectedActivity(null);
      resetForm();
      await fetchActivities();
    } catch (error) {
      console.error('Error saving processing activity:', error);
    } finally {
      setProcessing(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this processing activity?')) return;

    setProcessing(true);
    try {
      const { error } = await supabase
        .from('compliance_processing_activities')
        .delete()
        .eq('id', id);

      if (error) throw error;

      await fetchActivities();
      setShowModal(false);
      setSelectedActivity(null);
    } catch (error) {
      console.error('Error deleting processing activity:', error);
    } finally {
      setProcessing(false);
    }
  };

  const resetForm = () => {
    setEditForm({
      activity_name: '',
      purpose: '',
      legal_basis: 'consent',
      data_categories: [],
      data_subjects: [],
      recipients: [],
      retention_period: '',
      security_measures: '',
      dpia_required: false,
      third_country_transfers: false,
      status: 'draft',
    });
  };

  const openEditModal = (activity?: ProcessingActivity) => {
    if (activity) {
      setSelectedActivity(activity);
      setEditForm(activity);
    } else {
      setSelectedActivity(null);
      resetForm();
    }
    setShowEditModal(true);
  };

  const exportToJson = () => {
    const exportData = activities.map(a => ({
      ...a,
      exported_at: new Date().toISOString(),
    }));

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ropa-export-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleDateString();
  };

  const getLegalBasisLabel = (basis: string) => {
    return LEGAL_BASIS_OPTIONS.find(o => o.value === basis)?.label || basis;
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      active: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200',
      draft: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200',
      archived: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200',
    };

    return (
      <span className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded-full ${colors[status] || colors.draft}`}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    );
  };

  const toggleArrayItem = (array: string[], item: string): string[] => {
    if (array.includes(item)) {
      return array.filter(i => i !== item);
    }
    return [...array, item];
  };

  return (
    <div className="space-y-6">
      {/* Header with Stats */}
      <div className="flex flex-wrap gap-4 justify-between items-start">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 flex-1">
          <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
            <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.total}</div>
            <div className="text-sm text-gray-600 dark:text-gray-400">Total Activities</div>
          </div>
          <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded-lg">
            <div className="text-2xl font-bold text-green-900 dark:text-green-200">{stats.active}</div>
            <div className="text-sm text-green-600 dark:text-green-400">Active</div>
          </div>
          <div className="bg-orange-50 dark:bg-orange-900/20 p-4 rounded-lg">
            <div className="text-2xl font-bold text-orange-900 dark:text-orange-200">{stats.requireDpia}</div>
            <div className="text-sm text-orange-600 dark:text-orange-400">Require DPIA</div>
          </div>
          <div className="bg-purple-50 dark:bg-purple-900/20 p-4 rounded-lg">
            <div className="text-2xl font-bold text-purple-900 dark:text-purple-200">{stats.withTransfers}</div>
            <div className="text-sm text-purple-600 dark:text-purple-400">With Transfers</div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Records of Processing Activities (ROPA)
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              GDPR Article 30 - Maintain records of all data processing activities
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={exportToJson} variant="outline" className="gap-1">
              <DocumentArrowDownIcon className="size-4" />
              Export ROPA
            </Button>
            <Button onClick={() => openEditModal()} className="gap-1">
              <PlusIcon className="size-4" />
              Add Activity
            </Button>
          </div>
        </div>
      </Card>

      {/* Activity List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner size="medium" />
        </div>
      ) : activities.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <ClipboardDocumentListIcon className="size-12 mx-auto mb-4 opacity-50" />
          <p>No processing activities documented.</p>
          <p className="text-sm mt-2">Add your first processing activity to maintain GDPR compliance.</p>
          <Button onClick={() => openEditModal()} className="mt-4 gap-1">
            <PlusIcon className="size-4" />
            Add Activity
          </Button>
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>Activity</Th>
                  <Th>Legal Basis</Th>
                  <Th>Status</Th>
                  <Th>DPIA</Th>
                  <Th>Updated</Th>
                  <Th />
                </Tr>
              </THead>
              <TBody>
                {activities.map((activity) => (
                  <Tr key={activity.id}>
                    <Td>
                      <div className="text-sm font-medium">
                        {activity.activity_name}
                      </div>
                      <div className="text-xs truncate max-w-[300px]">
                        {activity.purpose}
                      </div>
                    </Td>
                    <Td>
                      <span className="text-sm">
                        {getLegalBasisLabel(activity.legal_basis)}
                      </span>
                    </Td>
                    <Td>
                      {getStatusBadge(activity.status)}
                    </Td>
                    <Td>
                      {activity.dpia_required ? (
                        <span className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded-full ${
                          activity.dpia_conducted
                            ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200'
                            : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200'
                        }`}>
                          {activity.dpia_conducted ? 'Completed' : 'Required'}
                        </span>
                      ) : (
                        <span className="text-xs">N/A</span>
                      )}
                    </Td>
                    <Td>
                      {formatDate(activity.updated_at)}
                    </Td>
                    <Td>
                      <RowActions
                        actions={[
                          {
                            label: 'View',
                            icon: <EyeIcon className="size-4" />,
                            onClick: () => { setSelectedActivity(activity); setShowModal(true); },
                          },
                          {
                            label: 'Edit',
                            icon: <PencilSquareIcon className="size-4" />,
                            onClick: () => openEditModal(activity),
                          },
                          {
                            label: 'Delete',
                            icon: <TrashIcon className="size-4" />,
                            onClick: () => handleDelete(activity.id),
                            color: 'red',
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

      {/* View Detail Modal */}
      {showModal && selectedActivity && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200 dark:border-gray-700">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    {selectedActivity.activity_name}
                  </h3>
                  <div className="mt-2">{getStatusBadge(selectedActivity.status)}</div>
                </div>
                <Button
                  isIcon
                  variant="ghost"
                  onClick={() => { setShowModal(false); setSelectedActivity(null); }}
                >
                  <XCircleIcon className="size-6" />
                </Button>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Purpose
                </label>
                <div className="mt-1 text-sm text-gray-900 dark:text-white">
                  {selectedActivity.purpose}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Legal Basis
                </label>
                <div className="mt-1 text-sm text-gray-900 dark:text-white">
                  {getLegalBasisLabel(selectedActivity.legal_basis)}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Data Categories
                  </label>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {selectedActivity.data_categories?.map((cat, i) => (
                      <span key={i} className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
                        {cat}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Data Subjects
                  </label>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {selectedActivity.data_subjects?.map((subj, i) => (
                      <span key={i} className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200">
                        {subj}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {selectedActivity.retention_period && (
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Retention Period
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white">
                    {selectedActivity.retention_period}
                  </div>
                </div>
              )}

              {selectedActivity.security_measures && (
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Security Measures
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700 p-3 rounded">
                    {selectedActivity.security_measures}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    DPIA Required
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white">
                    {selectedActivity.dpia_required ? 'Yes' : 'No'}
                    {selectedActivity.dpia_required && (
                      <span className={`ml-2 text-xs ${selectedActivity.dpia_conducted ? 'text-green-600' : 'text-red-600'}`}>
                        ({selectedActivity.dpia_conducted ? 'Completed' : 'Pending'})
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Third Country Transfers
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white">
                    {selectedActivity.third_country_transfers ? 'Yes' : 'No'}
                  </div>
                </div>
              </div>
            </div>

            <div className="p-6 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <div className="flex justify-end gap-2">
                <Button
                  onClick={() => openEditModal(selectedActivity)}
                  variant="outline"
                  className="gap-1"
                >
                  <PencilSquareIcon className="size-4" />
                  Edit
                </Button>
                <Button
                  onClick={() => { setShowModal(false); setSelectedActivity(null); }}
                  variant="outline"
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit/Create Modal */}
      {showEditModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                {selectedActivity ? 'Edit Processing Activity' : 'Add Processing Activity'}
              </h3>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Activity Name *
                </label>
                <Input
                  value={editForm.activity_name}
                  onChange={(e) => setEditForm({ ...editForm, activity_name: e.target.value })}
                  placeholder="e.g., Newsletter Marketing"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Purpose *
                </label>
                <textarea
                  value={editForm.purpose}
                  onChange={(e) => setEditForm({ ...editForm, purpose: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  rows={2}
                  placeholder="Describe the purpose of this processing activity..."
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Legal Basis
                  </label>
                  <select
                    value={editForm.legal_basis}
                    onChange={(e) => setEditForm({ ...editForm, legal_basis: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  >
                    {LEGAL_BASIS_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Status
                  </label>
                  <select
                    value={editForm.status}
                    onChange={(e) => setEditForm({ ...editForm, status: e.target.value as any })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  >
                    <option value="draft">Draft</option>
                    <option value="active">Active</option>
                    <option value="archived">Archived</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Data Categories
                </label>
                <div className="flex flex-wrap gap-2">
                  {DATA_CATEGORIES_OPTIONS.map(cat => (
                    <Button
                      key={cat}
                      type="button"
                      variant={editForm.data_categories?.includes(cat) ? 'soft' : 'outline'}
                      color={editForm.data_categories?.includes(cat) ? 'blue' : 'gray'}
                      size="sm"
                      onClick={() => setEditForm({
                        ...editForm,
                        data_categories: toggleArrayItem(editForm.data_categories || [], cat)
                      })}
                    >
                      {cat}
                    </Button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Data Subjects
                </label>
                <div className="flex flex-wrap gap-2">
                  {DATA_SUBJECTS_OPTIONS.map(subj => (
                    <Button
                      key={subj}
                      type="button"
                      variant={editForm.data_subjects?.includes(subj) ? 'soft' : 'outline'}
                      color={editForm.data_subjects?.includes(subj) ? 'green' : 'gray'}
                      size="sm"
                      onClick={() => setEditForm({
                        ...editForm,
                        data_subjects: toggleArrayItem(editForm.data_subjects || [], subj)
                      })}
                    >
                      {subj}
                    </Button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Retention Period
                </label>
                <Input
                  value={editForm.retention_period}
                  onChange={(e) => setEditForm({ ...editForm, retention_period: e.target.value })}
                  placeholder="e.g., 3 years after last activity"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Security Measures
                </label>
                <textarea
                  value={editForm.security_measures}
                  onChange={(e) => setEditForm({ ...editForm, security_measures: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  rows={2}
                  placeholder="Describe the security measures in place..."
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="dpia_required"
                    checked={editForm.dpia_required}
                    onChange={(e) => setEditForm({ ...editForm, dpia_required: e.target.checked })}
                    className="rounded border-gray-300 dark:border-gray-600"
                  />
                  <label htmlFor="dpia_required" className="text-sm text-gray-700 dark:text-gray-300">
                    DPIA Required
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="third_country_transfers"
                    checked={editForm.third_country_transfers}
                    onChange={(e) => setEditForm({ ...editForm, third_country_transfers: e.target.checked })}
                    className="rounded border-gray-300 dark:border-gray-600"
                  />
                  <label htmlFor="third_country_transfers" className="text-sm text-gray-700 dark:text-gray-300">
                    Third Country Transfers
                  </label>
                </div>
              </div>
            </div>

            <div className="p-6 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <div className="flex justify-end gap-2">
                <Button
                  onClick={() => { setShowEditModal(false); setSelectedActivity(null); resetForm(); }}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={processing || !editForm.activity_name || !editForm.purpose}
                >
                  {selectedActivity ? 'Update' : 'Create'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
