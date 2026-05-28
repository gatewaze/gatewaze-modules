/**
 * Event Content Image Service
 *
 * Downloads images from external sources (lumacdn.com) and uploads them
 * to Supabase Storage so they survive past the upstream CDN.
 *
 * Ported from gatewaze-admin/scripts/lib — adapted to take a `supabase`
 * client argument instead of importing one (modules don't share the
 * legacy `../supabase-client.js`).
 */

const CONTENT_IMAGES_BUCKET = 'event-content-images';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

let bucketEnsured = false;

export async function initializeBucket(supabase) {
  if (bucketEnsured) return { success: true };
  try {
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) return { success: false, error: listError.message };

    const bucketExists = buckets?.some((b) => b.name === CONTENT_IMAGES_BUCKET);
    if (!bucketExists) {
      const { error: createError } = await supabase.storage.createBucket(CONTENT_IMAGES_BUCKET, {
        public: true,
        fileSizeLimit: MAX_FILE_SIZE,
        allowedMimeTypes: ALLOWED_TYPES,
      });
      if (createError) return { success: false, error: createError.message };
      console.log(`✅ Created storage bucket: ${CONTENT_IMAGES_BUCKET}`);
    }
    bucketEnsured = true;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getContentType(response, url) {
  const headerType = response.headers.get('content-type');
  if (headerType && headerType.startsWith('image/')) return headerType.split(';')[0];
  const ext = url.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png':  return 'image/png';
    case 'webp': return 'image/webp';
    case 'gif':  return 'image/gif';
    default:     return 'image/jpeg';
  }
}

function getExtension(contentType) {
  switch (contentType) {
    case 'image/jpeg': return 'jpg';
    case 'image/png':  return 'png';
    case 'image/webp': return 'webp';
    case 'image/gif':  return 'gif';
    default:           return 'jpg';
  }
}

export async function downloadAndUploadImage(supabase, imageUrl, eventId, imageIndex) {
  try {
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if (!response.ok) {
      return { success: false, error: `download ${response.status} ${response.statusText}` };
    }

    const blob = await response.blob();
    if (blob.size > MAX_FILE_SIZE) {
      return { success: false, error: `too large: ${(blob.size / 1024 / 1024).toFixed(2)}MB` };
    }

    const contentType = getContentType(response, imageUrl);
    if (!ALLOWED_TYPES.includes(contentType)) {
      return { success: false, error: `unsupported type: ${contentType}` };
    }

    const extension = getExtension(contentType);
    const timestamp = Date.now();
    const fileName = `content-${imageIndex}-${timestamp}.${extension}`;
    const storagePath = `${eventId}/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from(CONTENT_IMAGES_BUCKET)
      .upload(storagePath, blob, {
        contentType,
        cacheControl: '31536000',
        upsert: false,
      });
    if (uploadError) return { success: false, error: `upload: ${uploadError.message}` };

    const { data: urlData } = supabase.storage.from(CONTENT_IMAGES_BUCKET).getPublicUrl(storagePath);
    return { success: true, publicUrl: urlData.publicUrl, storagePath };
  } catch (error) {
    return { success: false, error: error.message || 'unknown error' };
  }
}

/**
 * Process all images from a ProseMirror document.
 * Returns a Map<originalUrl, publicUrl>; on failure keeps the original URL
 * so the HTML still renders (just from the upstream CDN).
 */
export async function processAllImages(supabase, images, eventId) {
  const urlMap = new Map();
  if (!images || images.length === 0) return urlMap;

  await initializeBucket(supabase);
  console.log(`📷 Processing ${images.length} content images for event ${eventId}`);

  for (const image of images) {
    const result = await downloadAndUploadImage(supabase, image.originalUrl, eventId, image.index);
    if (result.success && result.publicUrl) {
      urlMap.set(image.originalUrl, result.publicUrl);
    } else {
      console.warn(`  ⚠️ image ${image.index} skipped: ${result.error}`);
      urlMap.set(image.originalUrl, image.originalUrl);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return urlMap;
}

export async function deleteEventImages(supabase, eventId) {
  try {
    const { data: files, error: listError } = await supabase.storage
      .from(CONTENT_IMAGES_BUCKET).list(eventId);
    if (listError) return { success: false, error: listError.message };
    if (!files || files.length === 0) return { success: true };
    const paths = files.map((f) => `${eventId}/${f.name}`);
    const { error: delError } = await supabase.storage.from(CONTENT_IMAGES_BUCKET).remove(paths);
    if (delError) return { success: false, error: delError.message };
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export default { initializeBucket, downloadAndUploadImage, processAllImages, deleteEventImages };
