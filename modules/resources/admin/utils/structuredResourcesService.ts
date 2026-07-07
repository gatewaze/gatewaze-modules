import { supabase } from '@/lib/supabase';

// ============================================================
// TypeScript interfaces
// ============================================================

export interface SrCollection {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  cover_image_url: string | null;
  status: 'draft' | 'published' | 'archived';
  access: 'public' | 'authenticated' | 'inherit' | 'metered';
  meta_title: string | null;
  meta_description: string | null;
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  category_count?: number;
  item_count?: number;
}

export interface SrSectionTemplate {
  id: string;
  collection_id: string;
  heading: string;
  description: string | null;
  is_required: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface SrCategory {
  id: string;
  collection_id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  item_count?: number;
}

export interface SrItem {
  id: string;
  collection_id: string;
  category_id: string;
  title: string;
  slug: string;
  subtitle: string | null;
  external_url: string | null;
  featured_image_url: string | null;
  status: 'draft' | 'published' | 'archived';
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  category?: SrCategory;
  sections?: SrSection[];
}

export interface SrSection {
  id: string;
  item_id: string;
  template_id: string | null;
  heading: string;
  content: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ServiceResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================================
// Utilities
// ============================================================

export class SrUtils {
  static generateSlug(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  static async ensureUniqueSlug(
    baseSlug: string,
    table: 'sr_collections' | 'sr_categories' | 'sr_items',
    scopeField?: string,
    scopeValue?: string,
    excludeId?: string
  ): Promise<string> {
    let slug = baseSlug;
    let counter = 1;

    while (true) {
      let query = supabase.from(table).select('id').eq('slug', slug);
      if (scopeField && scopeValue) {
        query = query.eq(scopeField, scopeValue);
      }
      if (excludeId) {
        query = query.neq('id', excludeId);
      }

      const { data, error } = await query;
      if (error) throw error;
      if (!data || data.length === 0) return slug;

      slug = `${baseSlug}-${counter}`;
      counter++;
    }
  }
}

// ============================================================
// Collections Service
// ============================================================

export class CollectionsService {
  static async getAll(): Promise<ServiceResponse<SrCollection[]>> {
    try {
      const { data, error } = await supabase
        .from('sr_collections')
        .select('*')
        .order('sort_order', { ascending: true });

      if (error) throw error;
      return { success: true, data: data || [] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async getById(id: string): Promise<ServiceResponse<SrCollection>> {
    try {
      const { data, error } = await supabase
        .from('sr_collections')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async create(collection: Partial<SrCollection>): Promise<ServiceResponse<SrCollection>> {
    try {
      const slug = collection.slug || SrUtils.generateSlug(collection.name || '');
      const uniqueSlug = await SrUtils.ensureUniqueSlug(slug, 'sr_collections');

      const { data, error } = await supabase
        .from('sr_collections')
        .insert({ ...collection, slug: uniqueSlug })
        .select()
        .single();

      if (error) throw error;
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async update(id: string, updates: Partial<SrCollection>): Promise<ServiceResponse<SrCollection>> {
    try {
      if (updates.name && !updates.slug) {
        updates.slug = await SrUtils.ensureUniqueSlug(
          SrUtils.generateSlug(updates.name),
          'sr_collections',
          undefined,
          undefined,
          id
        );
      }

      const { data, error } = await supabase
        .from('sr_collections')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async delete(id: string): Promise<ServiceResponse<void>> {
    try {
      const { error } = await supabase
        .from('sr_collections')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================
// Section Templates Service
// ============================================================

export class SectionTemplatesService {
  static async getByCollection(collectionId: string): Promise<ServiceResponse<SrSectionTemplate[]>> {
    try {
      const { data, error } = await supabase
        .from('sr_section_templates')
        .select('*')
        .eq('collection_id', collectionId)
        .order('sort_order', { ascending: true });

      if (error) throw error;
      return { success: true, data: data || [] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async create(template: Partial<SrSectionTemplate>): Promise<ServiceResponse<SrSectionTemplate>> {
    try {
      const { data, error } = await supabase
        .from('sr_section_templates')
        .insert(template)
        .select()
        .single();

      if (error) throw error;
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async update(id: string, updates: Partial<SrSectionTemplate>): Promise<ServiceResponse<SrSectionTemplate>> {
    try {
      const { data, error } = await supabase
        .from('sr_section_templates')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async delete(id: string): Promise<ServiceResponse<void>> {
    try {
      const { error } = await supabase
        .from('sr_section_templates')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async reorder(templates: { id: string; sort_order: number }[]): Promise<ServiceResponse<void>> {
    try {
      for (const t of templates) {
        const { error } = await supabase
          .from('sr_section_templates')
          .update({ sort_order: t.sort_order })
          .eq('id', t.id);
        if (error) throw error;
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================
// Categories Service
// ============================================================

export class CategoriesService {
  static async getByCollection(collectionId: string): Promise<ServiceResponse<SrCategory[]>> {
    try {
      const { data, error } = await supabase
        .from('sr_categories')
        .select('*')
        .eq('collection_id', collectionId)
        .order('sort_order', { ascending: true });

      if (error) throw error;
      return { success: true, data: data || [] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async create(category: Partial<SrCategory>): Promise<ServiceResponse<SrCategory>> {
    try {
      const slug = category.slug || SrUtils.generateSlug(category.name || '');
      const uniqueSlug = await SrUtils.ensureUniqueSlug(
        slug, 'sr_categories', 'collection_id', category.collection_id
      );

      const { data, error } = await supabase
        .from('sr_categories')
        .insert({ ...category, slug: uniqueSlug })
        .select()
        .single();

      if (error) throw error;
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async update(id: string, updates: Partial<SrCategory>): Promise<ServiceResponse<SrCategory>> {
    try {
      const { data, error } = await supabase
        .from('sr_categories')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async delete(id: string): Promise<ServiceResponse<void>> {
    try {
      const { error } = await supabase
        .from('sr_categories')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async reorder(categories: { id: string; sort_order: number }[]): Promise<ServiceResponse<void>> {
    try {
      for (const c of categories) {
        const { error } = await supabase
          .from('sr_categories')
          .update({ sort_order: c.sort_order })
          .eq('id', c.id);
        if (error) throw error;
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================
// Items Service
// ============================================================

export class ItemsService {
  static async getByCollection(
    collectionId: string,
    filters?: { category_id?: string; status?: string; search?: string }
  ): Promise<ServiceResponse<SrItem[]>> {
    try {
      let query = supabase
        .from('sr_items')
        .select('*, category:sr_categories(id, name, slug)')
        .eq('collection_id', collectionId)
        .order('sort_order', { ascending: true });

      if (filters?.category_id) query = query.eq('category_id', filters.category_id);
      if (filters?.status) query = query.eq('status', filters.status);

      const { data, error } = await query;
      if (error) throw error;

      let items = (data || []).map((row: any) => ({
        ...row,
        category: Array.isArray(row.category) ? row.category[0] ?? null : row.category,
      }));

      if (filters?.search) {
        const term = filters.search.toLowerCase();
        items = items.filter((i: any) =>
          i.title.toLowerCase().includes(term) ||
          i.subtitle?.toLowerCase().includes(term)
        );
      }

      return { success: true, data: items };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async getById(id: string): Promise<ServiceResponse<SrItem>> {
    try {
      const { data, error } = await supabase
        .from('sr_items')
        .select('*, category:sr_categories(id, name, slug), sections:sr_sections(*)')
        .eq('id', id)
        .single();

      if (error) throw error;

      const item = {
        ...data,
        category: Array.isArray(data.category) ? data.category[0] ?? null : data.category,
        sections: (data.sections || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
      };

      return { success: true, data: item };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async create(
    item: Partial<SrItem>,
    sections?: { heading: string; content: string | null; template_id: string | null; sort_order: number }[]
  ): Promise<ServiceResponse<SrItem>> {
    try {
      const slug = item.slug || SrUtils.generateSlug(item.title || '');
      const uniqueSlug = await SrUtils.ensureUniqueSlug(
        slug, 'sr_items', 'collection_id', item.collection_id
      );

      const { data: createdItem, error: itemError } = await supabase
        .from('sr_items')
        .insert({ ...item, slug: uniqueSlug })
        .select()
        .single();

      if (itemError) throw itemError;

      if (sections && sections.length > 0) {
        const sectionRows = sections.map(s => ({
          item_id: createdItem.id,
          heading: s.heading,
          content: s.content,
          template_id: s.template_id,
          sort_order: s.sort_order,
        }));

        const { error: secError } = await supabase
          .from('sr_sections')
          .insert(sectionRows);

        if (secError) throw secError;
      }

      return { success: true, data: createdItem };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async update(id: string, updates: Partial<SrItem>): Promise<ServiceResponse<SrItem>> {
    try {
      if (updates.title && !updates.slug) {
        const current = await supabase.from('sr_items').select('collection_id').eq('id', id).single();
        if (current.data) {
          updates.slug = await SrUtils.ensureUniqueSlug(
            SrUtils.generateSlug(updates.title),
            'sr_items',
            'collection_id',
            current.data.collection_id,
            id
          );
        }
      }

      const { data, error } = await supabase
        .from('sr_items')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async delete(id: string): Promise<ServiceResponse<void>> {
    try {
      const { error } = await supabase
        .from('sr_items')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================
// Sections Service
// ============================================================

export class SectionsService {
  static async getByItem(itemId: string): Promise<ServiceResponse<SrSection[]>> {
    try {
      const { data, error } = await supabase
        .from('sr_sections')
        .select('*')
        .eq('item_id', itemId)
        .order('sort_order', { ascending: true });

      if (error) throw error;
      return { success: true, data: data || [] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async upsertForItem(
    itemId: string,
    sections: { id?: string; heading: string; content: string | null; template_id: string | null; sort_order: number }[]
  ): Promise<ServiceResponse<void>> {
    try {
      // Delete existing sections not in the update list
      const existingIds = sections.filter(s => s.id).map(s => s.id!);
      if (existingIds.length > 0) {
        const { error: delError } = await supabase
          .from('sr_sections')
          .delete()
          .eq('item_id', itemId)
          .not('id', 'in', `(${existingIds.join(',')})`);
        if (delError) throw delError;
      } else {
        // Delete all existing sections
        const { error: delError } = await supabase
          .from('sr_sections')
          .delete()
          .eq('item_id', itemId);
        if (delError) throw delError;
      }

      // Upsert sections
      for (const s of sections) {
        if (s.id) {
          const { error } = await supabase
            .from('sr_sections')
            .update({ heading: s.heading, content: s.content, template_id: s.template_id, sort_order: s.sort_order })
            .eq('id', s.id);
          if (error) throw error;
        } else {
          const { error } = await supabase
            .from('sr_sections')
            .insert({ item_id: itemId, heading: s.heading, content: s.content, template_id: s.template_id, sort_order: s.sort_order });
          if (error) throw error;
        }
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================
// Markdown Import Parser
// ============================================================

export interface ParsedImport {
  title: string;
  categories: {
    name: string;
    items: {
      title: string;
      external_url: string | null;
      sections: { heading: string; content: string }[];
    }[];
  }[];
}

export class MarkdownImporter {
  static parse(markdown: string): ParsedImport {
    const lines = markdown.split('\n');
    const result: ParsedImport = { title: '', categories: [] };

    let currentCategory: ParsedImport['categories'][0] | null = null;
    let currentItem: ParsedImport['categories'][0]['items'][0] | null = null;
    let currentSection: { heading: string; content: string } | null = null;
    let contentBuffer: string[] = [];

    const flushContent = () => {
      if (currentSection && contentBuffer.length > 0) {
        currentSection.content = contentBuffer.join('\n').trim();
        contentBuffer = [];
      }
    };

    for (const line of lines) {
      // H1 - Collection title
      if (line.startsWith('# ') && !line.startsWith('## ')) {
        result.title = line.replace(/^#\s+/, '').trim();
        continue;
      }

      // H2 - Category
      if (line.startsWith('## ')) {
        flushContent();
        if (currentSection && currentItem) {
          currentItem.sections.push(currentSection);
          currentSection = null;
        }
        if (currentItem && currentCategory) {
          currentCategory.items.push(currentItem);
          currentItem = null;
        }

        currentCategory = { name: line.replace(/^##\s+/, '').trim(), items: [] };
        result.categories.push(currentCategory);
        continue;
      }

      // H3 - Item
      if (line.startsWith('### ')) {
        flushContent();
        if (currentSection && currentItem) {
          currentItem.sections.push(currentSection);
          currentSection = null;
        }
        if (currentItem && currentCategory) {
          currentCategory.items.push(currentItem);
        }

        currentItem = {
          title: line.replace(/^###\s+/, '').trim(),
          external_url: null,
          sections: [],
        };
        continue;
      }

      // H4 or **Bold** - Section heading
      const h4Match = line.match(/^####\s+(.+)/);
      const boldMatch = line.match(/^\*\*(.+)\*\*\s*$/);
      if (h4Match || boldMatch) {
        flushContent();
        if (currentSection && currentItem) {
          currentItem.sections.push(currentSection);
        }

        currentSection = {
          heading: (h4Match ? h4Match[1] : boldMatch![1]).trim(),
          content: '',
        };
        continue;
      }

      // Extract URL from link syntax
      if (currentItem && !currentItem.external_url) {
        const urlMatch = line.match(/\[([^\]]*)\]\((https?:\/\/[^\)]+)\)/);
        if (urlMatch) {
          currentItem.external_url = urlMatch[2];
        }
      }

      // Skip horizontal rules
      if (line.match(/^---+\s*$/)) continue;

      // Accumulate content
      if (currentSection) {
        contentBuffer.push(line);
      }
    }

    // Flush remaining
    flushContent();
    if (currentSection && currentItem) {
      currentItem.sections.push(currentSection);
    }
    if (currentItem && currentCategory) {
      currentCategory.items.push(currentItem);
    }

    return result;
  }

  static async importToCollection(
    collectionId: string,
    parsed: ParsedImport,
    templateMap: Map<string, string>
  ): Promise<ServiceResponse<{ categories: number; items: number; sections: number }>> {
    try {
      let categoryCount = 0;
      let itemCount = 0;
      let sectionCount = 0;

      for (const cat of parsed.categories) {
        const catResult = await CategoriesService.create({
          collection_id: collectionId,
          name: cat.name,
          sort_order: categoryCount,
        });

        if (!catResult.success || !catResult.data) {
          throw new Error(`Failed to create category "${cat.name}": ${catResult.error}`);
        }
        categoryCount++;

        for (let i = 0; i < cat.items.length; i++) {
          const item = cat.items[i];
          const sections = item.sections.map((s, idx) => ({
            heading: s.heading,
            content: s.content,
            template_id: templateMap.get(s.heading) || null,
            sort_order: idx,
          }));

          const itemResult = await ItemsService.create(
            {
              collection_id: collectionId,
              category_id: catResult.data.id,
              title: item.title,
              external_url: item.external_url,
              status: 'draft' as const,
              sort_order: i,
            },
            sections
          );

          if (!itemResult.success) {
            throw new Error(`Failed to create item "${item.title}": ${itemResult.error}`);
          }

          itemCount++;
          sectionCount += sections.length;
        }
      }

      return { success: true, data: { categories: categoryCount, items: itemCount, sections: sectionCount } };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}
