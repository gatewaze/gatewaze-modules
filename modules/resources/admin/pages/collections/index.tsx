import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { yupResolver } from '@hookform/resolvers/yup';
import * as yup from 'yup';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import {
  PlusIcon,
  PencilIcon,
  TrashIcon,
  FolderOpenIcon,
} from '@heroicons/react/24/outline';
import { Modal, Button, Input, Card, Badge, ConfirmModal, Select, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import {
  SrCollection,
  CollectionsService,
} from '../../utils/structuredResourcesService';

const collectionSchema = yup.object({
  name: yup.string().required('Name is required').min(2, 'Name must be at least 2 characters'),
  description: yup.string().nullable().optional(),
  status: yup.string().oneOf(['draft', 'published', 'archived']).required(),
  access: yup.string().oneOf(['public', 'authenticated', 'inherit']).required(),
  cover_image_url: yup.string().url('Must be a valid URL').nullable().optional(),
  meta_title: yup.string().max(60, 'Meta title must be 60 characters or less').nullable().optional(),
  meta_description: yup.string().max(160, 'Meta description must be 160 characters or less').nullable().optional(),
});

type CollectionFormData = yup.InferType<typeof collectionSchema>;

const CollectionsPage: React.FC = () => {
  const navigate = useNavigate();
  const [collections, setCollections] = useState<SrCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<SrCollection | null>(null);
  const [deleting, setDeleting] = useState<SrCollection | null>(null);

  const form = useForm<CollectionFormData>({
    resolver: yupResolver(collectionSchema) as any,
    defaultValues: { status: 'draft', access: 'inherit' },
  });

  const loadCollections = async () => {
    setLoading(true);
    const result = await CollectionsService.getAll();
    if (result.success && result.data) {
      setCollections(result.data);
    } else {
      toast.error('Failed to load collections');
    }
    setLoading(false);
  };

  useEffect(() => { loadCollections(); }, []);

  const openCreate = () => {
    setEditing(null);
    form.reset({ status: 'draft', access: 'inherit' });
    setShowModal(true);
  };

  const openEdit = (collection: SrCollection) => {
    setEditing(collection);
    form.reset({
      name: collection.name,
      description: collection.description,
      status: collection.status,
      access: collection.access,
      cover_image_url: collection.cover_image_url,
      meta_title: collection.meta_title,
      meta_description: collection.meta_description,
    });
    setShowModal(true);
  };

  const onSubmit = async (data: CollectionFormData) => {
    setSubmitting(true);
    try {
      const cleaned = {
        ...data,
        cover_image_url: data.cover_image_url?.trim() || null,
        meta_title: data.meta_title?.trim() || null,
        meta_description: data.meta_description?.trim() || null,
        description: data.description?.trim() || null,
      };

      const result = editing
        ? await CollectionsService.update(editing.id, cleaned)
        : await CollectionsService.create(cleaned);

      if (result.success) {
        toast.success(editing ? 'Collection updated' : 'Collection created');
        setShowModal(false);
        loadCollections();
      } else {
        toast.error(result.error || 'Failed to save');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    const result = await CollectionsService.delete(deleting.id);
    if (result.success) {
      toast.success('Collection deleted');
      setDeleting(null);
      loadCollections();
    } else {
      toast.error(result.error || 'Failed to delete');
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'published': return 'green';
      case 'draft': return 'yellow';
      case 'archived': return 'gray';
      default: return 'gray';
    }
  };

  const accessLabel = (access: string) => {
    switch (access) {
      case 'public': return 'Public';
      case 'authenticated': return 'Login Required';
      case 'inherit': return 'Module Default';
      default: return access;
    }
  };

  return (
    <Page title="Resources">
      <WorkspaceLayout
        title="Resources"
        actions={
          <Button onClick={openCreate}>
            <PlusIcon className="h-4 w-4 mr-1" /> New Collection
          </Button>
        }
      >
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : collections.length === 0 ? (
        <Card className="text-center py-12">
          <FolderOpenIcon className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">No collections yet. Create your first one to get started.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {collections.map((collection) => (
            <Card
              key={collection.id}
              className="cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => navigate(`/resources/collections/${collection.id}`)}
            >
              {collection.cover_image_url && (
                <div className="aspect-[16/9] overflow-hidden rounded-t-lg -mx-4 -mt-4 mb-4">
                  <img
                    src={collection.cover_image_url}
                    alt={collection.name}
                    className="w-full h-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                </div>
              )}
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900 truncate">{collection.name}</h3>
                  {collection.description && (
                    <p className="text-sm text-gray-500 mt-1 line-clamp-2">{collection.description}</p>
                  )}
                  <div className="flex items-center gap-2 mt-3">
                    <Badge color={statusColor(collection.status)}>{collection.status}</Badge>
                    <span className="text-xs text-gray-400">{accessLabel(collection.access)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-2" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => openEdit(collection)}
                    className="p-1.5 text-gray-400 hover:text-gray-600 rounded"
                  >
                    <PencilIcon className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setDeleting(collection)}
                    className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      </WorkspaceLayout>

      {/* Create/Edit Modal */}
      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editing ? 'Edit Collection' : 'New Collection'}
      >
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <Input
            label="Name"
            {...form.register('name')}
            error={form.formState.errors.name?.message}
          />
          <Input
            label="Description"
            {...form.register('description')}
            error={form.formState.errors.description?.message}
          />
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Status"
              {...form.register('status')}
              data={[
                { value: 'draft', label: 'Draft' },
                { value: 'published', label: 'Published' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
            <Select
              label="Access"
              {...form.register('access')}
              data={[
                { value: 'inherit', label: 'Module Default' },
                { value: 'public', label: 'Public' },
                { value: 'authenticated', label: 'Login Required' },
              ]}
            />
          </div>
          <Input
            label="Cover Image URL"
            {...form.register('cover_image_url')}
            error={form.formState.errors.cover_image_url?.message}
          />
          <Input
            label="Meta Title"
            {...form.register('meta_title')}
            error={form.formState.errors.meta_title?.message}
          />
          <Input
            label="Meta Description"
            {...form.register('meta_description')}
            error={form.formState.errors.meta_description?.message}
          />
          <div className="flex justify-end gap-3 pt-4">
            <Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button type="submit" disabled={submitting}>
              {editing ? 'Update' : 'Create'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirm */}
      <ConfirmModal
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="Delete Collection"
        message={`Are you sure you want to delete "${deleting?.name}"? This will also delete all categories, items, and sections within it.`}
        confirmText="Delete"
        confirmColor="red"
      />
    </Page>
  );
};

export default CollectionsPage;
