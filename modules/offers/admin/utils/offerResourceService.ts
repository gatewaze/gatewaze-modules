import { supabase } from '@/lib/supabase';

export interface OfferResource {
  id: string;
  offer_id: string;
  file_id: string;
  name: string;
  description: string | null;
  storage_path: string;
  download_filename: string;
  mime_type: string;
  file_size_bytes: number | null;
  download_count: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateOfferResourceInput {
  offer_id: string;
  file_id: string;
  name: string;
  description?: string;
  storage_path: string;
  download_filename: string;
  mime_type?: string;
  file_size_bytes?: number;
}

export interface UpdateOfferResourceInput {
  name?: string;
  description?: string;
  download_filename?: string;
  is_active?: boolean;
}

const DOWNLOADS_BUCKET = 'downloads';

export class OfferResourceService {
  /**
   * Get all resources for an offer
   */
  static async getResourcesForOffer(offerId: string): Promise<OfferResource[]> {
    const { data, error } = await supabase
      .from('integrations_offer_resources')
      .select('*')
      .eq('offer_id', offerId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching offer resources:', error);
      throw error;
    }

    return data || [];
  }

  /**
   * Get a single resource by ID
   */
  static async getResource(resourceId: string): Promise<OfferResource | null> {
    const { data, error } = await supabase
      .from('integrations_offer_resources')
      .select('*')
      .eq('id', resourceId)
      .maybeSingle();

    if (error) {
      console.error('Error fetching resource:', error);
      throw error;
    }

    return data;
  }

  /**
   * Create a new resource (metadata only - file should already be uploaded)
   */
  static async createResource(input: CreateOfferResourceInput): Promise<OfferResource> {
    const { data, error } = await supabase
      .from('integrations_offer_resources')
      .insert({
        offer_id: input.offer_id,
        file_id: input.file_id,
        name: input.name,
        description: input.description || null,
        storage_path: input.storage_path,
        download_filename: input.download_filename,
        mime_type: input.mime_type || 'application/pdf',
        file_size_bytes: input.file_size_bytes || null,
        is_active: true,
        download_count: 0,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating resource:', error);
      throw error;
    }

    return data;
  }

  /**
   * Update a resource
   */
  static async updateResource(resourceId: string, input: UpdateOfferResourceInput): Promise<OfferResource> {
    const { data, error } = await supabase
      .from('integrations_offer_resources')
      .update(input)
      .eq('id', resourceId)
      .select()
      .single();

    if (error) {
      console.error('Error updating resource:', error);
      throw error;
    }

    return data;
  }

  /**
   * Delete a resource (and optionally the file from storage)
   */
  static async deleteResource(resourceId: string, deleteFile: boolean = false): Promise<void> {
    // Get the resource first to get the storage path
    const resource = await this.getResource(resourceId);
    if (!resource) {
      throw new Error('Resource not found');
    }

    // Delete the file from storage if requested
    if (deleteFile && resource.storage_path) {
      const { error: storageError } = await supabase.storage
        .from(DOWNLOADS_BUCKET)
        .remove([resource.storage_path]);

      if (storageError) {
        console.warn('Error deleting file from storage:', storageError);
        // Continue with deleting the record even if file deletion fails
      }
    }

    // Delete the resource record
    const { error } = await supabase
      .from('integrations_offer_resources')
      .delete()
      .eq('id', resourceId);

    if (error) {
      console.error('Error deleting resource:', error);
      throw error;
    }
  }

  /**
   * Upload a file to storage and create a resource record
   */
  static async uploadAndCreateResource(
    offerId: string,
    file: File,
    name: string,
    description?: string
  ): Promise<OfferResource> {
    // Generate a safe file path
    const fileExtension = file.name.split('.').pop() || 'pdf';
    const safeOfferId = offerId.replace(/[^a-z0-9-]/gi, '_');
    const timestamp = Date.now();
    const safeFileName = file.name.replace(/[^a-z0-9.-]/gi, '_');
    const storagePath = `${safeOfferId}/${timestamp}_${safeFileName}`;

    // Upload file to storage
    const { error: uploadError } = await supabase.storage
      .from(DOWNLOADS_BUCKET)
      .upload(storagePath, file, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      console.error('Error uploading file:', uploadError);
      throw uploadError;
    }

    // Generate a unique file_id
    const fileId = `${safeOfferId}-${timestamp}`;

    // Create the resource record
    try {
      return await this.createResource({
        offer_id: offerId,
        file_id: fileId,
        name: name,
        description: description,
        storage_path: storagePath,
        download_filename: file.name,
        mime_type: file.type || 'application/octet-stream',
        file_size_bytes: file.size,
      });
    } catch (error) {
      // If resource creation fails, try to delete the uploaded file
      await supabase.storage.from(DOWNLOADS_BUCKET).remove([storagePath]);
      throw error;
    }
  }

  /**
   * Get download statistics for a resource
   */
  static async getDownloadStats(resourceId: string): Promise<{
    totalDownloads: number;
    uniqueEmails: number;
    recentDownloads: Array<{ email: string; downloaded_at: string }>;
  }> {
    // Get total download count
    const { count: totalDownloads, error: countError } = await supabase
      .from('download_logs')
      .select('*', { count: 'exact', head: true })
      .eq('resource_id', resourceId);

    if (countError) {
      console.error('Error getting download count:', countError);
    }

    // Get unique email count
    const { data: uniqueEmailsData, error: uniqueError } = await supabase
      .from('download_logs')
      .select('email')
      .eq('resource_id', resourceId);

    if (uniqueError) {
      console.error('Error getting unique emails:', uniqueError);
    }

    const uniqueEmails = new Set(uniqueEmailsData?.map(d => d.email.toLowerCase()) || []).size;

    // Get recent downloads
    const { data: recentDownloads, error: recentError } = await supabase
      .from('download_logs')
      .select('email, downloaded_at')
      .eq('resource_id', resourceId)
      .order('downloaded_at', { ascending: false })
      .limit(10);

    if (recentError) {
      console.error('Error getting recent downloads:', recentError);
    }

    return {
      totalDownloads: totalDownloads || 0,
      uniqueEmails,
      recentDownloads: recentDownloads || [],
    };
  }

  /**
   * Get download stats for all resources of an offer
   */
  static async getOfferDownloadStats(offerId: string): Promise<Map<string, number>> {
    const { data, error } = await supabase
      .from('download_logs')
      .select('file_id')
      .eq('offer_id', offerId);

    if (error) {
      console.error('Error getting offer download stats:', error);
      return new Map();
    }

    const counts = new Map<string, number>();
    data?.forEach(d => {
      const current = counts.get(d.file_id) || 0;
      counts.set(d.file_id, current + 1);
    });

    return counts;
  }

  /**
   * Toggle resource active status
   */
  static async toggleActive(resourceId: string): Promise<OfferResource> {
    const resource = await this.getResource(resourceId);
    if (!resource) {
      throw new Error('Resource not found');
    }

    return this.updateResource(resourceId, { is_active: !resource.is_active });
  }

  /**
   * Format file size for display
   */
  static formatFileSize(bytes: number | null): string {
    if (bytes === null || bytes === undefined) return 'Unknown';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
