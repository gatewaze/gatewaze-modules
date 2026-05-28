import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { PlusIcon, DocumentTextIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge, Modal, Input } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { CohortService, Cohort, InstructorProfile } from '../lib';
import { supabase } from '@/lib/supabase';

export default function CohortManagement() {
  const navigate = useNavigate();
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [instructors, setInstructors] = useState<InstructorProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingInstructors, setLoadingInstructors] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingCohort, setEditingCohort] = useState<Cohort | null>(null);
  const [formData, setFormData] = useState<Partial<Cohort>>({
    title: '',
    description: '',
    instructor_id: '',
    start_date: '',
    end_date: '',
    price_cents: 0,
    original_price_cents: undefined,
    max_participants: undefined,
    is_active: true,
  });

  useEffect(() => {
    loadCohorts();
    loadInstructors();
  }, []);

  const loadCohorts = async () => {
    setLoading(true);
    try {
      const { data, error } = await CohortService.getCohorts();
      if (error) throw error;
      setCohorts(data);
    } catch (error: any) {
      console.error('Error loading cohorts:', error);
      toast.error('Failed to load cohorts');
    } finally {
      setLoading(false);
    }
  };

  const loadInstructors = async () => {
    setLoadingInstructors(true);
    try {
      const { data, error } = await CohortService.getInstructors();
      if (error) throw error;
      setInstructors(data.filter(i => i.is_active));
    } catch (error: any) {
      console.error('Error loading instructors:', error);
      toast.error('Failed to load instructors');
    } finally {
      setLoadingInstructors(false);
    }
  };

  const handleSave = async () => {
    try {
      // Validate required fields
      if (!formData.instructor_id || formData.instructor_id.trim() === '') {
        toast.error('Please select an instructor');
        return;
      }

      if (!formData.title || formData.title.trim() === '') {
        toast.error('Please enter a title');
        return;
      }

      // Clean the data - ensure empty strings are not sent for UUID fields or date fields
      const cleanedData = {
        ...formData,
        instructor_id: formData.instructor_id?.trim() || undefined,
        // Convert empty strings to undefined for optional fields
        // start_date and end_date are required by DB, so provide defaults if empty
        start_date: formData.start_date || new Date().toISOString().split('T')[0],
        end_date: formData.end_date || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 90 days from now
        description: formData.description || undefined,
        long_description: formData.long_description || undefined,
        google_classroom_link: formData.google_classroom_link || undefined,
        image: formData.image || undefined,
        tags: formData.tags && formData.tags.length > 0 ? formData.tags : undefined,
        // Only include numeric fields if they have values
        max_participants: formData.max_participants || undefined,
        rating: formData.rating !== undefined && formData.rating !== null ? formData.rating : undefined,
        original_price_cents: formData.original_price_cents || undefined,
      };

      if (editingCohort) {
        const { error } = await CohortService.updateCohort(editingCohort.id, cleanedData);
        if (error) throw error;
        toast.success('Cohort updated successfully');
        setShowModal(false);
        setEditingCohort(null);
        resetForm();
        loadCohorts();
      } else {
        // Don't set the ID - let the database generate a UUID automatically
        const { data, error } = await CohortService.createCohort(cleanedData);
        if (error) throw error;
        toast.success('Cohort created successfully');
        setShowModal(false);
        resetForm();

        // Navigate to the cohort detail page
        if (data && data.id) {
          navigate(`/cohorts/${data.id}/settings`);
        } else {
          loadCohorts();
        }
      }
    } catch (error: any) {
      console.error('Error saving cohort:', error);
      toast.error(error.message || 'Failed to save cohort');
    }
  };

  const resetForm = () => {
    setFormData({
      title: '',
      description: '',
      instructor_id: '',
      start_date: '',
      end_date: '',
      price_cents: 0,
      original_price_cents: undefined,
      max_participants: undefined,
      is_active: true,
    });
  };

  const formatCurrency = (cents: number) => new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);

  const formatDate = (dateString: string) => new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const getInstructorDisplay = (instructor: InstructorProfile) => {
    return instructor.instructor_name || instructor.email;
  };

  const activeCohorts = cohorts.filter(c => c.is_active);
  const archivedCohorts = cohorts.filter(c => !c.is_active);

  const CohortCard = ({ cohort }: { cohort: Cohort }) => (
    <Card key={cohort.id} className="overflow-hidden flex flex-col h-full">
      {/* Cohort Image */}
      <div className="relative h-40 bg-gradient-to-br from-primary-600 to-primary-800 shrink-0">
        {cohort.image ? (
          <img
            src={cohort.image}
            alt={cohort.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <DocumentTextIcon className="w-16 h-16 text-white/30" />
          </div>
        )}
        <div className="absolute top-3 right-3">
          <Badge color={cohort.is_active ? 'success' : 'neutral'}>
            {cohort.is_active ? 'Active' : 'Archived'}
          </Badge>
        </div>
      </div>

      <div className="p-6 flex flex-col flex-1">
        {/* Top content - grows to fill space */}
        <div className="flex-1">
          <div className="mb-4">
            <h3 className="font-semibold text-lg">{cohort.title}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">{cohort.instructor_name}</p>
          </div>

          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4 line-clamp-2">
            {cohort.description || 'No description'}
          </p>
        </div>

        {/* Bottom content - always aligned */}
        <div className="mt-auto">
          <div className="space-y-2 text-sm mb-4">
            <div className="flex justify-between">
              <span className="text-gray-600 dark:text-gray-400">Price:</span>
              <span className="font-medium">{formatCurrency(cohort.price_cents)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600 dark:text-gray-400">Start:</span>
              <span>{formatDate(cohort.start_date)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600 dark:text-gray-400">End:</span>
              <span>{formatDate(cohort.end_date)}</span>
            </div>
          </div>

          <Button
            color="primary"
            size="sm"
            onClick={() => navigate(`/cohorts/${cohort.id}/settings`)}
            className="w-full flex items-center justify-center gap-1"
          >
            View Details
          </Button>
        </div>
      </div>
    </Card>
  );

  return (
    <Page title="Manage Cohorts">
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-bold">Cohorts</h2>
            <p className="text-gray-600 dark:text-gray-400">
              {activeCohorts.length} Active, {archivedCohorts.length} Archived
            </p>
          </div>
          <Button
            color="primary"
            onClick={() => {
              resetForm();
              setEditingCohort(null);
              setShowModal(true);
            }}
            className="flex items-center gap-2"
          >
            <PlusIcon className="h-5 w-5" />
            Create Cohort
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center items-center py-12">
            <LoadingSpinner size="large" />
          </div>
        ) : (
          <>
            {/* Active Cohorts Section */}
            {activeCohorts.length > 0 && (
              <div>
                <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
                  Active Cohorts
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {activeCohorts.map((cohort) => (
                    <CohortCard key={cohort.id} cohort={cohort} />
                  ))}
                </div>
              </div>
            )}

            {/* Archived Cohorts Section */}
            {archivedCohorts.length > 0 && (
              <div>
                <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
                  Archived Cohorts
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {archivedCohorts.map((cohort) => (
                    <CohortCard key={cohort.id} cohort={cohort} />
                  ))}
                </div>
              </div>
            )}

            {/* Empty State */}
            {cohorts.length === 0 && (
              <Card className="p-12 text-center">
                <p className="text-gray-600 dark:text-gray-400 mb-4">
                  No cohorts found. Create your first cohort to get started.
                </p>
                <Button
                  color="primary"
                  onClick={() => {
                    resetForm();
                    setEditingCohort(null);
                    setShowModal(true);
                  }}
                >
                  <PlusIcon className="h-5 w-5 mr-2" />
                  Create First Cohort
                </Button>
              </Card>
            )}
          </>
        )}

        {/* Create/Edit Modal */}
        <Modal
          isOpen={showModal}
          onClose={() => {
            setShowModal(false);
            setEditingCohort(null);
            resetForm();
          }}
          title={editingCohort ? 'Edit Cohort' : 'Create New Cohort'}
          size="lg"
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Title</label>
              <Input
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="AI Cost Optimization Mastery"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Instructor {loadingInstructors && <span className="text-xs text-gray-500">(Loading...)</span>}
              </label>
              <select
                value={formData.instructor_id || ''}
                onChange={(e) => setFormData({ ...formData, instructor_id: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                disabled={loadingInstructors}
              >
                <option value="">Select an instructor...</option>
                {instructors.map((instructor) => (
                  <option key={instructor.id} value={instructor.id}>
                    {getInstructorDisplay(instructor)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                {editingCohort
                  ? 'Select an active instructor profile to teach this cohort'
                  : 'After creating, you can configure all other settings on the cohort detail page'
                }
              </p>
            </div>

            {/* Only show additional fields when editing */}
            {editingCohort && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-1">Short Description</label>
                  <textarea
                    value={formData.description || ''}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                    rows={3}
                    placeholder="Brief overview of the cohort..."
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Long Description</label>
                  <textarea
                    value={formData.long_description || ''}
                    onChange={(e) => setFormData({ ...formData, long_description: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                    rows={6}
                    placeholder="Detailed description of what students will learn, course objectives, etc..."
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Start Date</label>
                    <Input
                      type="date"
                      value={formData.start_date}
                      onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">End Date</label>
                    <Input
                      type="date"
                      value={formData.end_date}
                      onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Current Price (USD)</label>
                    <Input
                      type="number"
                      value={(formData.price_cents || 0) / 100}
                      onChange={(e) => setFormData({ ...formData, price_cents: parseFloat(e.target.value) * 100 })}
                      placeholder="299.00"
                      step="0.01"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Original Price (USD)</label>
                    <Input
                      type="number"
                      value={formData.original_price_cents ? formData.original_price_cents / 100 : ''}
                      onChange={(e) => setFormData({ ...formData, original_price_cents: e.target.value ? parseFloat(e.target.value) * 100 : undefined })}
                      placeholder="499.00"
                      step="0.01"
                    />
                    <p className="text-xs text-gray-500 mt-1">Optional - shown as strikethrough</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Max Participants</label>
                    <Input
                      type="number"
                      value={formData.max_participants || ''}
                      onChange={(e) => setFormData({ ...formData, max_participants: parseInt(e.target.value) || undefined })}
                      placeholder="Optional"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Rating (out of 5)</label>
                    <Input
                      type="number"
                      value={formData.rating !== undefined ? formData.rating : ''}
                      onChange={(e) => setFormData({ ...formData, rating: e.target.value ? parseFloat(e.target.value) : undefined })}
                      placeholder="4.9"
                      step="0.1"
                      min="0"
                      max="5"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Image URL</label>
                  <Input
                    value={formData.image || ''}
                    onChange={(e) => setFormData({ ...formData, image: e.target.value || undefined })}
                    placeholder="https://example.com/image.jpg"
                  />
                  <p className="text-xs text-gray-500 mt-1">Optional - URL to cohort cover image</p>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Tags</label>
                  <Input
                    value={formData.tags?.join(', ') || ''}
                    onChange={(e) => setFormData({ ...formData, tags: e.target.value ? e.target.value.split(',').map(t => t.trim()).filter(t => t) : undefined })}
                    placeholder="machine-learning, python, data-science"
                  />
                  <p className="text-xs text-gray-500 mt-1">Optional - comma-separated tags</p>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="is_active"
                    checked={formData.is_active}
                    onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                    className="rounded"
                  />
                  <label htmlFor="is_active" className="text-sm font-medium">
                    Active (visible to students)
                  </label>
                </div>
              </>
            )}

            <div className="flex gap-3 pt-4">
              <Button
                color="primary"
                onClick={handleSave}
                className="flex-1"
                disabled={!formData.title || !formData.instructor_id}
              >
                {editingCohort ? 'Update Cohort' : 'Create Cohort'}
              </Button>
              <Button
                variant="outlined"
                onClick={() => {
                  setShowModal(false);
                  setEditingCohort(null);
                  resetForm();
                }}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </Page>
  );
}
