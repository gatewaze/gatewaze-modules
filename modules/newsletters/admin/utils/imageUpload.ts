/**
 * Newsletter Image Upload Utilities
 * Handles uploading images to Supabase Storage for newsletter content
 */

import { supabase } from '@/lib/supabase';

export interface NewsletterImageUploadResult {
  success: boolean;
  url?: string;
  path?: string;
  error?: string;
}

export interface NewsletterImageUploadOptions {
  maxSizeInMB?: number;
  allowedTypes?: string[];
}

const DEFAULT_OPTIONS: NewsletterImageUploadOptions = {
  maxSizeInMB: 10,
  allowedTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'],
};

/**
 * Upload an image for newsletter content to Supabase Storage
 */
export async function uploadNewsletterImage(
  file: File,
  options: NewsletterImageUploadOptions = {}
): Promise<NewsletterImageUploadResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  try {
    // Validate file type
    if (!opts.allowedTypes?.includes(file.type)) {
      return {
        success: false,
        error: `File type ${file.type} not allowed. Allowed types: ${opts.allowedTypes?.join(', ')}`,
      };
    }

    // Validate file size
    const maxSizeInBytes = (opts.maxSizeInMB || 10) * 1024 * 1024;
    if (file.size > maxSizeInBytes) {
      return {
        success: false,
        error: `File size too large. Maximum size: ${opts.maxSizeInMB}MB`,
      };
    }

    // Generate unique filename
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const extension = file.name.split('.').pop() || 'jpg';
    const fileName = `newsletter-${timestamp}-${randomStr}.${extension}`;
    const filePath = `newsletters/${fileName}`;

    // Upload file to storage
    const { data, error } = await supabase.storage
      .from('media')
      .upload(filePath, file, {
        upsert: false,
        cacheControl: '31536000', // Cache for 1 year (immutable content)
      });

    if (error) {
      // If bucket doesn't exist, try the blog-images bucket as fallback
      if (error.message.includes('not found') || error.message.includes('does not exist')) {
        console.warn('newsletter-images bucket not found, using blog-images bucket');
        const fallbackPath = `blog-posts/newsletter-${timestamp}-${randomStr}.${extension}`;
        const { data: fallbackData, error: fallbackError } = await supabase.storage
          .from('media')
          .upload(fallbackPath, file, {
            upsert: false,
            cacheControl: '31536000',
          });

        if (fallbackError) {
          return {
            success: false,
            error: fallbackError.message,
          };
        }

        const { data: urlData } = supabase.storage
          .from('media')
          .getPublicUrl(fallbackData.path);

        return {
          success: true,
          url: urlData.publicUrl,
          path: fallbackData.path,
        };
      }

      return {
        success: false,
        error: error.message,
      };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('media')
      .getPublicUrl(data.path);

    return {
      success: true,
      url: urlData.publicUrl,
      path: data.path,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Delete a newsletter image from storage
 */
export async function deleteNewsletterImage(imagePath: string): Promise<NewsletterImageUploadResult> {
  try {
    // Determine which bucket the image is in based on the path
    const bucket = imagePath.startsWith('newsletters/') ? 'media' : 'media';

    const { error } = await supabase.storage
      .from(bucket)
      .remove([imagePath]);

    if (error) {
      return {
        success: false,
        error: error.message,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Extract storage path from a full URL
 */
export function extractNewsletterImagePath(imageUrl: string): string | null {
  try {
    const url = new URL(imageUrl);
    const pathParts = url.pathname.split('/');

    // Look for newsletter-images or blog-images bucket
    let bucketIndex = pathParts.findIndex(part => part === 'media');
    if (bucketIndex === -1) {
      bucketIndex = pathParts.findIndex(part => part === 'media');
    }

    if (bucketIndex !== -1 && bucketIndex < pathParts.length - 1) {
      return pathParts.slice(bucketIndex + 1).join('/');
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Validate an image file before upload
 */
export function validateNewsletterImage(
  file: File,
  options: NewsletterImageUploadOptions = {}
): { valid: boolean; error?: string } {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!opts.allowedTypes?.includes(file.type)) {
    return {
      valid: false,
      error: `File type ${file.type} not allowed. Allowed types: ${opts.allowedTypes?.join(', ')}`,
    };
  }

  const maxSizeInBytes = (opts.maxSizeInMB || 10) * 1024 * 1024;
  if (file.size > maxSizeInBytes) {
    return {
      valid: false,
      error: `File size too large. Maximum size: ${opts.maxSizeInMB}MB`,
    };
  }

  return { valid: true };
}
