import { useState, useEffect } from 'react';
import { PlusIcon, PencilIcon, TrashIcon, TagIcon } from '@heroicons/react/24/outline';
import { useForm } from 'react-hook-form';
import { yupResolver } from '@hookform/resolvers/yup';
import * as Yup from 'yup';
import { toast } from 'sonner';

import {
  Button,
  Card,
  Input,
  Badge,
  Modal,
  ConfirmModal,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
} from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';
import { ScrollableTable } from '@/components/shared/table/ScrollableTable';
import { Page } from '@/components/shared/Page';
import { supabase } from '@/lib/supabase';
import { BudgetService, BudgetCategory, CategoryType } from '@/lib/services/budgetService';
import { useAuthContext } from '@/app/contexts/auth/context';

interface CategoryFormData {
  name: string;
  slug: string;
  category_type: CategoryType;
  description?: string;
  registration_source_value?: string;
  registration_source_pattern?: string;
  color?: string;
  display_order?: number;
}

const categorySchema = Yup.object().shape({
  name: Yup.string().required('Name is required'),
  slug: Yup.string()
    .required('Slug is required')
    .matches(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens'),
  category_type: Yup.string()
    .required('Category type is required')
    .oneOf(['marketing', 'venue', 'catering', 'av', 'supplier', 'other']),
  description: Yup.string(),
  registration_source_value: Yup.string(),
  registration_source_pattern: Yup.string(),
  color: Yup.string().matches(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color (e.g., #FF0000)').nullable(),
  display_order: Yup.number().integer().min(0),
});

const categoryTypeLabels: Record<CategoryType, string> = {
  marketing: 'Marketing',
  venue: 'Venue',
  catering: 'Catering',
  av: 'AV & Production',
  supplier: 'Supplier',
  other: 'Other',
};

const categoryTypeColors: Record<CategoryType, string> = {
  marketing: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  venue: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
  catering: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  av: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
  supplier: 'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-300',
  other: 'bg-gray-100 text-gray-800 dark:bg-gray-700',
};

export default function BudgetCategories() {
  const { user: currentUser } = useAuthContext();
  const [categories, setCategories] = useState<BudgetCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<BudgetCategory | null>(null);
  const [deleteCategory, setDeleteCategory] = useState<BudgetCategory | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [filterType, setFilterType] = useState<CategoryType | 'all'>('all');

  const budgetService = new BudgetService(supabase);

  const form = useForm<CategoryFormData>({
    resolver: yupResolver(categorySchema) as any,
    defaultValues: {
      name: '',
      slug: '',
      category_type: 'marketing',
      description: '',
      registration_source_value: '',
      registration_source_pattern: '',
      color: '#6B7280',
      display_order: 0,
    },
  });

  const isEditing = !!editingCategory;

  useEffect(() => {
    loadCategories();
  }, []);

  const loadCategories = async () => {
    setLoading(true);
    try {
      const data = await budgetService.getCategories({ includeInactive: true });
      setCategories(data);
    } catch (error) {
      toast.error('Failed to load categories');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenModal = (category?: BudgetCategory) => {
    if (category) {
      setEditingCategory(category);
      form.reset({
        name: category.name,
        slug: category.slug,
        category_type: category.category_type,
        description: category.description || '',
        registration_source_value: category.registration_source_value || '',
        registration_source_pattern: category.registration_source_pattern || '',
        color: category.color || '#6B7280',
        display_order: category.display_order,
      });
    } else {
      setEditingCategory(null);
      form.reset({
        name: '',
        slug: '',
        category_type: 'marketing',
        description: '',
        registration_source_value: '',
        registration_source_pattern: '',
        color: '#6B7280',
        display_order: categories.length > 0 ? Math.max(...categories.map(c => c.display_order)) + 1 : 0,
      });
    }
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingCategory(null);
    form.reset();
  };

  const onSubmit = async (data: CategoryFormData) => {
    setSubmitting(true);
    try {
      const categoryData = {
        name: data.name,
        slug: data.slug,
        category_type: data.category_type,
        description: data.description || null,
        registration_source_value: data.registration_source_value || null,
        registration_source_pattern: data.registration_source_pattern || null,
        color: data.color || null,
        display_order: data.display_order || 0,
      };

      if (isEditing) {
        await budgetService.updateCategory(editingCategory!.id, categoryData);
        toast.success('Category updated successfully');
      } else {
        await budgetService.createCategory(categoryData);
        toast.success('Category created successfully');
      }
      handleCloseModal();
      loadCategories();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to save category');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteCategory = async () => {
    if (!deleteCategory) return;

    try {
      await budgetService.deactivateCategory(deleteCategory.id);
      toast.success('Category deactivated successfully');
      setDeleteCategory(null);
      loadCategories();
    } catch (error) {
      toast.error('An error occurred while deactivating category');
    }
  };

  // Auto-generate slug from name
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    form.setValue('name', name);

    // Only auto-generate slug if we're creating a new category
    if (!isEditing) {
      const categoryType = form.getValues('category_type');
      const slug = `${categoryType}-${name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')}`;
      form.setValue('slug', slug);
    }
  };

  const filteredCategories = filterType === 'all'
    ? categories
    : categories.filter(c => c.category_type === filterType);

  return (
    <Page title="Budget Categories">
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Budget Categories
            </h1>
            <p className="text-[var(--gray-11)] mt-1">
              Manage event budget categories and their mappings to registration sources
            </p>
          </div>
          <Button
            onClick={() => handleOpenModal()}
            color="primary"
            className="gap-2"
          >
            <PlusIcon className="size-4" />
            Add Category
          </Button>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2 mb-4 flex-wrap">
          <Button
            variant={filterType === 'all' ? 'filled' : 'outlined'}
            size="sm"
            onClick={() => setFilterType('all')}
          >
            All ({categories.length})
          </Button>
          {(Object.keys(categoryTypeLabels) as CategoryType[]).map((type) => {
            const count = categories.filter(c => c.category_type === type).length;
            return (
              <Button
                key={type}
                variant={filterType === type ? 'filled' : 'outlined'}
                size="sm"
                onClick={() => setFilterType(type)}
              >
                {categoryTypeLabels[type]} ({count})
              </Button>
            );
          })}
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          </div>
        ) : (
          <Card className="overflow-hidden">
            <ScrollableTable>
              <Table>
                <THead>
                  <Tr>
                    <Th data-sticky-left style={{ position: 'sticky', left: 0, zIndex: 20, background: 'var(--color-panel-solid)' }}>Category</Th>
                    <Th>Type</Th>
                    <Th>Registration Source</Th>
                    <Th>Order</Th>
                    <Th>Status</Th>
                    <Th data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 2 }} />
                  </Tr>
                </THead>
                <TBody>
                  {filteredCategories.map((category) => (
                    <Tr key={category.id}>
                      <Td data-sticky-left style={{ position: 'sticky', left: 0, zIndex: 10, background: 'var(--color-panel-solid)' }}>
                        <div className="flex items-center">
                          <div
                            className="flex-shrink-0 h-10 w-10 rounded-lg flex items-center justify-center"
                            style={{ backgroundColor: category.color || '#6B7280' }}
                          >
                            <TagIcon className="h-5 w-5 text-white" />
                          </div>
                          <div className="ml-4">
                            <div className="text-sm font-medium text-[var(--gray-12)]">
                              {category.name}
                            </div>
                            <div className="text-sm text-[var(--gray-11)]">
                              {category.slug}
                            </div>
                          </div>
                        </div>
                      </Td>
                      <Td>
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${categoryTypeColors[category.category_type]}`}>
                          {categoryTypeLabels[category.category_type]}
                        </span>
                      </Td>
                      <Td>
                        {category.registration_source_value ? (
                          <div>
                            <span className="text-sm text-[var(--gray-12)] font-mono bg-[var(--gray-a3)] px-2 py-1 rounded">
                              {category.registration_source_value}
                            </span>
                            <span className="ml-2 text-xs text-[var(--gray-a11)]">(exact)</span>
                          </div>
                        ) : category.registration_source_pattern ? (
                          <div>
                            <span className="text-sm text-[var(--gray-12)] font-mono bg-blue-100 dark:bg-blue-900 px-2 py-1 rounded">
                              {category.registration_source_pattern}
                            </span>
                            <span className="ml-2 text-xs text-blue-500">(pattern)</span>
                          </div>
                        ) : (
                          <span className="text-sm text-[var(--gray-a11)]">-</span>
                        )}
                      </Td>
                      <Td>
                        {category.display_order}
                      </Td>
                      <Td>
                        {category.is_active ? (
                          <Badge color="success">Active</Badge>
                        ) : (
                          <Badge color="gray">Inactive</Badge>
                        )}
                      </Td>
                      <Td data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 1 }}>
                        <RowActions actions={[
                          { label: "Edit", icon: <PencilIcon className="size-4" />, onClick: () => handleOpenModal(category) },
                          { label: "Deactivate", icon: <TrashIcon className="size-4" />, onClick: () => setDeleteCategory(category), color: "red", hidden: !category.is_active },
                        ]} />
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>

              {filteredCategories.length === 0 && (
                <div className="text-center py-12">
                  <TagIcon className="mx-auto h-12 w-12 text-gray-400" />
                  <p className="mt-2 text-[var(--gray-11)]">No categories found</p>
                  <Button
                    onClick={() => handleOpenModal()}
                    color="primary"
                    className="mt-4 gap-2"
                  >
                    <PlusIcon className="size-4" />
                    Create First Category
                  </Button>
                </div>
              )}
            </ScrollableTable>
          </Card>
        )}

        {/* Category Modal */}
        <Modal
          isOpen={showModal}
          onClose={handleCloseModal}
          title={isEditing ? 'Edit Category' : 'Add Category'}
        >
          <form onSubmit={form.handleSubmit(onSubmit as any)} className="space-y-4">
            <Input
              label="Category Name"
              placeholder="e.g., LinkedIn Ads"
              {...form.register('name')}
              onChange={handleNameChange}
              error={form.formState.errors.name?.message}
            />

            <div>
              <Input
                label="Slug"
                placeholder="e.g., marketing-linkedin"
                {...form.register('slug')}
                error={form.formState.errors.slug?.message}
              />
              <p className="mt-1 text-sm text-[var(--gray-11)]">
                Unique identifier. Only lowercase letters, numbers, and hyphens.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">
                Category Type
              </label>
              <select
                {...form.register('category_type')}
                className="w-full px-3 py-2 border border-[var(--gray-a5)] rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {(Object.keys(categoryTypeLabels) as CategoryType[]).map((type) => (
                  <option key={type} value={type}>
                    {categoryTypeLabels[type]}
                  </option>
                ))}
              </select>
              {form.formState.errors.category_type && (
                <p className="text-red-500 text-sm mt-1">{form.formState.errors.category_type.message}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">
                Description
              </label>
              <textarea
                {...form.register('description')}
                rows={2}
                className="w-full px-3 py-2 border border-[var(--gray-a5)] rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="Brief description of this category"
              />
            </div>

            <div className="border-t border-[var(--gray-a5)] pt-4">
              <h4 className="text-sm font-medium text-[var(--gray-12)] mb-3">
                Registration Source Mapping
              </h4>
              <p className="text-sm text-[var(--gray-11)] mb-3">
                Link this category to registration sources for automatic CPA calculation.
                Use either exact match OR pattern (not both).
              </p>

              <Input
                label="Exact Source Value"
                placeholder="e.g., linkedin, facebook, gatewaze"
                {...form.register('registration_source_value')}
                error={form.formState.errors.registration_source_value?.message}
              />
              <p className="mt-1 text-sm text-[var(--gray-11)] mb-3">
                Matches registrations where source equals this exact value.
              </p>

              <Input
                label="Source Pattern (Regex)"
                placeholder="e.g., (facebook|instagram)"
                {...form.register('registration_source_pattern')}
                error={form.formState.errors.registration_source_pattern?.message}
              />
              <p className="mt-1 text-sm text-[var(--gray-11)]">
                Regex pattern for matching multiple sources. Case insensitive.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">
                  Color
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    {...form.register('color')}
                    className="h-10 w-14 rounded border border-[var(--gray-a5)] cursor-pointer"
                  />
                  <Input
                    placeholder="#6B7280"
                    {...form.register('color')}
                    error={form.formState.errors.color?.message}
                    className="flex-1"
                  />
                </div>
              </div>

              <Input
                label="Display Order"
                type="number"
                placeholder="0"
                {...form.register('display_order', { valueAsNumber: true })}
                error={form.formState.errors.display_order?.message}
              />
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <Button
                type="button"
                variant="outlined"
                onClick={handleCloseModal}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                color="primary"
                disabled={submitting}
              >
                {isEditing ? 'Update Category' : 'Create Category'}
              </Button>
            </div>
          </form>
        </Modal>

        {/* Deactivate Confirmation Modal */}
        <ConfirmModal
          isOpen={!!deleteCategory}
          onClose={() => setDeleteCategory(null)}
          onConfirm={handleDeleteCategory}
          title="Deactivate Category"
          message={`Are you sure you want to deactivate "${deleteCategory?.name}"? This category will no longer appear in budget selection lists.`}
          confirmText="Deactivate"
          cancelText="Cancel"
        />
      </div>
    </Page>
  );
}
