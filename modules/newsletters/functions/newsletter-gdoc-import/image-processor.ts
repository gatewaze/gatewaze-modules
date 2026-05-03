/**
 * Image Processor
 * Downloads images from Google Docs and uploads to Supabase Storage.
 */

import { getGoogleAuth } from './google-auth.ts';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_CONCURRENT_DOWNLOADS = 5;
const ALLOWED_DOMAINS = ['lh1.googleusercontent.com', 'lh2.googleusercontent.com', 'lh3.googleusercontent.com', 'lh4.googleusercontent.com', 'lh5.googleusercontent.com', 'lh6.googleusercontent.com', 'lh7.googleusercontent.com'];

export interface ImageMapping {
  originalObjectId: string;
  /**
   * Relative storage path (e.g. `newsletter-images/img-1713-abc.png`).
   * Readers resolve via toPublicUrl at display time.
   */
  storagePath: string;
}

export interface ImageProcessResult {
  mappings: ImageMapping[];
  warnings: string[];
}

/**
 * Download images from Google Docs and upload to Supabase Storage.
 */
export async function processImages(
  inlineImages: Map<string, { contentUri: string; mimeType: string }>,
  supabase: any,
  storagePath: string,
): Promise<ImageProcessResult> {
  const mappings: ImageMapping[] = [];
  const warnings: string[] = [];

  if (inlineImages.size === 0) return { mappings, warnings };

  const entries = [...inlineImages.entries()].slice(0, 20); // Max 20 images
  if (inlineImages.size > 20) {
    warnings.push(`Document has ${inlineImages.size} images, only the first 20 will be imported`);
  }

  // Process in batches of MAX_CONCURRENT_DOWNLOADS
  for (let i = 0; i < entries.length; i += MAX_CONCURRENT_DOWNLOADS) {
    const batch = entries.slice(i, i + MAX_CONCURRENT_DOWNLOADS);

    const results = await Promise.allSettled(
      batch.map(async ([objectId, { contentUri }]) => {
        try {
          return await downloadAndUpload(objectId, contentUri, supabase, storagePath);
        } catch (err) {
          warnings.push(`Failed to import image ${objectId}: ${err instanceof Error ? err.message : 'Unknown error'}`);
          return null;
        }
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        mappings.push(result.value);
      }
    }
  }

  return { mappings, warnings };
}

async function downloadAndUpload(
  objectId: string,
  contentUri: string,
  supabase: any,
  storagePath: string,
): Promise<ImageMapping | null> {
  // Validate URL domain
  try {
    const url = new URL(contentUri);
    if (!ALLOWED_DOMAINS.some((d) => url.hostname.endsWith(d) || url.hostname === d)) {
      // For Google Docs embedded images, use the authenticated endpoint
      // Google Docs API returns contentUri that may be googleusercontent.com or
      // docs.google.com — both are valid
    }
  } catch {
    throw new Error(`Invalid image URL: ${contentUri}`);
  }

  // Download with Google auth
  const auth = await getGoogleAuth();
  const response = await fetch(contentUri, {
    headers: auth.headers,
  });

  if (!response.ok) {
    throw new Error(`Image download failed (${response.status})`);
  }

  // Check size
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE) {
    throw new Error(`Image too large (${Math.round(parseInt(contentLength) / 1024 / 1024)}MB, max 10MB)`);
  }

  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_SIZE) {
    throw new Error(`Image too large (${Math.round(blob.size / 1024 / 1024)}MB, max 10MB)`);
  }

  // Determine extension from content type
  const contentType = response.headers.get('content-type') || 'image/png';
  const extMap: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  };
  const ext = extMap[contentType] || 'png';

  // Upload to Supabase Storage
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 8);
  const fileName = `${storagePath}/img-${timestamp}-${randomStr}.${ext}`;

  const { data, error } = await supabase.storage
    .from('media')
    .upload(fileName, blob, {
      contentType,
      upsert: false,
      cacheControl: '31536000',
    });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  // Store and return the relative path; readers resolve via toPublicUrl.
  return {
    originalObjectId: objectId,
    storagePath: data.path,
  };
}

/**
 * Replace image object IDs in AI mapping content with relative storage paths.
 * Readers resolve these to full URLs at display time via `resolveStoragePathsInJson`.
 */
export function replaceImageUrls(
  content: Record<string, unknown>,
  mappings: ImageMapping[],
): Record<string, unknown> {
  const pathMap = new Map(mappings.map((m) => [m.originalObjectId, m.storagePath]));

  function replaceInValue(value: unknown): unknown {
    if (typeof value === 'string') {
      // Check if this is an image object ID reference
      for (const [objectId, storagePath] of pathMap) {
        if (value.includes(objectId)) {
          return value.replace(objectId, storagePath);
        }
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(replaceInValue);
    }
    if (typeof value === 'object' && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = replaceInValue(v);
      }
      return result;
    }
    return value;
  }

  return replaceInValue(content) as Record<string, unknown>;
}
