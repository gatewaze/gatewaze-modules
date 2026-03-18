import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { yupResolver } from '@hookform/resolvers/yup';
import * as yup from 'yup';
import { toast } from 'sonner';
import {
  PlusIcon,
  PencilIcon,
  TrashIcon,
  TagIcon,
} from '@heroicons/react/24/outline';
import { Modal, Button, Input, Card, Badge, ConfirmModal, Tabs } from '@/components/ui';
import { BlogCategory, BlogTag, BlogCategoriesService, BlogTagsService } from '@/utils/blogService';

// Form validation schemas
const categorySchema = yup.object({
  name: yup.string().required('Category name is required').min(2, 'Name must be at least 2 characters'),
  description: yup.string().optional(),
  color: yup.string().matches(/^#[0-9A-F]{6}$/i, 'Invalid color format').required('Color is required'),
  image_url: yup.string().url('Must be a valid URL').optional(),
  is_featured: yup.boolean().default(false),
  meta_title: yup.string().max(60, 'Meta title must be 60 characters or less').optional(),
  meta_description: yup.string().max(160, 'Meta description must be 160 characters or less').optional(),
});

const tagSchema = yup.object({
  name: yup.string().required('Tag name is required').min(2, 'Name must be at least 2 characters'),
  description: yup.string().optional(),
  color: yup.string().matches(/^#[0-9A-F]{6}$/i, 'Invalid color format').required('Color is required'),
});

type CategoryFormData = yup.InferType<typeof categorySchema>;
type TagFormData = yup.InferType<typeof tagSchema>;

type TabType = 'categories' | 'tags';

const BlogManagement: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('categories');
  const [categories, setCategories] = useState<BlogCategory[]>([]);
  const [tags, setTags] = useState<BlogTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [modalType, setModalType] = useState<'category' | 'tag' | null>(null);
  const [editingCategory, setEditingCategory] = useState<BlogCategory | null>(null);
  const [editingTag, setEditingTag] = useState<BlogTag | null>(null);
  const [deleteCategory, setDeleteCategory] = useState<BlogCategory | null>(null);
  const [deleteTag, setDeleteTag] = useState<BlogTag | null>(null);

  const categoryForm = useForm<CategoryFormData>({
    resolver: yupResolver(categorySchema) as any,
    defaultValues: {
      color: '#3B82F6',
      is_featured: false,
    },
  });

  const tagForm = useForm<TagFormData>({
    resolver: yupResolver(tagSchema) as any,
    defaultValues: {
      color: '#6B7280',
    },
  });

  // Load data
  const loadCategories = async () => {
    try {
      const result = await BlogCategoriesService.getAll();
      if (result.success && result.data) {
        setCategories(result.data);
      } else {
        toast.error(result.error || 'Failed to load categories');
      }
    } catch (error) {
      toast.error('Failed to load categories');
      console.error('Error loading categories:', error);
    }
  };

  const loadTags = async () => {
    try {
      const result = await BlogTagsService.getAll();
      if (result.success && result.data) {
        setTags(result.data);
      } else {
        toast.error(result.error || 'Failed to load tags');
      }
    } catch (error) {
      toast.error('Failed to load tags');
      console.error('Error loading tags:', error);
    }
  };

  const loadData = async () => {
    setLoading(true);
    await Promise.all([loadCategories(), loadTags()]);
    setLoading(false);
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Form submission handlers
  const onCategorySubmit = async (data: CategoryFormData) => {
    setSubmitting(true);
    try {
      let result;

      if (editingCategory) {
        result = await BlogCategoriesService.update(editingCategory.id, data);
      } else {
        result = await BlogCategoriesService.create(data);
      }

      if (result.success) {
        toast.success(result.message || `Category ${editingCategory ? 'updated' : 'created'} successfully`);
        await loadCategories();
        handleCloseModal();
      } else {
        toast.error(result.error || 'Operation failed');
      }
    } catch (error) {
      toast.error('An unexpected error occurred');
      console.error('Form submission error:', error);
    } finally {
      setSubmitting(false);
    }
  };

  const onTagSubmit = async (data: TagFormData) => {
    setSubmitting(true);
    try {
      let result;

      if (editingTag) {
        result = await BlogTagsService.update(editingTag.id, data);
      } else {
        result = await BlogTagsService.create(data);
      }

      if (result.success) {
        toast.success(result.message || `Tag ${editingTag ? 'updated' : 'created'} successfully`);
        await loadTags();
        handleCloseModal();
      } else {
        toast.error(result.error || 'Operation failed');
      }
    } catch (error) {
      toast.error('An unexpected error occurred');
      console.error('Form submission error:', error);
    } finally {
      setSubmitting(false);
    }
  };

  // Delete handlers
  const handleDeleteCategory = async () => {
    if (!deleteCategory) return;

    try {
      const result = await BlogCategoriesService.delete(deleteCategory.id);
      if (result.success) {
        toast.success('Category deleted successfully');
        await loadCategories();
      } else {
        toast.error(result.error || 'Failed to delete category');
      }
    } catch (error) {
      toast.error('Failed to delete category');
      console.error('Delete error:', error);
    } finally {
      setDeleteCategory(null);
    }
  };

  const handleDeleteTag = async () => {
    if (!deleteTag) return;

    try {
      const result = await BlogTagsService.delete(deleteTag.id);
      if (result.success) {
        toast.success('Tag deleted successfully');
        await loadTags();
      } else {
        toast.error(result.error || 'Failed to delete tag');
      }
    } catch (error) {
      toast.error('Failed to delete tag');
      console.error('Delete error:', error);
    } finally {
      setDeleteTag(null);
    }
  };

  // Modal handlers
  const handleOpenCategoryModal = (category?: BlogCategory) => {
    setModalType('category');
    setEditingCategory(category || null);
    setEditingTag(null);
    if (category) {
      Object.keys(category).forEach(key => {
        const typedKey = key as keyof CategoryFormData;
        if (typedKey in category) {
          categoryForm.setValue(typedKey, (category as any)[typedKey]);
        }
      });
    } else {
      categoryForm.reset({
        color: '#3B82F6',
        is_featured: false,
      });
    }
    setShowModal(true);
  };

  const handleOpenTagModal = (tag?: BlogTag) => {
    setModalType('tag');
    setEditingTag(tag || null);
    setEditingCategory(null);
    if (tag) {
      Object.keys(tag).forEach(key => {
        const typedKey = key as keyof TagFormData;
        if (typedKey in tag) {
          tagForm.setValue(typedKey, (tag as any)[typedKey]);
        }
      });
    } else {
      tagForm.reset({
        color: '#6B7280',
      });
    }
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setModalType(null);
    setEditingCategory(null);
    setEditingTag(null);
    categoryForm.reset();
    tagForm.reset();
  };

  const isEditingCategory = !!editingCategory;
  const isEditingTag = !!editingTag;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
            Blog Management
          </h1>
          <p className="text-[var(--gray-11)]">
            Manage your blog categories and tags
          </p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onChange={setActiveTab}
        tabs={[
          { id: 'categories', label: 'Categories', count: categories.length },
          { id: 'tags', label: 'Tags', count: tags.length },
        ]}
      />

      {/* Categories Tab */}
      {activeTab === 'categories' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-semibold text-[var(--gray-12)]">Categories</h2>
            <Button
              onClick={() => handleOpenCategoryModal()}
              className="inline-flex items-center space-x-2"
            >
              <PlusIcon className="h-5 w-5" />
              <span>Add Category</span>
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {categories.map((category) => (
              <Card key={category.id} className="p-6 hover:shadow-lg transition-shadow">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center space-x-3">
                    <div
                      className="w-4 h-4 rounded-full"
                      style={{ backgroundColor: category.color }}
                    />
                    <h3 className="text-lg font-semibold text-[var(--gray-12)]">
                      {category.name}
                    </h3>
                  </div>

                  <div className="flex items-center space-x-2">
                    {category.is_featured && (
                      <Badge color="primary">
                        Featured
                      </Badge>
                    )}
                    <Badge color="secondary">
                      {category.post_count} posts
                    </Badge>
                  </div>
                </div>

                {category.description && (
                  <p className="text-[var(--gray-11)] text-sm mb-4 line-clamp-2">
                    {category.description}
                  </p>
                )}

                <div className="space-y-2 mb-4 text-xs text-[var(--gray-11)]">
                  <div>Slug: <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">{category.slug}</code></div>
                  <div>Created: {new Date(category.created_at).toLocaleDateString()}</div>
                </div>

                <div className="flex items-center space-x-2">
                  <Button
                    variant="outlined"
                    onClick={() => handleOpenCategoryModal(category)}
                    className="flex-1"
                  >
                    <PencilIcon className="h-4 w-4 mr-1" />
                    Edit
                  </Button>

                  <Button
                    variant="outlined"
                    color="error"
                    onClick={() => setDeleteCategory(category)}
                    className="flex-1"
                  >
                    <TrashIcon className="h-4 w-4 mr-1" />
                    Delete
                  </Button>
                </div>
              </Card>
            ))}

            {categories.length === 0 && (
              <div className="col-span-full text-center py-12">
                <TagIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-[var(--gray-12)]">
                  No categories
                </h3>
                <p className="mt-1 text-sm text-[var(--gray-11)]">
                  Get started by creating your first blog category.
                </p>
                <div className="mt-6">
                  <Button onClick={() => handleOpenCategoryModal()}>
                    <PlusIcon className="h-5 w-5 mr-2" />
                    Add Category
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tags Tab */}
      {activeTab === 'tags' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-semibold text-[var(--gray-12)]">Tags</h2>
            <Button
              onClick={() => handleOpenTagModal()}
              className="inline-flex items-center space-x-2"
            >
              <PlusIcon className="h-5 w-5" />
              <span>Add Tag</span>
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {tags.map((tag) => (
              <Card key={tag.id} className="p-4 hover:shadow-lg transition-shadow">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center space-x-2">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <h3 className="font-semibold text-[var(--gray-12)]">
                      {tag.name}
                    </h3>
                  </div>

                  <Badge color="secondary" className="text-xs">
                    {tag.post_count} posts
                  </Badge>
                </div>

                {tag.description && (
                  <p className="text-[var(--gray-11)] text-sm mb-3 line-clamp-2">
                    {tag.description}
                  </p>
                )}

                <div className="space-y-1 mb-3 text-xs text-[var(--gray-11)]">
                  <div>Slug: <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">{tag.slug}</code></div>
                </div>

                <div className="flex items-center space-x-2">
                  <Button
                    variant="outlined"
                    onClick={() => handleOpenTagModal(tag)}
                    className="flex-1"
                  >
                    <PencilIcon className="h-3 w-3 mr-1" />
                    Edit
                  </Button>

                  <Button
                    variant="outlined"
                    color="error"
                    onClick={() => setDeleteTag(tag)}
                    className="flex-1"
                  >
                    <TrashIcon className="h-3 w-3 mr-1" />
                    Delete
                  </Button>
                </div>
              </Card>
            ))}

            {tags.length === 0 && (
              <div className="col-span-full text-center py-12">
                <TagIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-[var(--gray-12)]">
                  No tags
                </h3>
                <p className="mt-1 text-sm text-[var(--gray-11)]">
                  Get started by creating your first blog tag.
                </p>
                <div className="mt-6">
                  <Button onClick={() => handleOpenTagModal()}>
                    <PlusIcon className="h-5 w-5 mr-2" />
                    Add Tag
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create/Edit Category Modal */}
      {(showModal && modalType === 'category') && (
        <Modal
          isOpen={showModal}
          onClose={handleCloseModal}
          title={isEditingCategory ? 'Edit Category' : 'Create Category'}
          size="lg"
        >
          <form onSubmit={categoryForm.handleSubmit(onCategorySubmit)} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="md:col-span-2">
                <Input
                  label="Category Name"
                  placeholder="Enter category name"
                  {...categoryForm.register('name')}
                  error={categoryForm.formState.errors.name?.message}
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                  Color
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    type="color"
                    {...categoryForm.register('color')}
                    className="w-12 h-10 border border-gray-300 rounded-md cursor-pointer"
                  />
                  <div className="flex-1">
                    <Input
                      placeholder="#3B82F6"
                      {...categoryForm.register('color')}
                      error={categoryForm.formState.errors.color?.message}
                    />
                  </div>
                </div>
              </div>

              <div>
                <Input
                  label="Image URL"
                  placeholder="https://example.com/image.jpg"
                  {...categoryForm.register('image_url')}
                  error={categoryForm.formState.errors.image_url?.message}
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                  Description
                </label>
                <textarea
                  {...categoryForm.register('description')}
                  placeholder="Brief description of this category..."
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-800"
                />
              </div>

              <div>
                <Input
                  label="Meta Title (SEO)"
                  placeholder="SEO-friendly title (max 60 chars)"
                  {...categoryForm.register('meta_title')}
                  error={categoryForm.formState.errors.meta_title?.message}
                  maxLength={60}
                />
              </div>

              <div>
                <Input
                  label="Meta Description (SEO)"
                  placeholder="SEO description (max 160 chars)"
                  {...categoryForm.register('meta_description')}
                  error={categoryForm.formState.errors.meta_description?.message}
                  maxLength={160}
                />
              </div>

              <div className="md:col-span-2">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="is_featured"
                    {...categoryForm.register('is_featured')}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <label htmlFor="is_featured" className="ml-2 block text-sm text-[var(--gray-11)]">
                    Featured category (will be highlighted in the blog)
                  </label>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end space-x-4">
              <Button
                type="button"
                variant="outlined"
                onClick={handleCloseModal}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting}
              >
                {submitting ? 'Saving...' : isEditingCategory ? 'Update Category' : 'Create Category'}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Create/Edit Tag Modal */}
      {(showModal && modalType === 'tag') && (
        <Modal
          isOpen={showModal}
          onClose={handleCloseModal}
          title={isEditingTag ? 'Edit Tag' : 'Create Tag'}
          size="md"
        >
          <form onSubmit={tagForm.handleSubmit(onTagSubmit)} className="space-y-6">
            <div className="space-y-4">
              <Input
                label="Tag Name"
                placeholder="Enter tag name"
                {...tagForm.register('name')}
                error={tagForm.formState.errors.name?.message}
                required
              />

              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                  Color
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    type="color"
                    {...tagForm.register('color')}
                    className="w-12 h-10 border border-gray-300 rounded-md cursor-pointer"
                  />
                  <div className="flex-1">
                    <Input
                      placeholder="#6B7280"
                      {...tagForm.register('color')}
                      error={tagForm.formState.errors.color?.message}
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                  Description
                </label>
                <textarea
                  {...tagForm.register('description')}
                  placeholder="Brief description of this tag..."
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-800"
                />
              </div>
            </div>

            <div className="flex items-center justify-end space-x-4">
              <Button
                type="button"
                variant="outlined"
                onClick={handleCloseModal}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting}
              >
                {submitting ? 'Saving...' : isEditingTag ? 'Update Tag' : 'Create Tag'}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Delete Category Confirmation Modal */}
      <ConfirmModal
        isOpen={!!deleteCategory}
        onClose={() => setDeleteCategory(null)}
        onConfirm={handleDeleteCategory}
        title="Delete Category"
        message={`Are you sure you want to delete "${deleteCategory?.name}"? This action cannot be undone.`}
      />

      {/* Delete Tag Confirmation Modal */}
      <ConfirmModal
        isOpen={!!deleteTag}
        onClose={() => setDeleteTag(null)}
        onConfirm={handleDeleteTag}
        title="Delete Tag"
        message={`Are you sure you want to delete "${deleteTag?.name}"? This action cannot be undone.`}
      />
    </div>
  );
};

export default BlogManagement;