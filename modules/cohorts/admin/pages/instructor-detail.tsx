import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  ArrowLeftIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  DocumentTextIcon,
  VideoCameraIcon,
  ArchiveBoxIcon
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge, Modal, Input } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { CohortService, InstructorProfile, Cohort } from '../lib';
import { PeopleAvatarService } from '@/utils/peopleAvatarService';

export default function InstructorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [instructor, setInstructor] = useState<InstructorProfile | null>(null);
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showCohortModal, setShowCohortModal] = useState(false);
  const [editingCohort, setEditingCohort] = useState<Cohort | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [cohortFormData, setCohortFormData] = useState<Partial<Cohort>>({
    title: '',
    description: '',
    start_date: '',
    end_date: '',
    price_cents: 0,
    max_participants: 20,
    is_active: true,
  });

  useEffect(() => {
    if (id) {
      loadInstructor();
      loadCohorts();
    }
  }, [id]);

  const loadInstructor = async () => {
    try {
      const { data, error } = await CohortService.getInstructor(id!);
      if (error) throw error;
      setInstructor(data);

      // Load avatar if available
      if (data?.avatar_url) {
        setAvatarUrl(data.avatar_url);
      }
    } catch (error: any) {
      console.error('Error loading instructor:', error);
      toast.error('Failed to load instructor');
    } finally {
      setLoading(false);
    }
  };

  const loadCohorts = async () => {
    try {
      if (id) {
        const { data, error } = await CohortService.getInstructorCohorts(id);
        if (error) throw error;
        setCohorts(data);
      }
    } catch (error: any) {
      console.error('Error loading cohorts:', error);
      toast.error('Failed to load cohorts');
    }
  };

  const handleDeleteInstructor = async () => {
    if (!id) return;

    try {
      const { error } = await CohortService.deleteInstructor(id);
      if (error) throw error;

      toast.success('Instructor removed successfully. Customer and auth user remain intact.');
      navigate('/cohorts/instructors');
    } catch (error: any) {
      console.error('Error deleting instructor:', error);
      toast.error(error.message || 'Failed to delete instructor');
    }
  };

  const handleCreateCohort = () => {
    setCohortFormData({
      title: '',
      description: '',
      start_date: '',
      end_date: '',
      price_cents: 0,
      max_participants: 20,
      is_active: true,
      instructor_id: id,
    });
    setEditingCohort(null);
    setShowCohortModal(true);
  };

  const handleEditCohort = (cohort: Cohort) => {
    setEditingCohort(cohort);
    setCohortFormData({
      title: cohort.title,
      description: cohort.description,
      start_date: cohort.start_date,
      end_date: cohort.end_date,
      price_cents: cohort.price_cents,
      max_participants: cohort.max_participants,
      is_active: cohort.is_active,
      instructor_id: cohort.instructor_id,
    });
    setShowCohortModal(true);
  };

  const handleSaveCohort = async () => {
    if (!id) return;

    try {
      const cohortData = {
        ...cohortFormData,
        instructor_id: id,
      };

      if (editingCohort) {
        const { error } = await CohortService.updateCohort(editingCohort.id, cohortData);
        if (error) throw error;
        toast.success('Cohort updated successfully');
      } else {
        const { error } = await CohortService.createCohort(cohortData);
        if (error) throw error;
        toast.success('Cohort created successfully');
      }

      setShowCohortModal(false);
      setEditingCohort(null);
      loadCohorts();
    } catch (error: any) {
      console.error('Error saving cohort:', error);
      toast.error(error.message || 'Failed to save cohort');
    }
  };

  const handleArchiveCohort = async (cohort: Cohort) => {
    const action = cohort.is_active ? 'archive' : 'activate';
    if (!confirm(`Are you sure you want to ${action} "${cohort.title}"?`)) return;

    try {
      const { error } = await CohortService.updateCohort(cohort.id, {
        is_active: !cohort.is_active,
      });
      if (error) throw error;
      toast.success(`Cohort ${action}d successfully`);
      loadCohorts();
    } catch (error: any) {
      console.error(`Error ${action}ing cohort:`, error);
      toast.error(`Failed to ${action} cohort`);
    }
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

  const activeCohorts = cohorts.filter(c => c.is_active);
  const archivedCohorts = cohorts.filter(c => !c.is_active);

  if (loading) {
    return (
      <Page title="Loading...">
        <div className="flex justify-center items-center py-12">
          <LoadingSpinner size="large" />
        </div>
      </Page>
    );
  }

  if (!instructor) {
    return (
      <Page title="Not Found">
        <Card className="p-12 text-center">
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            Instructor not found
          </p>
          <Button onClick={() => navigate('/cohorts/instructors')}>
            Back to Instructors
          </Button>
        </Card>
      </Page>
    );
  }

  return (
    <Page title={instructor.instructor_name}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="secondary"
              onClick={() => navigate('/cohorts/instructors')}
              className="flex items-center gap-2"
            >
              <ArrowLeftIcon className="h-4 w-4" />
              Back
            </Button>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Instructor Profile
            </h1>
          </div>
          <div className="flex gap-3">
            <Button
              variant="secondary"
              onClick={() => navigate(`/cohorts/instructors`)}
              className="flex items-center gap-2"
            >
              <PencilIcon className="h-5 w-5" />
              Edit Profile
            </Button>
            <Button
              variant="danger"
              onClick={() => setShowDeleteModal(true)}
              className="flex items-center gap-2"
            >
              <TrashIcon className="h-5 w-5" />
              Delete
            </Button>
          </div>
        </div>

        {/* Instructor Profile Card */}
        <Card className="p-8">
          <div className="flex items-start gap-8">
            {/* Avatar */}
            <div className="flex-shrink-0">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={instructor.instructor_name}
                  className="h-32 w-32 rounded-full object-cover border-4 border-gray-200 dark:border-gray-700"
                />
              ) : (
                <div className="h-32 w-32 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white text-5xl font-bold">
                  {instructor.instructor_name.charAt(0).toUpperCase()}
                </div>
              )}
            </div>

            {/* Info */}
            <div className="flex-1">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
                    {instructor.instructor_name}
                  </h2>
                  <p className="text-lg text-gray-600 dark:text-gray-400">
                    {instructor.email}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Badge variant={instructor.is_active ? 'success' : 'secondary'}>
                    {instructor.is_active ? 'Active' : 'Inactive'}
                  </Badge>
                  {instructor.is_featured && (
                    <Badge variant="primary">Featured</Badge>
                  )}
                </div>
              </div>

              {instructor.expertise && (
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
                    Expertise
                  </h3>
                  <p className="text-lg text-primary-600 dark:text-primary-400 font-medium">
                    {instructor.expertise}
                  </p>
                </div>
              )}

              {instructor.bio && (
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
                    Biography
                  </h3>
                  <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                    {instructor.bio}
                  </p>
                </div>
              )}

              {instructor.specialty && (
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
                    Specialty
                  </h3>
                  <p className="text-gray-700 dark:text-gray-300">
                    {instructor.specialty}
                  </p>
                </div>
              )}

              {/* Stats */}
              <div className="flex gap-8 mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
                {instructor.rating && (
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-2xl text-yellow-500">★</span>
                      <span className="text-2xl font-bold text-gray-900 dark:text-white">
                        {instructor.rating.toFixed(1)}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">Rating</p>
                  </div>
                )}
                {instructor.total_students !== undefined && (
                  <div>
                    <div className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
                      {instructor.total_students}
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">Students Taught</p>
                  </div>
                )}
                <div>
                  <div className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
                    {cohorts.length}
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Total Cohorts</p>
                </div>
                <div>
                  <div className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
                    {activeCohorts.length}
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Active Cohorts</p>
                </div>
              </div>
            </div>
          </div>
        </Card>

        {/* Cohorts Section */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">
              Cohorts
            </h2>
            <Button
              variant="primary"
              onClick={handleCreateCohort}
              className="flex items-center gap-2"
            >
              <PlusIcon className="h-5 w-5" />
              Create Cohort
            </Button>
          </div>

          {cohorts.length === 0 ? (
            <Card className="p-12 text-center">
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                This instructor hasn't taught any cohorts yet.
              </p>
              <Button
                variant="primary"
                onClick={handleCreateCohort}
              >
                <PlusIcon className="h-5 w-5 mr-2" />
                Create First Cohort
              </Button>
            </Card>
          ) : (
            <>
              {/* Active Cohorts */}
              {activeCohorts.length > 0 && (
                <div className="mb-8">
                  <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
                    Active Cohorts ({activeCohorts.length})
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {activeCohorts.map((cohort) => (
                      <Card key={cohort.id} className="p-6 hover:shadow-lg transition-shadow">
                        <div className="flex justify-between items-start mb-3">
                          <h4 className="font-semibold text-lg text-gray-900 dark:text-white">
                            {cohort.title}
                          </h4>
                          <Badge variant="success">Active</Badge>
                        </div>

                        {cohort.description && (
                          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4 line-clamp-2">
                            {cohort.description}
                          </p>
                        )}

                        <div className="space-y-2 text-sm mb-4">
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">Price:</span>
                            <span className="font-medium text-gray-900 dark:text-white">
                              {formatCurrency(cohort.price_cents)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">Start:</span>
                            <span className="text-gray-900 dark:text-white">
                              {formatDate(cohort.start_date)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">End:</span>
                            <span className="text-gray-900 dark:text-white">
                              {formatDate(cohort.end_date)}
                            </span>
                          </div>
                          {cohort.max_participants && (
                            <div className="flex justify-between">
                              <span className="text-gray-600 dark:text-gray-400">Max Students:</span>
                              <span className="text-gray-900 dark:text-white">
                                {cohort.max_participants}
                              </span>
                            </div>
                          )}
                        </div>

                        <div className="space-y-2">
                          <div className="flex gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => navigate(`/cohorts/instructors/${id}/cohorts/${cohort.id}/resources`)}
                              className="flex-1 flex items-center justify-center gap-1"
                            >
                              <DocumentTextIcon className="h-4 w-4" />
                              Resources
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => navigate(`/cohorts/instructors/${id}/cohorts/${cohort.id}/sessions`)}
                              className="flex-1 flex items-center justify-center gap-1"
                            >
                              <VideoCameraIcon className="h-4 w-4" />
                              Sessions
                            </Button>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => handleEditCohort(cohort)}
                              className="flex-1 flex items-center justify-center gap-1"
                            >
                              <PencilIcon className="h-4 w-4" />
                              Edit
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => handleArchiveCohort(cohort)}
                              className="flex-1 flex items-center justify-center gap-1"
                            >
                              <ArchiveBoxIcon className="h-4 w-4" />
                              Archive
                            </Button>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              )}

              {/* Archived Cohorts */}
              {archivedCohorts.length > 0 && (
                <div>
                  <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
                    Archived Cohorts ({archivedCohorts.length})
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {archivedCohorts.map((cohort) => (
                      <Card key={cohort.id} className="p-6 opacity-75 hover:opacity-100 transition-opacity">
                        <div className="flex justify-between items-start mb-3">
                          <h4 className="font-semibold text-lg text-gray-900 dark:text-white">
                            {cohort.title}
                          </h4>
                          <Badge variant="secondary">Archived</Badge>
                        </div>

                        {cohort.description && (
                          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4 line-clamp-2">
                            {cohort.description}
                          </p>
                        )}

                        <div className="space-y-2 text-sm mb-4">
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">Price:</span>
                            <span className="font-medium text-gray-900 dark:text-white">
                              {formatCurrency(cohort.price_cents)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">Start:</span>
                            <span className="text-gray-900 dark:text-white">
                              {formatDate(cohort.start_date)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">End:</span>
                            <span className="text-gray-900 dark:text-white">
                              {formatDate(cohort.end_date)}
                            </span>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div className="flex gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => navigate(`/cohorts/instructors/${id}/cohorts/${cohort.id}/resources`)}
                              className="flex-1 flex items-center justify-center gap-1"
                            >
                              <DocumentTextIcon className="h-4 w-4" />
                              Resources
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => navigate(`/cohorts/instructors/${id}/cohorts/${cohort.id}/sessions`)}
                              className="flex-1 flex items-center justify-center gap-1"
                            >
                              <VideoCameraIcon className="h-4 w-4" />
                              Sessions
                            </Button>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => handleEditCohort(cohort)}
                              className="flex-1 flex items-center justify-center gap-1"
                            >
                              <PencilIcon className="h-4 w-4" />
                              Edit
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => handleArchiveCohort(cohort)}
                              className="flex-1 flex items-center justify-center gap-1"
                            >
                              <ArchiveBoxIcon className="h-4 w-4" />
                              Activate
                            </Button>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        title="Delete Instructor"
        size="md"
      >
        <div className="space-y-4">
          <p className="text-gray-700 dark:text-gray-300">
            Are you sure you want to remove <strong>{instructor?.instructor_name}</strong> from the instructors list?
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            This will only remove them as an instructor. Their customer record and auth user will remain intact.
          </p>

          <div className="flex gap-3 pt-4">
            <Button
              variant="danger"
              onClick={handleDeleteInstructor}
              className="flex-1"
            >
              Delete Instructor
            </Button>
            <Button
              variant="secondary"
              onClick={() => setShowDeleteModal(false)}
              className="flex-1"
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Create/Edit Cohort Modal */}
      <Modal
        isOpen={showCohortModal}
        onClose={() => {
          setShowCohortModal(false);
          setEditingCohort(null);
        }}
        title={editingCohort ? 'Edit Cohort' : 'Create New Cohort'}
        size="lg"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Title</label>
            <Input
              value={cohortFormData.title}
              onChange={(e) => setCohortFormData({ ...cohortFormData, title: e.target.value })}
              placeholder="AI Engineering Cohort - Spring 2025"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea
              value={cohortFormData.description || ''}
              onChange={(e) => setCohortFormData({ ...cohortFormData, description: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
              rows={3}
              placeholder="A comprehensive 6-week program covering..."
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Start Date</label>
              <Input
                type="date"
                value={cohortFormData.start_date}
                onChange={(e) => setCohortFormData({ ...cohortFormData, start_date: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">End Date</label>
              <Input
                type="date"
                value={cohortFormData.end_date}
                onChange={(e) => setCohortFormData({ ...cohortFormData, end_date: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Price (USD)</label>
              <Input
                type="number"
                value={cohortFormData.price_cents ? cohortFormData.price_cents / 100 : 0}
                onChange={(e) => setCohortFormData({ ...cohortFormData, price_cents: parseFloat(e.target.value) * 100 })}
                placeholder="1500"
                step="0.01"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Max Participants</label>
              <Input
                type="number"
                value={cohortFormData.max_participants}
                onChange={(e) => setCohortFormData({ ...cohortFormData, max_participants: parseInt(e.target.value) })}
                placeholder="20"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="is_active"
              checked={cohortFormData.is_active}
              onChange={(e) => setCohortFormData({ ...cohortFormData, is_active: e.target.checked })}
              className="rounded"
            />
            <label htmlFor="is_active" className="text-sm font-medium">
              Active (visible to students)
            </label>
          </div>

          <div className="flex gap-3 pt-4">
            <Button
              variant="primary"
              onClick={handleSaveCohort}
              className="flex-1"
              disabled={!cohortFormData.title || !cohortFormData.start_date || !cohortFormData.end_date}
            >
              {editingCohort ? 'Update Cohort' : 'Create Cohort'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setShowCohortModal(false);
                setEditingCohort(null);
              }}
              className="flex-1"
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </Page>
  );
}
