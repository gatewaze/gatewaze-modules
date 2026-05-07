/**
 * Host-media types shared between server (api/, lib/) and admin client.
 * Mirrors host_media table columns. The cdn_url field is server-derived
 * (Supabase Storage public URL); not persisted in the table.
 */

export type AccessLevel = 'public' | 'authenticated' | 'signed';

export type YoutubeUploadStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface HostMediaItem {
  id: string;
  host_kind: string;
  host_id: string;
  storage_path: string;
  filename: string;
  mime_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  variants: Record<string, string> | null;
  in_repo: boolean;
  used_in: Array<{ type: string; id: string; name: string }>;
  uploaded_by: string | null;
  access_level: AccessLevel;
  youtube_video_id: string | null;
  youtube_url: string | null;
  youtube_embed_url: string | null;
  youtube_thumbnail_url: string | null;
  youtube_upload_status: YoutubeUploadStatus | null;
  album_id: string | null;
  metadata: Record<string, unknown>;
  caption: string | null;
  alt_text: string | null;
  sponsor_id: string | null;
  is_featured: boolean;
  is_approved: boolean;
  created_at: string;
  updated_at: string;
  cdn_url: string;
}

export interface HostMediaAlbum {
  id: string;
  host_kind: string;
  host_id: string;
  name: string;
  description: string | null;
  cover_media_id: string | null;
  sort_order: number;
  is_default: boolean;
  created_at: string;
}

export interface HostMediaUploadResult {
  filename: string;
  status: 'created' | 'failed';
  media_id?: string;
  cdn_url?: string;
  variants?: Record<string, string>;
  error?: string;
  message?: string;
}

export interface HostMediaListResponse {
  items: HostMediaItem[];
  next_cursor: string | null;
}

/**
 * Allowlist used by PATCH /admin/<hostKind>/:hostId/media/:id and
 * mirrored on the server. Add new fields in lockstep with
 * MEDIA_WRITE_FIELDS in api/routes.ts to keep server + client in sync.
 */
export const MEDIA_PATCH_FIELDS = [
  'caption',
  'alt_text',
  'sponsor_id',
  'album_id',
  'is_featured',
  'access_level',
] as const;

export type MediaPatchField = typeof MEDIA_PATCH_FIELDS[number];

export const ALBUM_WRITE_FIELDS = [
  'name',
  'description',
  'cover_media_id',
  'sort_order',
  'is_default',
] as const;

export type AlbumWriteField = typeof ALBUM_WRITE_FIELDS[number];
