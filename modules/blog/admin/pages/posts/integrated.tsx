import React, { useState, useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { yupResolver } from '@hookform/resolvers/yup';
import * as yup from 'yup';
import { toast } from 'sonner';
import { SupabaseAuthService } from '@/utils/supabaseAuth';
import {
  PlusIcon,
  PencilIcon,
  TrashIcon,
  DocumentTextIcon,
  EyeIcon,
  MagnifyingGlassIcon,
  TagIcon,
  ClockIcon,
  CheckCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import { Modal, Button, Input, Card, Badge, ConfirmModal, Select, Tabs } from '@/components/ui';
import RichTextEditor from '@/components/ui/RichTextEditor';
import {
  BlogPost,
  BlogCategory,
  BlogTag,
  BlogPostsService,
  BlogCategoriesService,
  BlogTagsService,
  BlogUtils,
} from '@/utils/blogService';

// Post form validation schema
const postSchema = yup.object({
  title: yup.string().required('Title is required').min(5, 'Title must be at least 5 characters'),
  excerpt: yup.string().optional(),
  content: yup.string().required('Content is required').min(50, 'Content must be at least 50 characters'),
  featured_image: yup.string().url('Must be a valid URL').optional(),
  featured_image_alt: yup.string().optional(),
  status: yup.string().oneOf(['draft', 'published', 'archived']).required(),
  visibility: yup.string().oneOf(['public', 'private', 'password_protected']).required(),
  password: yup.string().optional(),
  meta_title: yup.string().max(60, 'Meta title must be 60 characters or less').optional(),
  meta_description: yup.string().max(160, 'Meta description must be 160 characters or less').optional(),
  canonical_url: yup.string().url('Must be a valid URL').optional(),
  og_title: yup.string().max(60, 'OG title must be 60 characters or less').optional(),
  og_description: yup.string().max(160, 'OG description must be 160 characters or less').optional(),
  og_image: yup.string().url('Must be a valid URL').optional(),
  twitter_title: yup.string().max(60, 'Twitter title must be 60 characters or less').optional(),
  twitter_description: yup.string().max(160, 'Twitter description must be 160 characters or less').optional(),
  twitter_image: yup.string().url('Must be a valid URL').optional(),
  category_id: yup.string().optional(),
  is_featured: yup.boolean().default(false),
  allow_comments: yup.boolean().default(true),
  scheduled_for: yup.string().optional(),
});

// Category form validation schema
const categorySchema = yup.object({
  name: yup.string().required('Category name is required').min(2, 'Name must be at least 2 characters'),
  description: yup.string().optional(),
  color: yup.string().matches(/^#[0-9A-F]{6}$/i, 'Invalid color format').required('Color is required'),
  image_url: yup.string().url('Must be a valid URL').optional(),
  is_featured: yup.boolean().default(false),
  meta_title: yup.string().max(60, 'Meta title must be 60 characters or less').optional(),
  meta_description: yup.string().max(160, 'Meta description must be 160 characters or less').optional(),
});

// Tag form validation schema
const tagSchema = yup.object({
  name: yup.string().required('Tag name is required').min(2, 'Name must be at least 2 characters'),
  description: yup.string().optional(),
  color: yup.string().matches(/^#[0-9A-F]{6}$/i, 'Invalid color format').required('Color is required'),
});

type PostFormData = yup.InferType<typeof postSchema>;
type CategoryFormData = yup.InferType<typeof categorySchema>;
type TagFormData = yup.InferType<typeof tagSchema>;
type TabType = 'posts' | 'categories' | 'tags';

const BlogManagement: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('posts');

  // Data state
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [categories, setCategories] = useState<BlogCategory[]>([]);
  const [tags, setTags] = useState<BlogTag[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // UI state
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showModal, setShowModal] = useState(false);

  // Posts state
  const [editingPost, setEditingPost] = useState<BlogPost | null>(null);
  const [deletePost, setDeletePost] = useState<BlogPost | null>(null);

  // Categories state
  const [editingCategory, setEditingCategory] = useState<BlogCategory | null>(null);
  const [deleteCategory, setDeleteCategory] = useState<BlogCategory | null>(null);

  // Tags state
  const [editingTag, setEditingTag] = useState<BlogTag | null>(null);
  const [deleteTag, setDeleteTag] = useState<BlogTag | null>(null);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');

  // Forms
  const postForm = useForm<PostFormData>({
    resolver: yupResolver(postSchema) as any,
    defaultValues: {
      status: 'draft',
      visibility: 'public',
      is_featured: false,
      allow_comments: true,
    },
  });

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

  const watchedPostContent = postForm.watch('content', '');

  // Load all data
  const loadData = async () => {
    setLoading(true);
    try {
      const [postsResult, categoriesResult, tagsResult] = await Promise.all([
        BlogPostsService.getAll(),
        BlogCategoriesService.getAll(),
        BlogTagsService.getAll(),
      ]);

      if (postsResult.success && postsResult.data) setPosts(postsResult.data);
      if (categoriesResult.success && categoriesResult.data) setCategories(categoriesResult.data);
      if (tagsResult.success && tagsResult.data) setTags(tagsResult.data);
    } catch (error) {
      toast.error('Failed to load data');
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Filter posts
  const filteredPosts = useMemo(() => {
    return posts.filter((post) => {
      const matchesSearch = !searchTerm ||
        post.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        post.excerpt?.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesStatus = !statusFilter || post.status === statusFilter;
      const matchesCategory = !categoryFilter || post.category_id === categoryFilter;

      return matchesSearch && matchesStatus && matchesCategory;
    });
  }, [posts, searchTerm, statusFilter, categoryFilter]);

  // Handle post submission
  const onPostSubmit = async (data: PostFormData) => {
    setSubmitting(true);
    try {
      let result;

      if (editingPost) {
        result = await BlogPostsService.update(editingPost.id, data, selectedTags);
      } else {
        // Get current auth user ID for RLS policies
        const authUserId = await SupabaseAuthService.getAuthUserId();
        if (!authUserId) {
          toast.error('You must be authenticated to create posts');
          return;
        }

        const postData = {
          ...data,
          author_id: authUserId,
        };
        result = await BlogPostsService.create(postData, selectedTags);
      }

      if (result.success) {
        toast.success(result.message || `Post ${editingPost ? 'updated' : 'created'} successfully`);
        await loadData();
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

  // Handle category submission
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
        await loadData();
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

  // Handle tag submission
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
        await loadData();
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
  const handleDeletePost = async () => {
    if (!deletePost) return;

    try {
      const result = await BlogPostsService.delete(deletePost.id);
      if (result.success) {
        toast.success('Post deleted successfully');
        await loadData();
      } else {
        toast.error(result.error || 'Failed to delete post');
      }
    } catch (error) {
      toast.error('Failed to delete post');
      console.error('Delete error:', error);
    } finally {
      setDeletePost(null);
    }
  };

  const handleDeleteCategory = async () => {
    if (!deleteCategory) return;

    try {
      const result = await BlogCategoriesService.delete(deleteCategory.id);
      if (result.success) {
        toast.success('Category deleted successfully');
        await loadData();
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
        await loadData();
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
  const handleOpenPostModal = (post?: BlogPost) => {
    setEditingPost(post || null);
    setEditingCategory(null);
    setEditingTag(null);

    if (post) {
      // Populate form with post data
      // Populate form with post data, excluding tags and other non-form fields
      const formFields: (keyof PostFormData)[] = [
        'title', 'excerpt', 'content', 'featured_image', 'featured_image_alt',
        'status', 'visibility', 'password', 'meta_title', 'meta_description',
        'canonical_url', 'og_title', 'og_description', 'og_image',
        'twitter_title', 'twitter_description', 'twitter_image',
        'category_id', 'is_featured', 'allow_comments', 'scheduled_for'
      ];

      formFields.forEach(field => {
        if (field in post) {
          postForm.setValue(field, (post as any)[field]);
        }
      });
      setSelectedTags(post.tags?.map(tag => tag.id) || []);
    } else {
      postForm.reset({
        status: 'draft',
        visibility: 'public',
        is_featured: false,
        allow_comments: true,
      });
      setSelectedTags([]);
    }
    setShowModal(true);
  };

  const handleOpenCategoryModal = (category?: BlogCategory) => {
    setEditingCategory(category || null);
    setEditingPost(null);
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
    setEditingTag(tag || null);
    setEditingPost(null);
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
    setEditingPost(null);
    setEditingCategory(null);
    setEditingTag(null);
    postForm.reset();
    categoryForm.reset();
    tagForm.reset();
    setSelectedTags([]);
  };

  const isEditingPost = !!editingPost;
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
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
            Blog Management
          </h1>
          <p className="text-[var(--gray-11)]">
            Manage your blog posts, categories, and tags
          </p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onChange={setActiveTab}
        tabs={[
          { id: 'posts', label: 'Posts', count: posts.length },
          { id: 'categories', label: 'Categories', count: categories.length },
          { id: 'tags', label: 'Tags', count: tags.length },
        ]}
      />

      {/* Posts Tab */}
      {activeTab === 'posts' && (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-semibold text-[var(--gray-12)]">Posts</h2>
            <Button
              onClick={() => handleOpenPostModal()}
              className="inline-flex items-center space-x-2"
            >
              <PlusIcon className="h-5 w-5" />
              <span>New Post</span>
            </Button>
          </div>

          {/* Filters */}
          <Card className="p-4">
            <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
              <div className="flex items-center gap-2">
                <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
                <Input
                  placeholder="Search posts..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-64"
                />
              </div>

              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">All statuses</option>
                <option value="draft">Draft</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </Select>

              <Select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
              >
                <option value="">All categories</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </div>
          </Card>

          {/* Posts Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredPosts.map((post) => (
              <Card key={post.id} className="p-6 hover:shadow-lg transition-shadow">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-[var(--gray-12)] mb-2 line-clamp-2">
                      {post.title}
                    </h3>
                    <div className="flex items-center space-x-2 mb-2">
                      <Badge
                        color={post.status === 'published' ? 'success' : post.status === 'draft' ? 'warning' : 'error'}
                      >
                        {post.status}
                      </Badge>
                      {post.is_featured && (
                        <Badge color="primary">
                          Featured
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                {post.excerpt && (
                  <p className="text-[var(--gray-11)] text-sm mb-4 line-clamp-3">
                    {post.excerpt}
                  </p>
                )}

                {post.category && (
                  <div className="mb-3">
                    <span className="inline-block px-2 py-1 text-xs bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 rounded">
                      {post.category.name}
                    </span>
                  </div>
                )}

                {post.tags && post.tags.length > 0 && (
                  <div className="mb-4">
                    <div className="flex flex-wrap gap-1">
                      {post.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag.id}
                          className="inline-block px-2 py-1 text-xs bg-gray-100 dark:bg-gray-800 text-[var(--gray-11)] rounded"
                        >
                          {tag.name}
                        </span>
                      ))}
                      {post.tags.length > 3 && (
                        <span className="inline-block px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-[var(--gray-11)] rounded">
                          +{post.tags.length - 3} more
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <div className="text-xs text-[var(--gray-11)] mb-4">
                  {post.status === 'published' && post.published_at
                    ? `Published ${new Date(post.published_at).toLocaleDateString()}`
                    : `Updated ${new Date(post.updated_at).toLocaleDateString()}`
                  }
                </div>

                <div className="flex items-center space-x-2">
                  <Button
                    variant="outlined"
                    onClick={() => handleOpenPostModal(post)}
                    className="flex-1"
                  >
                    <PencilIcon className="h-4 w-4 mr-1" />
                    Edit
                  </Button>

                  <Button
                    variant="outlined"
                    color="error"
                    onClick={() => setDeletePost(post)}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            ))}

            {filteredPosts.length === 0 && (
              <div className="col-span-full text-center py-12">
                <DocumentTextIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-[var(--gray-12)]">
                  {searchTerm || statusFilter || categoryFilter ? 'No posts match your filters' : 'No blog posts'}
                </h3>
                <p className="mt-1 text-sm text-[var(--gray-11)]">
                  {searchTerm || statusFilter || categoryFilter
                    ? 'Try adjusting your search criteria.'
                    : 'Get started by creating your first blog post.'
                  }
                </p>
                {!searchTerm && !statusFilter && !categoryFilter && (
                  <div className="mt-6">
                    <Button onClick={() => handleOpenPostModal()}>
                      <PlusIcon className="h-5 w-5 mr-2" />
                      New Post
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

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

      {/* Post Modal */}
      {showModal && (editingPost !== null || (!editingCategory && !editingTag)) && (
        <Modal
          isOpen={showModal}
          onClose={handleCloseModal}
          title={isEditingPost ? 'Edit Post' : 'Create Post'}
          size="xl"
        >
          <form onSubmit={postForm.handleSubmit(onPostSubmit)} className="space-y-6">
            <div className="grid grid-cols-3 gap-6">
              {/* Main Content */}
              <div className="col-span-2 space-y-6">
                <Input
                  label="Title"
                  placeholder="Enter post title"
                  {...postForm.register('title')}
                  error={postForm.formState.errors.title?.message}
                  required
                />

                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                    Content
                  </label>
                  <RichTextEditor
                    content={watchedPostContent}
                    onChange={(content) => postForm.setValue('content', content)}
                    placeholder="Write your post content..."
                  />
                  {postForm.formState.errors.content && (
                    <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                      {postForm.formState.errors.content.message}
                    </p>
                  )}
                </div>

                <Input
                  label="Excerpt"
                  placeholder="Brief summary (optional)"
                  {...postForm.register('excerpt')}
                  error={postForm.formState.errors.excerpt?.message}
                />
              </div>

              {/* Sidebar */}
              <div className="space-y-6">
                {/* Publishing */}
                <Card className="p-4">
                  <h3 className="font-semibold text-[var(--gray-12)] mb-4">Publishing</h3>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                        Status
                      </label>
                      <select
                        {...postForm.register('status')}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-800"
                      >
                        <option value="draft">Draft</option>
                        <option value="published">Published</option>
                        <option value="archived">Archived</option>
                      </select>
                      {postForm.formState.errors.status && (
                        <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                          {postForm.formState.errors.status.message}
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                        Visibility
                      </label>
                      <select
                        {...postForm.register('visibility')}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-800"
                      >
                        <option value="public">Public</option>
                        <option value="private">Private</option>
                        <option value="password_protected">Password Protected</option>
                      </select>
                      {postForm.formState.errors.visibility && (
                        <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                          {postForm.formState.errors.visibility.message}
                        </p>
                      )}
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          id="is_featured"
                          {...postForm.register('is_featured')}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <label htmlFor="is_featured" className="ml-2 text-sm text-[var(--gray-11)]">
                          Featured post
                        </label>
                      </div>

                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          id="allow_comments"
                          {...postForm.register('allow_comments')}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <label htmlFor="allow_comments" className="ml-2 text-sm text-[var(--gray-11)]">
                          Allow comments
                        </label>
                      </div>
                    </div>
                  </div>
                </Card>

                {/* Category & Tags */}
                <Card className="p-4">
                  <h3 className="font-semibold text-[var(--gray-12)] mb-4">Organization</h3>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                        Category
                      </label>
                      <select
                        {...postForm.register('category_id')}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-800"
                      >
                        <option value="">Select category</option>
                        {categories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                      </select>
                      {postForm.formState.errors.category_id && (
                        <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                          {postForm.formState.errors.category_id.message}
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
                        Tags
                      </label>
                      <div className="space-y-2 max-h-40 overflow-y-auto">
                        {tags.map(tag => (
                          <div key={tag.id} className="flex items-center">
                            <input
                              type="checkbox"
                              id={`tag-${tag.id}`}
                              checked={selectedTags.includes(tag.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedTags([...selectedTags, tag.id]);
                                } else {
                                  setSelectedTags(selectedTags.filter(id => id !== tag.id));
                                }
                              }}
                              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                            />
                            <label
                              htmlFor={`tag-${tag.id}`}
                              className="ml-2 text-sm text-[var(--gray-11)]"
                            >
                              {tag.name}
                            </label>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </Card>

                {/* Featured Image */}
                <Card className="p-4">
                  <h3 className="font-semibold text-[var(--gray-12)] mb-4">Featured Image</h3>

                  <div className="space-y-4">
                    <Input
                      label="Image URL"
                      placeholder="https://example.com/image.jpg"
                      {...postForm.register('featured_image')}
                      error={postForm.formState.errors.featured_image?.message}
                    />

                    <Input
                      label="Alt Text"
                      placeholder="Image description"
                      {...postForm.register('featured_image_alt')}
                      error={postForm.formState.errors.featured_image_alt?.message}
                    />
                  </div>
                </Card>

                {/* SEO & Social Media */}
                <Card className="p-4">
                  <h3 className="font-semibold text-[var(--gray-12)] mb-4">SEO & Social Media</h3>

                  <div className="space-y-4">
                    <Input
                      label="Meta Title"
                      placeholder="SEO title (max 60 chars)"
                      {...postForm.register('meta_title')}
                      error={postForm.formState.errors.meta_title?.message}
                      maxLength={60}
                    />

                    <Input
                      label="Meta Description"
                      placeholder="SEO description (max 160 chars)"
                      {...postForm.register('meta_description')}
                      error={postForm.formState.errors.meta_description?.message}
                      maxLength={160}
                    />

                    <Input
                      label="Canonical URL"
                      placeholder="https://example.com/canonical-url"
                      {...postForm.register('canonical_url')}
                      error={postForm.formState.errors.canonical_url?.message}
                    />

                    <Input
                      label="OG Title"
                      placeholder="Open Graph title (max 60 chars)"
                      {...postForm.register('og_title')}
                      error={postForm.formState.errors.og_title?.message}
                      maxLength={60}
                    />

                    <Input
                      label="OG Description"
                      placeholder="Open Graph description (max 160 chars)"
                      {...postForm.register('og_description')}
                      error={postForm.formState.errors.og_description?.message}
                      maxLength={160}
                    />

                    <Input
                      label="OG Image"
                      placeholder="https://example.com/og-image.jpg"
                      {...postForm.register('og_image')}
                      error={postForm.formState.errors.og_image?.message}
                    />

                    <Input
                      label="Twitter Title"
                      placeholder="Twitter card title (max 60 chars)"
                      {...postForm.register('twitter_title')}
                      error={postForm.formState.errors.twitter_title?.message}
                      maxLength={60}
                    />

                    <Input
                      label="Twitter Description"
                      placeholder="Twitter card description (max 160 chars)"
                      {...postForm.register('twitter_description')}
                      error={postForm.formState.errors.twitter_description?.message}
                      maxLength={160}
                    />

                    <Input
                      label="Twitter Image"
                      placeholder="https://example.com/twitter-image.jpg"
                      {...postForm.register('twitter_image')}
                      error={postForm.formState.errors.twitter_image?.message}
                    />
                  </div>
                </Card>
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
                {submitting ? 'Saving...' : isEditingPost ? 'Update Post' : 'Create Post'}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Category Modal */}
      {showModal && editingCategory !== null && (
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

      {/* Tag Modal */}
      {showModal && editingTag !== null && (
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

      {/* Delete Confirmation Modals */}
      <ConfirmModal
        isOpen={!!deletePost}
        onClose={() => setDeletePost(null)}
        onConfirm={handleDeletePost}
        title="Delete Post"
        message={`Are you sure you want to delete "${deletePost?.title}"? This action cannot be undone.`}
      />

      <ConfirmModal
        isOpen={!!deleteCategory}
        onClose={() => setDeleteCategory(null)}
        onConfirm={handleDeleteCategory}
        title="Delete Category"
        message={`Are you sure you want to delete "${deleteCategory?.name}"? This action cannot be undone.`}
      />

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