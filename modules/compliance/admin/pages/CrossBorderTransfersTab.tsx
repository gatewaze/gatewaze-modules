import { useState, useEffect } from 'react';
import {
  GlobeAltIcon,
  PlusIcon,
  PencilSquareIcon,
  TrashIcon,
  EyeIcon,
  XCircleIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { supabase } from '@/lib/supabase';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Card, Input, Button, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';

interface CrossBorderTransfer {
  id: string;
  destination_country: string;
  destination_country_code?: string;
  recipient_name: string;
  recipient_type: 'processor' | 'controller' | 'joint_controller';
  data_categories: string[];
  transfer_mechanism: string;
  safeguard_reference?: string;
  adequacy_decision?: boolean;
  scc_version?: string;
  bcr_approved?: boolean;
  derogation_basis?: string;
  risk_assessment_date?: string;
  risk_level?: 'low' | 'medium' | 'high';
  supplementary_measures?: string;
  status: 'active' | 'suspended' | 'terminated';
  created_at: string;
  updated_at: string;
}

const TRANSFER_MECHANISMS = [
  { value: 'adequacy_decision', label: 'Adequacy Decision (Art. 45)' },
  { value: 'scc', label: 'Standard Contractual Clauses (Art. 46.2c)' },
  { value: 'bcr', label: 'Binding Corporate Rules (Art. 47)' },
  { value: 'certification', label: 'Certification (Art. 42)' },
  { value: 'code_of_conduct', label: 'Approved Code of Conduct (Art. 40)' },
  { value: 'derogation_consent', label: 'Derogation - Explicit Consent (Art. 49.1a)' },
  { value: 'derogation_contract', label: 'Derogation - Contract Performance (Art. 49.1b)' },
  { value: 'derogation_public_interest', label: 'Derogation - Public Interest (Art. 49.1d)' },
  { value: 'derogation_legal_claims', label: 'Derogation - Legal Claims (Art. 49.1e)' },
];

const ADEQUACY_COUNTRIES = [
  'Andorra', 'Argentina', 'Canada (commercial)', 'Faroe Islands', 'Guernsey',
  'Israel', 'Isle of Man', 'Japan', 'Jersey', 'New Zealand', 'Republic of Korea',
  'Switzerland', 'United Kingdom', 'Uruguay', 'United States (DPF participants)',
];

const DATA_CATEGORIES = [
  'Personal identifiers',
  'Contact information',
  'Financial data',
  'Employment data',
  'Behavioral data',
  'Location data',
  'Technical data (IP, device)',
  'Communication content',
  'Special category data',
];

export function CrossBorderTransfersTab() {
  const [transfers, setTransfers] = useState<CrossBorderTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTransfer, setSelectedTransfer] = useState<CrossBorderTransfer | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [processing, setProcessing] = useState(false);

  const [editForm, setEditForm] = useState<Partial<CrossBorderTransfer>>({
    destination_country: '',
    recipient_name: '',
    recipient_type: 'processor',
    data_categories: [],
    transfer_mechanism: 'scc',
    status: 'active',
  });

  const [stats, setStats] = useState({
    total: 0,
    active: 0,
    byMechanism: {} as Record<string, number>,
    highRisk: 0,
  });

  useEffect(() => {
    fetchTransfers();
  }, []);

  const fetchTransfers = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('compliance_cross_border_transfers')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      setTransfers(data || []);

      // Calculate stats
      const allData = data || [];
      const byMechanism: Record<string, number> = {};
      allData.forEach(t => {
        byMechanism[t.transfer_mechanism] = (byMechanism[t.transfer_mechanism] || 0) + 1;
      });

      setStats({
        total: allData.length,
        active: allData.filter(t => t.status === 'active').length,
        byMechanism,
        highRisk: allData.filter(t => t.risk_level === 'high').length,
      });
    } catch (error) {
      console.error('Error fetching transfers:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!editForm.destination_country || !editForm.recipient_name) return;

    setProcessing(true);
    try {
      // Check if destination has adequacy decision
      const hasAdequacy = ADEQUACY_COUNTRIES.some(
        c => editForm.destination_country?.toLowerCase().includes(c.toLowerCase())
      );

      const dataToSave = {
        ...editForm,
        adequacy_decision: hasAdequacy,
      };

      if (selectedTransfer) {
        const { error } = await supabase
          .from('compliance_cross_border_transfers')
          .update(dataToSave)
          .eq('id', selectedTransfer.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('compliance_cross_border_transfers')
          .insert(dataToSave);

        if (error) throw error;
      }

      setShowEditModal(false);
      setSelectedTransfer(null);
      resetForm();
      await fetchTransfers();
    } catch (error) {
      console.error('Error saving transfer:', error);
    } finally {
      setProcessing(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this transfer record?')) return;

    setProcessing(true);
    try {
      const { error } = await supabase
        .from('compliance_cross_border_transfers')
        .delete()
        .eq('id', id);

      if (error) throw error;

      await fetchTransfers();
      setShowModal(false);
      setSelectedTransfer(null);
    } catch (error) {
      console.error('Error deleting transfer:', error);
    } finally {
      setProcessing(false);
    }
  };

  const resetForm = () => {
    setEditForm({
      destination_country: '',
      recipient_name: '',
      recipient_type: 'processor',
      data_categories: [],
      transfer_mechanism: 'scc',
      status: 'active',
    });
  };

  const openEditModal = (transfer?: CrossBorderTransfer) => {
    if (transfer) {
      setSelectedTransfer(transfer);
      setEditForm(transfer);
    } else {
      setSelectedTransfer(null);
      resetForm();
    }
    setShowEditModal(true);
  };

  const getMechanismLabel = (mechanism: string) => {
    return TRANSFER_MECHANISMS.find(m => m.value === mechanism)?.label || mechanism;
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      active: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200',
      suspended: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200',
      terminated: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200',
    };

    return (
      <span className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded-full ${colors[status] || colors.active}`}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    );
  };

  const getRiskBadge = (level?: string) => {
    if (!level) return null;

    const colors: Record<string, string> = {
      low: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200',
      medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200',
      high: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200',
    };

    return (
      <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full ${colors[level] || colors.medium}`}>
        {level === 'high' && <ExclamationTriangleIcon className="size-3" />}
        {level.charAt(0).toUpperCase() + level.slice(1)} Risk
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
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.total}</div>
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Transfers</div>
        </div>
        <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-green-900 dark:text-green-200">{stats.active}</div>
          <div className="text-sm text-green-600 dark:text-green-400">Active</div>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-blue-900 dark:text-blue-200">
            {Object.keys(stats.byMechanism).length}
          </div>
          <div className="text-sm text-blue-600 dark:text-blue-400">Mechanisms Used</div>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-red-900 dark:text-red-200">{stats.highRisk}</div>
          <div className="text-sm text-red-600 dark:text-red-400">High Risk</div>
        </div>
      </div>

      {/* Actions */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
              International Data Transfers
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              GDPR Chapter V - Track transfers of personal data to third countries
            </p>
          </div>
          <Button onClick={() => openEditModal()} className="gap-1">
            <PlusIcon className="size-4" />
            Add Transfer
          </Button>
        </div>
      </Card>

      {/* Transfer List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner size="medium" />
        </div>
      ) : transfers.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <GlobeAltIcon className="size-12 mx-auto mb-4 opacity-50" />
          <p>No cross-border transfers documented.</p>
          <p className="text-sm mt-2">Add records of international data transfers to maintain compliance.</p>
          <Button onClick={() => openEditModal()} className="mt-4 gap-1">
            <PlusIcon className="size-4" />
            Add Transfer
          </Button>
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>Destination</Th>
                  <Th>Recipient</Th>
                  <Th>Mechanism</Th>
                  <Th>Status</Th>
                  <Th>Risk</Th>
                  <Th />
                </Tr>
              </THead>
              <TBody>
                {transfers.map((transfer) => (
                  <Tr key={transfer.id}>
                    <Td>
                      <div className="flex items-center gap-2">
                        <GlobeAltIcon className="size-4" />
                        <div>
                          <div className="text-sm font-medium">
                            {transfer.destination_country}
                          </div>
                          {transfer.adequacy_decision && (
                            <span className="inline-flex items-center gap-1 text-xs text-[var(--green-11)]">
                              <CheckCircleIcon className="size-3" />
                              Adequacy
                            </span>
                          )}
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <div className="text-sm">
                        {transfer.recipient_name}
                      </div>
                      <div className="text-xs capitalize">
                        {transfer.recipient_type.replace('_', ' ')}
                      </div>
                    </Td>
                    <Td>
                      <span className="text-sm">
                        {getMechanismLabel(transfer.transfer_mechanism)}
                      </span>
                    </Td>
                    <Td>
                      {getStatusBadge(transfer.status)}
                    </Td>
                    <Td>
                      {getRiskBadge(transfer.risk_level)}
                    </Td>
                    <Td>
                      <RowActions
                        actions={[
                          {
                            label: 'View',
                            icon: <EyeIcon className="size-4" />,
                            onClick: () => { setSelectedTransfer(transfer); setShowModal(true); },
                          },
                          {
                            label: 'Edit',
                            icon: <PencilSquareIcon className="size-4" />,
                            onClick: () => openEditModal(transfer),
                          },
                          {
                            label: 'Delete',
                            icon: <TrashIcon className="size-4" />,
                            onClick: () => handleDelete(transfer.id),
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
      {showModal && selectedTransfer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200 dark:border-gray-700">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    Transfer to {selectedTransfer.destination_country}
                  </h3>
                  <div className="mt-2 flex items-center gap-2">
                    {getStatusBadge(selectedTransfer.status)}
                    {getRiskBadge(selectedTransfer.risk_level)}
                  </div>
                </div>
                <Button
                  isIcon
                  variant="ghost"
                  onClick={() => { setShowModal(false); setSelectedTransfer(null); }}
                >
                  <XCircleIcon className="size-6" />
                </Button>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Recipient
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white">
                    {selectedTransfer.recipient_name}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Recipient Type
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white capitalize">
                    {selectedTransfer.recipient_type.replace('_', ' ')}
                  </div>
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Transfer Mechanism
                </label>
                <div className="mt-1 text-sm text-gray-900 dark:text-white">
                  {getMechanismLabel(selectedTransfer.transfer_mechanism)}
                </div>
              </div>

              {selectedTransfer.adequacy_decision && (
                <div className="bg-green-50 dark:bg-green-900/20 p-3 rounded flex items-center gap-2">
                  <CheckCircleIcon className="size-5 text-green-600 dark:text-green-400" />
                  <span className="text-sm text-green-800 dark:text-green-200">
                    Destination has EU adequacy decision
                  </span>
                </div>
              )}

              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Data Categories
                </label>
                <div className="mt-1 flex flex-wrap gap-1">
                  {selectedTransfer.data_categories?.map((cat, i) => (
                    <span key={i} className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
                      {cat}
                    </span>
                  ))}
                </div>
              </div>

              {selectedTransfer.supplementary_measures && (
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Supplementary Measures
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700 p-3 rounded">
                    {selectedTransfer.supplementary_measures}
                  </div>
                </div>
              )}

              {selectedTransfer.safeguard_reference && (
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Safeguard Reference
                  </label>
                  <div className="mt-1 text-sm text-gray-900 dark:text-white">
                    {selectedTransfer.safeguard_reference}
                  </div>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <div className="flex justify-end gap-2">
                <Button
                  onClick={() => openEditModal(selectedTransfer)}
                  variant="outline"
                  className="gap-1"
                >
                  <PencilSquareIcon className="size-4" />
                  Edit
                </Button>
                <Button
                  onClick={() => { setShowModal(false); setSelectedTransfer(null); }}
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
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                {selectedTransfer ? 'Edit Transfer' : 'Add Cross-Border Transfer'}
              </h3>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Destination Country *
                  </label>
                  <Input
                    value={editForm.destination_country}
                    onChange={(e) => setEditForm({ ...editForm, destination_country: e.target.value })}
                    placeholder="e.g., United States"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Recipient Name *
                  </label>
                  <Input
                    value={editForm.recipient_name}
                    onChange={(e) => setEditForm({ ...editForm, recipient_name: e.target.value })}
                    placeholder="e.g., AWS Inc."
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Recipient Type
                  </label>
                  <select
                    value={editForm.recipient_type}
                    onChange={(e) => setEditForm({ ...editForm, recipient_type: e.target.value as any })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  >
                    <option value="processor">Processor</option>
                    <option value="controller">Controller</option>
                    <option value="joint_controller">Joint Controller</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Transfer Mechanism
                  </label>
                  <select
                    value={editForm.transfer_mechanism}
                    onChange={(e) => setEditForm({ ...editForm, transfer_mechanism: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  >
                    {TRANSFER_MECHANISMS.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Data Categories
                </label>
                <div className="flex flex-wrap gap-2">
                  {DATA_CATEGORIES.map(cat => (
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

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Risk Level
                  </label>
                  <select
                    value={editForm.risk_level || ''}
                    onChange={(e) => setEditForm({ ...editForm, risk_level: e.target.value as any || undefined })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  >
                    <option value="">Not assessed</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
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
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                    <option value="terminated">Terminated</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Safeguard Reference (SCC/BCR reference)
                </label>
                <Input
                  value={editForm.safeguard_reference || ''}
                  onChange={(e) => setEditForm({ ...editForm, safeguard_reference: e.target.value })}
                  placeholder="e.g., SCC-2021-AWS-001"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Supplementary Measures
                </label>
                <textarea
                  value={editForm.supplementary_measures || ''}
                  onChange={(e) => setEditForm({ ...editForm, supplementary_measures: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  rows={2}
                  placeholder="e.g., Encryption at rest and in transit, access controls..."
                />
              </div>
            </div>

            <div className="p-6 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <div className="flex justify-end gap-2">
                <Button
                  onClick={() => { setShowEditModal(false); setSelectedTransfer(null); resetForm(); }}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={processing || !editForm.destination_country || !editForm.recipient_name}
                >
                  {selectedTransfer ? 'Update' : 'Create'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
