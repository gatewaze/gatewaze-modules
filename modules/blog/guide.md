# Blog

Publish and manage blog posts, categories, and integrated content. The blog module provides both an admin CMS for authoring posts and a public-facing portal for readers, with full SEO support, social media metadata, analytics tracking, and content embeddings.

## How It Works

The module creates four database tables:

**Blog Posts** (`blog_posts`) store articles with rich content fields including title, slug, excerpt, HTML content, and featured image. Posts support three statuses (draft, published, archived) and three visibility levels (public, private, password-protected). Each post has comprehensive SEO fields (meta title, meta description, canonical URL) and social media overrides for Open Graph and Twitter cards. Posts track analytics (view count, like count, share count), reading time, and word count. A `published_at` timestamp enables backdating, and `scheduled_for` supports future publishing.

**Blog Categories** (`blog_categories`) organize posts into groups with name, slug, description, color, image, and SEO metadata. Categories track their post count and can be marked as featured.

**Blog Tags** (`blog_tags`) provide a secondary taxonomy with name, slug, description, and color. A junction table (`blog_post_tags`) enables many-to-many tagging.

The admin interface provides a post management page for creating, editing, and publishing blog content. The portal provides a public blog listing page (grid layout with featured images, categories, excerpts, and reading times) and individual post pages accessible by slug.

Additional migrations add vector embeddings for blog content (for AI/search features) and content categories for cross-module categorization.

## Configuration

This module has no configurable settings.

## Features

- **blog** -- Core blog functionality and post management
- **blog.posts** -- Post authoring with rich text, featured images, and scheduling
- **blog.categories** -- Category management with colors, images, and SEO fields
- Full SEO support (meta title, meta description, canonical URL, OG tags, Twitter cards)
- Post statuses: draft, published, archived
- Visibility controls: public, private, password-protected
- Tag-based taxonomy with many-to-many relationships
- Analytics tracking (views, likes, shares)
- Reading time and word count calculation
- Vector embeddings for AI-powered search
- Public portal with blog listing and individual post pages
- Admin CMS for content authoring
- Row-level security (authenticated users can read; admins can write)

## Dependencies

None.
