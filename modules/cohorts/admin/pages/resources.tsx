import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { PlusIcon, PencilIcon, TrashIcon, ArrowLeftIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge, Modal, Input } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { CohortService, CohortResource, Cohort } from '@/lib/cohorts';

const RESOURCE_TYPES = [
  { value: 'video', label: 'Video' },
  { value: 'document', label: 'Document' },
  { value: 'link', label: 'Link' },
  { value: 'zoom', label: 'Zoom Meeting' },
  { value: 'slack', label: 'Slack Channel' },
] as const;

export default function CohortResources() {
  const { cohortId, instructorId } = useParams<{ cohortId: string; instructorId: string }>();
  const navigate = useNavigate();
  const [cohort, setCohort] = useState<Cohort | null>(null);
  const [resources, setResources] = useState<CohortResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingResource, setEditingResource] = useState<CohortResource | null>(null);
  const [formData, setFormData] = useState<Partial<CohortResource>>({
    cohort_id: cohortId,
    week_number: 1,
    title: '',
    description: '',
    resource_type: 'video',
    resource_url: '',
    is_member_only: true,
  });

  useEffect(() => {
    if (cohortId) {
      loadCohort();
      loadResources();
    }
  }, [cohortId]);

  const loadCohort = async () => {
    try {
      const { data: cohorts } = await CohortService.getCohorts();
      const foundCohort = cohorts.find(c => c.id === cohortId);
      if (foundCohort) {
        setCohort(foundCohort);
      }
    } catch (error: any) {
      console.error('Error loading cohort:', error);
      toast.error('Failed to load cohort');
    }
  };

  const loadResources = async () => {
    if (!cohortId) return;
    setLoading(true);
    try {
      const { data, error } = await CohortService.getCohortResources(cohortId);
      if (error) throw error;
      setResources(data);
    } catch (error: any) {
      console.error('Error loading resources:', error);
      toast.error('Failed to load resources');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      if (editingResource) {
        const { error } = await CohortService.updateResource(editingResource.id, formData);
        if (error) throw error;
        toast.success('Resource updated successfully');
      } else {
        const { error } = await CohortService.createResource({ ...formData, cohort_id: cohortId });
        if (error) throw error;
        toast.success('Resource created successfully');
      }
      setShowModal(false);
      setEditingResource(null);
      resetForm();
      loadResources();
    } catch (error: any) {
      console.error('Error saving resource:', error);
      toast.error(error.message || 'Failed to save resource');
    }
  };

  const handleEdit = (resource: CohortResource) => {
    setEditingResource(resource);
    setFormData(resource);
    setShowModal(true);
  };

  const handleDelete = async (resource: CohortResource) => {
    if (!confirm(`Are you sure you want to delete "${resource.title}"?`)) return;

    try {
      const { error } = await CohortService.deleteResource(resource.id);
      if (error) throw error;
      toast.success('Resource deleted successfully');
      loadResources();
    } catch (error: any) {
      console.error('Error deleting resource:', error);
      toast.error('Failed to delete resource');
    }
  };

  const resetForm = () => {
    setFormData({
      cohort_id: cohortId,
      week_number: 1,
      title: '',
      description: '',
      resource_type: 'video',
      resource_url: '',
      is_member_only: true,
    });
  };

  const getResourceTypeColor = (type: string) => {
    switch (type) {
      case 'video': return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200';
      case 'document': return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
      case 'link': return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      case 'zoom': return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
      case 'slack': return 'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200';
      default: return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200';
    }
  };

  // Group resources by week
  const resourcesByWeek = resources.reduce((acc, resource) => {
    const week = resource.week_number;
    if (!acc[week]) acc[week] = [];
    acc[week].push(resource);
    return acc;
  }, {} as Record<number, CohortResource[]>);

  const weeks = Object.keys(resourcesByWeek).sort((a, b) => Number(a) - Number(b));

  return (
    <Page title={cohort ? `${cohort.title} - Resources` : 'Cohort Resources'}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate(`/cohorts/instructors/${instructorId}`)}
              className="flex items-center gap-2"
            >
              <ArrowLeftIcon className="h-4 w-4" />
              Back to Instructor
            </Button>
            <div>
              <h2 className="text-2xl font-bold">{cohort?.title}</h2>
              <p className="text-gray-600 dark:text-gray-400">
                Manage weekly resources and materials
              </p>
            </div>
          </div>
          <Button
            variant="primary"
            onClick={() => {
              resetForm();
              setEditingResource(null);
              setShowModal(true);
            }}
            className="flex items-center gap-2"
          >
            <PlusIcon className="h-5 w-5" />
            Add Resource
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center items-center py-12">
            <LoadingSpinner size="large" />
          </div>
        ) : (
          <>
            {weeks.length > 0 ? (
              <div className="space-y-6">
                {weeks.map((week) => (
                  <Card key={week} className="p-6">
                    <h3 className="text-lg font-semibold mb-4">Week {week}</h3>
                    <div className="space-y-3">
                      {resourcesByWeek[Number(week)].map((resource) => (
                        <div
                          key={resource.id}
                          className="flex items-start justify-between p-4 bg-gray-50 dark:bg-gray-800 rounded-lg"
                        >
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2">
                              <h4 className="font-medium">{resource.title}</h4>
                              <Badge className={getResourceTypeColor(resource.resource_type)}>
                                {resource.resource_type}
                              </Badge>
                              {resource.is_member_only && (
                                <Badge variant="secondary">Members Only</Badge>
                              )}
                            </div>
                            {resource.description && (
                              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                                {resource.description}
                              </p>
                            )}
                            <a
                              href={resource.resource_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              {resource.resource_url}
                            </a>
                          </div>
                          <div className="flex gap-2 ml-4">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => handleEdit(resource)}
                              className="flex items-center gap-1"
                            >
                              <PencilIcon className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => handleDelete(resource)}
                              className="flex items-center gap-1 text-red-600 hover:text-red-700"
                            >
                              <TrashIcon className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <Card className="p-12 text-center">
                <p className="text-gray-600 dark:text-gray-400 mb-4">
                  No resources added yet. Create your first resource to get started.
                </p>
                <Button
                  variant="primary"
                  onClick={() => {
                    resetForm();
                    setEditingResource(null);
                    setShowModal(true);
                  }}
                >
                  <PlusIcon className="h-5 w-5 mr-2" />
                  Add First Resource
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
            setEditingResource(null);
            resetForm();
          }}
          title={editingResource ? 'Edit Resource' : 'Add New Resource'}
          size="lg"
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Week Number</label>
                <Input
                  type="number"
                  min="1"
                  max="12"
                  value={formData.week_number}
                  onChange={(e) => setFormData({ ...formData, week_number: parseInt(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Resource Type</label>
                <select
                  value={formData.resource_type}
                  onChange={(e) => setFormData({ ...formData, resource_type: e.target.value as any })}
                  className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                >
                  {RESOURCE_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Title</label>
              <Input
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="Week 1 Kickoff Session"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <textarea
                value={formData.description || ''}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                rows={3}
                placeholder="Brief description of this resource..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Resource URL</label>
              <Input
                type="url"
                value={formData.resource_url}
                onChange={(e) => setFormData({ ...formData, resource_url: e.target.value })}
                placeholder="https://..."
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="is_member_only"
                checked={formData.is_member_only}
                onChange={(e) => setFormData({ ...formData, is_member_only: e.target.checked })}
                className="rounded"
              />
              <label htmlFor="is_member_only" className="text-sm font-medium">
                Members Only (requires payment)
              </label>
            </div>

            <div className="flex gap-3 pt-4">
              <Button
                variant="primary"
                onClick={handleSave}
                className="flex-1"
                disabled={!formData.title || !formData.resource_url}
              >
                {editingResource ? 'Update Resource' : 'Create Resource'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setShowModal(false);
                  setEditingResource(null);
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
