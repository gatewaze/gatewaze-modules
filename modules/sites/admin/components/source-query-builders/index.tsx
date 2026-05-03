/**
 * Per-source query-builder thin wrappers.
 *
 * Each one supplies the source-specific config to the generic
 * SourceQueryBuilder. The block-kind editor dispatches to the right
 * wrapper based on the block-def's `source` attribute.
 *
 * Per spec-content-modules-git-architecture §9.1 — these mirror the
 * SourceProvider registrations declared by each owning module.
 */

import { SourceQueryBuilder, type GenericQueryConfig } from '../SourceQueryBuilder';

interface WrapperProps {
  value: Partial<GenericQueryConfig>;
  onChange: (config: GenericQueryConfig) => void;
}

// ---------------------------------------------------------------------------
// blogs — list of blog posts (or specific posts) from the blog module
// ---------------------------------------------------------------------------

export function BlogsQueryBuilder({ value, onChange }: WrapperProps) {
  return (
    <SourceQueryBuilder
      sourceSlug="blogs"
      tableName="blog_posts"
      nameColumn="title"
      secondaryColumn="published_at"
      filterFields={[
        { name: 'category', type: 'enum', label: 'Category', options: [
          { value: 'all', label: 'All categories' },
          { value: 'announcement', label: 'Announcement' },
          { value: 'tutorial', label: 'Tutorial' },
          { value: 'opinion', label: 'Opinion' },
        ]},
        { name: 'author_id', type: 'string', label: 'Author ID' },
        { name: 'tag', type: 'string', label: 'Tag' },
        { name: 'published', type: 'boolean', label: 'Published only' },
      ]}
      sortOptions={[
        { value: 'published_at_desc', label: 'Most recent' },
        { value: 'published_at_asc', label: 'Oldest first' },
        { value: 'title_asc', label: 'Title (A → Z)' },
      ]}
      defaultConfig={{
        filter: { category: 'all', published: true },
        sort: 'published_at_desc',
        limit: 5,
      }}
      value={value}
      onChange={onChange}
      applySortToQuery={(q, sort) => {
        if (sort === 'published_at_desc') return q.order('published_at', { ascending: false });
        if (sort === 'published_at_asc') return q.order('published_at', { ascending: true });
        if (sort === 'title_asc') return q.order('title', { ascending: true });
        return q;
      }}
      applyFilterToQuery={(q, filter) => {
        let next = q;
        if (filter.category && filter.category !== 'all') next = next.eq('category', filter.category);
        if (filter.author_id) next = next.eq('author_id', filter.author_id);
        if (filter.published === true) next = next.eq('published', true);
        return next;
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// lists — newsletter subscriber-count snapshots / latest editions
// ---------------------------------------------------------------------------

export function ListsQueryBuilder({ value, onChange }: WrapperProps) {
  return (
    <SourceQueryBuilder
      sourceSlug="lists"
      tableName="lists"
      nameColumn="name"
      secondaryColumn="slug"
      filterFields={[
        { name: 'is_active', type: 'boolean', label: 'Active only' },
      ]}
      sortOptions={[
        { value: 'name_asc', label: 'Name (A → Z)' },
        { value: 'created_at_desc', label: 'Most recently added' },
      ]}
      defaultConfig={{
        filter: { is_active: true },
        sort: 'name_asc',
        limit: 10,
      }}
      value={value}
      onChange={onChange}
      applySortToQuery={(q, sort) => {
        if (sort === 'name_asc') return q.order('name', { ascending: true });
        if (sort === 'created_at_desc') return q.order('created_at', { ascending: false });
        return q;
      }}
      applyFilterToQuery={(q, filter) => {
        let next = q;
        if (filter.is_active === true) next = next.eq('is_active', true);
        return next;
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// event_speakers — list of speakers across one event or all events
// ---------------------------------------------------------------------------

export function EventSpeakersQueryBuilder({ value, onChange }: WrapperProps) {
  return (
    <SourceQueryBuilder
      sourceSlug="event_speakers"
      tableName="event_speakers"
      nameColumn="full_name"
      secondaryColumn="company"
      filterFields={[
        { name: 'event_id', type: 'string', label: 'Event ID (optional)' },
        { name: 'speaker_role', type: 'enum', label: 'Role', options: [
          { value: 'all', label: 'All roles' },
          { value: 'keynote', label: 'Keynote' },
          { value: 'speaker', label: 'Speaker' },
          { value: 'panelist', label: 'Panelist' },
          { value: 'moderator', label: 'Moderator' },
        ]},
        { name: 'company', type: 'string', label: 'Company' },
      ]}
      sortOptions={[
        { value: 'full_name_asc', label: 'Name (A → Z)' },
        { value: 'event_date_desc', label: 'Most recent event' },
      ]}
      defaultConfig={{
        filter: {},
        sort: 'full_name_asc',
        limit: 10,
      }}
      value={value}
      onChange={onChange}
      applySortToQuery={(q, sort) => {
        if (sort === 'full_name_asc') return q.order('full_name', { ascending: true });
        if (sort === 'event_date_desc') return q.order('event_date', { ascending: false });
        return q;
      }}
      applyFilterToQuery={(q, filter) => {
        let next = q;
        if (filter.event_id) next = next.eq('event_id', filter.event_id);
        if (filter.speaker_role && filter.speaker_role !== 'all') next = next.eq('speaker_role', filter.speaker_role);
        if (filter.company) next = next.ilike('company', `%${String(filter.company)}%`);
        return next;
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// event_sponsors — list of sponsors across one event or all events
// ---------------------------------------------------------------------------

export function EventSponsorsQueryBuilder({ value, onChange }: WrapperProps) {
  return (
    <SourceQueryBuilder
      sourceSlug="event_sponsors"
      tableName="events_sponsor_profiles"
      nameColumn="name"
      secondaryColumn="tier"
      filterFields={[
        { name: 'event_id', type: 'string', label: 'Event ID (optional)' },
        { name: 'tier', type: 'enum', label: 'Tier', options: [
          { value: 'all', label: 'All tiers' },
          { value: 'platinum', label: 'Platinum' },
          { value: 'gold', label: 'Gold' },
          { value: 'silver', label: 'Silver' },
          { value: 'bronze', label: 'Bronze' },
          { value: 'community', label: 'Community' },
        ]},
        { name: 'is_featured', type: 'boolean', label: 'Featured only' },
      ]}
      sortOptions={[
        { value: 'tier_asc', label: 'Tier (Platinum → Bronze)' },
        { value: 'name_asc', label: 'Name (A → Z)' },
        { value: 'sort_order_asc', label: 'Custom order' },
      ]}
      defaultConfig={{
        filter: {},
        sort: 'tier_asc',
        limit: 20,
      }}
      value={value}
      onChange={onChange}
      applySortToQuery={(q, sort) => {
        if (sort === 'tier_asc') return q.order('tier_rank', { ascending: true });
        if (sort === 'name_asc') return q.order('name', { ascending: true });
        if (sort === 'sort_order_asc') return q.order('sort_order', { ascending: true });
        return q;
      }}
      applyFilterToQuery={(q, filter) => {
        let next = q;
        if (filter.event_id) next = next.eq('event_id', filter.event_id);
        if (filter.tier && filter.tier !== 'all') next = next.eq('tier', filter.tier);
        if (filter.is_featured === true) next = next.eq('is_featured', true);
        return next;
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Dispatch — picks the right wrapper for a source slug
// ---------------------------------------------------------------------------

const REGISTRY: Record<string, (props: WrapperProps) => JSX.Element> = {
  blogs: BlogsQueryBuilder,
  lists: ListsQueryBuilder,
  event_speakers: EventSpeakersQueryBuilder,
  event_sponsors: EventSponsorsQueryBuilder,
};

export function dispatchQueryBuilder(sourceSlug: string): ((props: WrapperProps) => JSX.Element) | null {
  return REGISTRY[sourceSlug] ?? null;
}
